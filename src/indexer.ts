import { processor } from './processor.js'
import { Database } from './db/database.js'
import { AssetRegistryTracker } from './registry/tracker.js'
import { PoolCompositionCache } from './pool/compositionCache.js'
import { resolvePrices } from './price/graph.js'
import { config } from './config.js'
import { validateBlockRange } from './blockRange.js'
import type { XYKPool } from './price/types.ts'
import type { Block } from './types/support.ts'
import * as storage from './types/storage.ts'
import { hasAssetRegistryMetadataEvent } from './registry/events.js'
import { isSwapEvent } from './registry/swapEvents.js'
import { extractTradeVolumeFromSwaps, extractVolumeFromSwaps, mergePriceAndVolumeRows } from './blocks/extractVolume.js'
import {
  ClickHouseSnapshotReader,
  diffAssetRows,
  type HistoricalSnapshotEntry,
  type HistoricalSnapshotState,
} from './history/clickhouseSnapshotReader.js'
import {
  loadNativeAssetInfo,
  nativeAssetInfoToMetadata,
  nativeAssetInfoToRow,
} from './nativeAsset.js'
import { toClickHouseBlockTime } from './db/timestamp.js'
import { fetchChainHead } from './rpc/head.js'
import { detectPoolAffectingSetStorage } from './raw/snapshot.js'
import { createSnapshotRpcClient, loadRuntimeAt } from './scripts/snapshotRuntime.js'
import { extractRuntimeErrorNames } from './raw/runtimeErrorNames.js'
import type { RpcClient } from '@subsquid/rpc-client'
import type { ClickHouseStore } from './store/clickhouseStore.js'

// Chain time between asset-registry scans while backfilling: the 10,000-block
// interval this replaces was 1,000 minutes at the 6 s era's cadence, and that is
// the parity this constant preserves from here on — backfill reads the interval
// off the historical blocks' own timestamps, so future cadences change nothing.
// Over the ~12-15 s years (2022 through Q2 2025) it scans ~2-2.5× as often as
// the old block-count interval did there: more scans, never fewer, accepted as
// a bounded cost of one cadence-independent constant.
const BACKFILL_ASSET_SNAPSHOT_INTERVAL_MINUTES = 1_000

let errorNamesRpc: RpcClient | null = null
// Snapshot a spec version's pallet error names into runtime_error_names. Loads
// metadata over RPC only at baseline + each runtime upgrade (rare), never per
// block. Non-fatal: a fetch failure is logged and left to the next restart /
// the one-time backfill — it must never stall indexing.
async function snapshotRuntimeErrorNames(store: ClickHouseStore, hash: string, specVersion: number): Promise<void> {
  try {
    errorNamesRpc ??= createSnapshotRpcClient()
    const runtime = await loadRuntimeAt(errorNamesRpc, hash)
    const rows = extractRuntimeErrorNames(runtime.metadata, specVersion)
    if (rows.length) store.addRuntimeErrorNames(rows)
  } catch (error) {
    console.error(`[Runtime] error-name snapshot failed at ${hash} (spec_version ${specVersion}):`, error)
  }
}

export interface RunOptions {
  fromBlock?: number
  toBlock?: number
  pipelineId?: string
  requireFinalizedRaw?: boolean
}

function getHistoricalSnapshotEntry(
  result: IteratorResult<HistoricalSnapshotEntry, void> | null,
): HistoricalSnapshotEntry | null {
  if (result == null || result.done === true) {
    return null
  }

  return result.value
}

/**
 * Read XYK pool states from chain storage using cached pool entries
 *
 * XYK pools are indexed by their sovereign account (AccountId32).
 * We use cached pool entries (account -> asset pair) and read only Tokens.Accounts
 * for the pool's token reserves.
 */
async function readXYKState(
  block: Block,
  pools: Array<{ poolAccount: string; assetA: number; assetB: number }>
): Promise<XYKPool[]> {
  const xykPools: XYKPool[] = []

  if (!storage.tokens.accounts.v108.is(block)) {
    throw new Error(`Unsupported Tokens.Accounts storage for XYK pools at block ${block.height}`)
  }

  try {
    // Batch-read all pool balances in one call (2 keys per pool)
    const keys: [string, number][] = []
    for (const { poolAccount, assetA, assetB } of pools) {
      keys.push([poolAccount, assetA])
      keys.push([poolAccount, assetB])
    }

    const balances = await storage.tokens.accounts.v108.getMany(block, keys)

    // Process results in pairs (index i*2 and i*2+1 for pool i)
    for (let i = 0; i < pools.length; i++) {
      const { assetA, assetB } = pools[i]
      const balanceA = balances[i * 2]
      const balanceB = balances[i * 2 + 1]

      if (balanceA && balanceB) {
        xykPools.push({
          assetA,
          assetB,
          reserveA: balanceA.free,
          reserveB: balanceB.free,
        })
      }
    }
  } catch (error) {
    throw new Error(`Failed to read XYK state at block ${block.height}`, { cause: error })
  }

  return xykPools
}

export async function run(options: RunOptions = {}): Promise<void> {
  validateBlockRange(options)
  const pipelineId = options.pipelineId ?? process.env.INDEXER_PIPELINE_ID ?? 'main'
  const requireFinalizedRaw = options.requireFinalizedRaw ?? process.env.MAIN_REQUIRE_FINALIZED_RAW !== 'false'
  const deferHistoricalPublication = options.toBlock != null && requireFinalizedRaw
  const database = new Database(pipelineId, {
    deferPublication: deferHistoricalPublication,
    publishAtBlock: options.toBlock,
    startAtGenesis: options.fromBlock === 0,
  })
  const nativeAssetInfo = await loadNativeAssetInfo()
  if (nativeAssetInfo) {
    console.log(
      `[NativeAsset] Loaded ${nativeAssetInfo.symbol} from chain properties ` +
      `(asset_id=${nativeAssetInfo.assetId}, decimals=${nativeAssetInfo.decimals})`,
    )
  }
  const nativeAssetMetadata = nativeAssetInfo ? nativeAssetInfoToMetadata(nativeAssetInfo) : undefined
  const nativeAssetRow = nativeAssetInfo ? nativeAssetInfoToRow(nativeAssetInfo) : undefined
  const snapshotReader = new ClickHouseSnapshotReader({
    nativeAssetRow,
    finalizedOnly: requireFinalizedRaw,
  })

  const { height: lastProcessedBlock } = await database.connect()

  let startBlock = options.fromBlock
  if (startBlock === undefined) {
    // Resume from last checkpoint
    startBlock = lastProcessedBlock
    if (startBlock > 0) {
      console.log(`[Main] Resuming ${pipelineId} from checkpoint: block ${startBlock}`)
    } else if (options.toBlock == null) {
      // Fresh, unbounded run (the live follower): default to chain head and go
      // forward; backfill fills history downward. Avoids re-indexing from genesis
      // on a clean database. Falls back to 0 if the head can't be resolved.
      const head = await fetchChainHead(config.RPC_URL)
      if (head != null) {
        startBlock = head
        console.log(`[Main] Fresh ${pipelineId}: starting live at chain head ${head} (backfill fills history downward)`)
      } else {
        console.warn(`[Main] Fresh ${pipelineId}: could not resolve chain head from ${config.RPC_URL}; starting from block 0`)
      }
    }
  } else {
    console.log(`[Main] Starting ${pipelineId} from block ${startBlock} (--from-block override)`)
  }

  if (requireFinalizedRaw) {
    console.log('[Main] Historical raw snapshot reads require finalized raw ranges')
  }
  if (deferHistoricalPublication) {
    console.log('[Main] Deferring historical publication until the bounded range completes')
  }

  // Override processor's block range
  processor.setBlockRange({
    from: startBlock,
    to: options.toBlock,
  })

  const registry = new AssetRegistryTracker(BACKFILL_ASSET_SNAPSHOT_INTERVAL_MINUTES, nativeAssetMetadata, {
    includeUnresolvedAssets: false,
  })
  let historicalRegistryInitialized = false
  const compositionCache = new PoolCompositionCache()
  let previousHistoricalSnapshot: HistoricalSnapshotState | null = null

  let lastLogBlock = startBlock
  const archiveLogInterval = 1000
  const liveLogInterval = 1
  let currentLogInterval = archiveLogInterval
  let isLiveMode = false

  // State tracking for parent hash validation and runtime upgrades
  let previousBlockHash: string | null = null
  let previousBlockHeight: number | null = null
  let previousSpecVersion: number | null = null

    // Previous prices for carry-forward optimization
  let previousPrices: Map<number, string> | null = null
  let lastUnpricedKey = ''
  // Tracking for skip rate logging
  let blocksSkipped = 0
  let blocksProcessed = 0
  let swapEventsProcessed = 0

  await processor.run(database, async (ctx) => {
    // Preserve continuity across sequential batches. A retry/backward replay
    // resets the boundary state; a forward gap is an integrity failure. Every
    // block inside the batch is checked below as well.
    const firstHeight = ctx.blocks[0]?.header.height
    if (firstHeight != null && previousBlockHeight != null) {
      if (firstHeight <= previousBlockHeight) {
        previousBlockHash = null
        previousBlockHeight = null
      } else if (firstHeight > previousBlockHeight + 1) {
        throw new Error(`[Integrity] Processor gap between blocks ${previousBlockHeight} and ${firstHeight}`)
      }
    }

    // Detect live mode from the processor context. Small bounded historical ranges
    // must still use finalized raw snapshots and must not be treated as live.
    if (!isLiveMode && ctx.isHead && options.toBlock == null) {
      console.log('[Progress] Caught up to chain tip, switching to live mode (volumes now active)')
      isLiveMode = true
      currentLogInterval = liveLogInterval
      registry.setSnapshotIntervalMinutes(config.SNAPSHOT_INTERVAL_MINUTES)
    }

    let historicalSnapshotStream: AsyncGenerator<HistoricalSnapshotEntry, void, unknown> | null = null
    let nextHistoricalSnapshot: IteratorResult<HistoricalSnapshotEntry, void> | null = null
    let matchedHistoricalSnapshots = 0
    let historicalSnapshotStreamFailed = false
    const firstBatchBlock = ctx.blocks[0]?.header.height
    const lastBatchBlock = ctx.blocks[ctx.blocks.length - 1]?.header.height
    const advanceHistoricalSnapshot = async (): Promise<void> => {
      if (historicalSnapshotStream == null || historicalSnapshotStreamFailed) return

      try {
        nextHistoricalSnapshot = await historicalSnapshotStream.next()
      } catch (error) {
        if (requireFinalizedRaw) {
          throw new Error(
            `Failed while streaming finalized raw snapshots for batch ${firstBatchBlock}-${lastBatchBlock}: ` +
            (error instanceof Error ? error.message : String(error)),
          )
        }
        historicalSnapshotStreamFailed = true
        nextHistoricalSnapshot = null
        console.error(
          `[History] Failed while streaming raw snapshots for batch ${firstBatchBlock}-${lastBatchBlock}, falling back to RPC for remaining blocks:`,
          error,
        )
        await historicalSnapshotStream.return(undefined)
        historicalSnapshotStream = null
      }
    }
    // Use stored raw snapshots whenever they exist, even if this batch reaches head.
    // Falling back to RPC should be a per-block missing-snapshot case, not a whole-batch
    // decision based on ctx.isHead.
    const shouldLoadHistoricalSnapshots = !isLiveMode && ctx.blocks.length > 0
    if (shouldLoadHistoricalSnapshots) {
      try {
        if (requireFinalizedRaw) {
          await snapshotReader.assertFinalizedCoverage(firstBatchBlock, lastBatchBlock)
        }
        historicalSnapshotStream = snapshotReader.streamRange(firstBatchBlock, lastBatchBlock)
        await advanceHistoricalSnapshot()
      } catch (error) {
        if (requireFinalizedRaw) {
          throw error
        }
        console.error(
          `[History] Failed to load raw snapshots for batch ${firstBatchBlock}-${lastBatchBlock}, falling back to RPC:`,
          error
        )
      }
    }

    for (const block of ctx.blocks) {
      const blockHeight = block.header.height
      const blockTimestamp = toClickHouseBlockTime(block.header.timestamp, blockHeight)
      const specVersion = block.header.specVersion ?? 0

      // Parent hash validation (data integrity check)
      if (previousBlockHash !== null && block.header.parentHash !== previousBlockHash) {
        throw new Error(
          `[Integrity] Parent hash mismatch at block ${blockHeight}: ` +
          `expected ${previousBlockHash}, got ${block.header.parentHash}`
        )
      }
      previousBlockHash = block.header.hash
      previousBlockHeight = blockHeight

      // First block of this run: ensure the baseline spec version's error names
      // exist (no upgrade event fires for the initial version, e.g. at genesis).
      if (previousSpecVersion === null) {
        await snapshotRuntimeErrorNames(ctx.store, block.header.hash, specVersion)
      }

      // Runtime upgrade detection
      if (previousSpecVersion !== null && specVersion !== previousSpecVersion) {
        console.log(
          `[Runtime] Upgrade detected at block ${blockHeight}: ` +
          `v${previousSpecVersion} → v${specVersion}`
        )
        ctx.store.addRuntimeUpgrades([{
          block_height: blockHeight,
          spec_version: specVersion,
          prev_spec_version: previousSpecVersion,
        }])
        await snapshotRuntimeErrorNames(ctx.store, block.header.hash, specVersion)
        // Re-bootstrap pool caches: storage migrations may change pool compositions without emitting events
        compositionCache.invalidateAll()
      }
      previousSpecVersion = specVersion

      const hasSetStorageAffectingPools = detectPoolAffectingSetStorage(block.calls)
      const hasAssetRegistryChange = hasAssetRegistryMetadataEvent(block.events)
      let decimals = registry.getDecimals()
      let assetsTracked = registry.getCacheSize()
      let shouldProcess = true
      let xykPools: XYKPool[] = []
      let historicalSnapshot: HistoricalSnapshotState | null = null
      while (true) {
        const currentHistoricalEntry = getHistoricalSnapshotEntry(nextHistoricalSnapshot)
        if (currentHistoricalEntry == null || currentHistoricalEntry.blockHeight >= blockHeight) {
          break
        }
        await advanceHistoricalSnapshot()
      }
      const currentHistoricalEntry = getHistoricalSnapshotEntry(nextHistoricalSnapshot)
      if (currentHistoricalEntry != null && currentHistoricalEntry.blockHeight === blockHeight) {
        historicalSnapshot = currentHistoricalEntry.snapshot
        matchedHistoricalSnapshots += 1
        await advanceHistoricalSnapshot()
      }

      if (historicalSnapshot == null && shouldLoadHistoricalSnapshots && requireFinalizedRaw) {
        throw new Error(`Missing finalized raw snapshot for historical block ${blockHeight}`)
      }

      if (historicalSnapshot) {
        if (hasSetStorageAffectingPools) {
          console.warn(`[SetStorage] Pool-affecting System.set_storage detected at block ${blockHeight}`)
        }

        if (!historicalRegistryInitialized || hasAssetRegistryChange) {
          await registry.maybeSnapshot(blockHeight, block.header, { force: true })
          historicalRegistryInitialized = true
        }

        const historicalAssetRows = historicalRegistryInitialized
          ? registry.getAssetRows()
          : historicalSnapshot.assetRows
        const historicalDecimals = historicalRegistryInitialized
          ? registry.getDecimals()
          : historicalSnapshot.decimals
        decimals = historicalDecimals
        assetsTracked = historicalAssetRows.length

        const changedAssets = diffAssetRows(previousHistoricalSnapshot?.assetRows ?? null, historicalAssetRows)
        if (changedAssets.length > 0) {
          ctx.store.addAssets(changedAssets)
        }

        const compositionChanged = previousHistoricalSnapshot != null &&
          historicalSnapshot.compositionKey !== previousHistoricalSnapshot.compositionKey

        let hasPoolAffectingTransfer = false
        let hasSwapEvents = false
        for (const event of block.events) {
          if (event.name === 'Tokens.Transfer') {
            const args = event.args as { currencyId: number; from: string; to: string; amount: bigint }
            if (historicalSnapshot.poolAccounts.has(args.from) || historicalSnapshot.poolAccounts.has(args.to)) {
              hasPoolAffectingTransfer = true
            }
          }
          if (isSwapEvent(event.name, specVersion)) {
            hasSwapEvents = true
          }
          if (hasPoolAffectingTransfer && hasSwapEvents) break
        }

        if (!hasPoolAffectingTransfer && !hasSetStorageAffectingPools && !compositionChanged && !hasSwapEvents && previousPrices !== null) {
          shouldProcess = false
        } else {
          xykPools = historicalSnapshot.xykPools
        }

        previousHistoricalSnapshot = {
          ...historicalSnapshot,
          assetRows: historicalAssetRows,
          decimals: historicalDecimals,
        }
      } else {
        // Asset registry snapshot (every N blocks)
        const newAssets = await registry.maybeSnapshot(blockHeight, block.header, { force: hasAssetRegistryChange })
        if (newAssets.length > 0) {
          ctx.store.addAssets(newAssets)
        }
        decimals = registry.getDecimals()
        assetsTracked = registry.getCacheSize()

        // Update pool composition cache from events
        const { xykChanged: compositionChanged } = compositionCache.processEvents(block.events)

        if (hasSetStorageAffectingPools) {
          console.warn(`[SetStorage] Pool-affecting System.set_storage detected at block ${blockHeight}`)
          compositionCache.invalidateAll()
        }

        const xykPoolEntries = await compositionCache.getXYKPools(block.header)

        // Build set of known pool accounts for transfer event filtering
        const poolAccounts = new Set<string>()
        if (xykPoolEntries) {
          for (const pool of xykPoolEntries) {
            poolAccounts.add(pool.poolAccount)
          }
        }

        let hasPoolAffectingTransfer = false
        let hasSwapEvents = false
        for (const event of block.events) {
          if (event.name === 'Tokens.Transfer') {
            const args = event.args as { currencyId: number; from: string; to: string; amount: bigint }
            if (poolAccounts.has(args.from) || poolAccounts.has(args.to)) {
              hasPoolAffectingTransfer = true
            }
          }
          if (isSwapEvent(event.name, specVersion)) {
            hasSwapEvents = true
          }
          if (hasPoolAffectingTransfer && hasSwapEvents) break
        }

        if (!hasPoolAffectingTransfer && !hasSetStorageAffectingPools && !compositionChanged && !hasSwapEvents && previousPrices !== null) {
          shouldProcess = false
        } else {
          try {
            xykPools = xykPoolEntries ? await readXYKState(block.header, xykPoolEntries) : []
          } catch (error) {
            throw new Error(
              `[Runtime] Storage read failed at block ${blockHeight} (spec_version: ${specVersion})`,
              { cause: error },
            )
          }
        }
      }

      if (!shouldProcess) {
        blocksSkipped++

        ctx.store.addBlocks([{
          block_height: blockHeight,
          block_timestamp: blockTimestamp,
          spec_version: specVersion,
        }])

        continue
      }

      blocksProcessed++

      const { prices, hopCounts, unpricedConnected } = resolvePrices(
        xykPools,
        decimals,
        config.USD_REFERENCE_IDS,
        { minGraphPathLiquidityUsd: config.GRAPH_MIN_PATH_LIQUIDITY_USD },
      )

      const unpricedKey = unpricedConnected.join(',')
      if (unpricedKey !== lastUnpricedKey) {
        if (unpricedConnected.length > 0) {
          console.log(
            `[Pricing] Block ${blockHeight}: ${unpricedConnected.length} unpriced assets with pool connections: ${unpricedConnected.join(', ')}`
          )
        } else if (lastUnpricedKey !== '') {
          console.log(`[Pricing] Block ${blockHeight}: all connected assets now priced`)
        }
        lastUnpricedKey = unpricedKey
      }

      previousPrices = prices

      // Extract volume from swap events in this block
      const volumeRows = extractVolumeFromSwaps(
        block.events,
        blockHeight,
        specVersion,
        prices,
        decimals,
      )
      const tradeVolumeRows = extractTradeVolumeFromSwaps(
        block.events,
        blockHeight,
        specVersion,
        prices,
        decimals,
      )
      swapEventsProcessed += block.events.filter(event => isSwapEvent(event.name, specVersion)).length

      const priceRows = Array.from(prices.entries())
        .filter(([, usdPrice]) => parseFloat(usdPrice) > 0)
        .map(([assetId, usdPrice]) => ({
          asset_id: assetId,
          block_height: blockHeight,
          usd_price: usdPrice,
          hops: hopCounts.get(assetId) ?? 0,
        }))

      // Merge price rows with volume rows (combines both into single batch)
      const combinedRows = mergePriceAndVolumeRows(priceRows, volumeRows)
        .filter(row => parseFloat(row.usd_price) > 0)
        .map(row => ({ ...row, block_timestamp: blockTimestamp }))
      ctx.store.addPrices(combinedRows)
      ctx.store.addTradeVolumes(tradeVolumeRows)

      ctx.store.addBlocks([{
        block_height: blockHeight,
        block_timestamp: blockTimestamp,
        spec_version: specVersion,
      }])

      if (blockHeight - lastLogBlock >= currentLogInterval) {
        const mode = isLiveMode ? 'LIVE' : 'ARCHIVE'
        const skipRate = blocksSkipped + blocksProcessed > 0
          ? ((blocksSkipped / (blocksSkipped + blocksProcessed)) * 100).toFixed(1)
          : '0.0'
        console.log(
          `[${mode}] Block ${blockHeight} | ` +
          `${previousPrices?.size ?? 0} prices/block | ` +
          `${Math.floor(swapEventsProcessed)} swaps | ` +
          `${assetsTracked} assets tracked | ` +
          `${skipRate}% skipped | ` +
          `spec_version: ${specVersion}`
        )
        lastLogBlock = blockHeight
        blocksSkipped = 0
        blocksProcessed = 0
        swapEventsProcessed = 0
      }
    }

    if (historicalSnapshotStream != null) {
      const missingSnapshots = ctx.blocks.length - matchedHistoricalSnapshots
      if (missingSnapshots > 0) {
        console.log(
          `[History] Missing ${missingSnapshots} raw snapshots in batch ${firstBatchBlock}-${lastBatchBlock}, falling back to RPC for those blocks`
        )
      }
      await historicalSnapshotStream.return(undefined)
    }
  })

}
