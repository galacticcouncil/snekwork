import { createHash } from 'node:crypto'
import { validateBlockRange } from '../blockRange.js'
import { config } from '../config.js'
import { isSwapEvent } from '../registry/swapEvents.js'
import { AssetRegistryTracker } from '../registry/tracker.js'
import { hasAssetRegistryMetadataEvent } from '../registry/events.js'
import { PoolCompositionCache } from '../pool/compositionCache.js'
import { rawProcessor } from './processor.js'
import type { RawCall, RawEvent, RawExtrinsic } from './processor.js'
import { extractBalanceObservations } from './balance.js'
import { withoutRelayChainProof } from './callArgs.js'
import { RawDatabase } from './database.js'
import {
  buildSnapshotPayload,
  buildSnapshotState,
  detectPoolAffectingSetStorage,
  readXYKState,
} from './snapshot.js'
import {
  callAddressToString,
  extractSigner,
  toClickHouseDateTime,
  toJsonString,
} from './json.js'
import { minutesFromEnvironment } from '../util/env.js'
import { retainsSnapshotAtHeight, snapshotEveryNBlocksFromEnvironment } from './snapshotCadence.js'
import { assertChainIdentity, fetchChainHead, fetchFinalizedHead } from '../rpc/head.js'
import { waitForFinalityAbove } from './finalityGate.js'
import type {
  RawBlockRow,
  RawBlockSnapshotRow,
  RawCallRow,
  RawEventRow,
  RawExtrinsicRow,
  SnapshotState,
} from './types.js'
import { extractXcmBridgeAndOperationRows } from './xcm.js'

export interface RawRunOptions {
  fromBlock?: number
  toBlock?: number
  pipelineId?: string
}

export function boundedRawRangeFromOptions(
  options: Pick<RawRunOptions, 'fromBlock' | 'toBlock'>,
): { fromBlock: number; toBlock: number } | null {
  validateBlockRange(options)
  if (options.toBlock == null) return null
  if (options.fromBlock == null) {
    throw new Error('--from-block is required when --to-block is used for raw range finalization')
  }
  return { fromBlock: options.fromBlock, toBlock: options.toBlock }
}

const SNAPSHOT_FAMILIES = ['assets', 'xyk']

function serializeBlock(
  header: {
    height: number
    hash: string
    parentHash: string
    stateRoot?: string
    extrinsicsRoot?: string
    timestamp?: number
    specVersion: number
    validator?: string
  },
  ingestSource: string
): RawBlockRow {
  return {
    block_height: header.height,
    block_hash: header.hash,
    parent_hash: header.parentHash,
    state_root: header.stateRoot ?? null,
    extrinsics_root: header.extrinsicsRoot ?? null,
    block_timestamp: toClickHouseDateTime(header.timestamp, header.height),
    spec_version: header.specVersion,
    author: header.validator ?? null,
    ingest_source: ingestSource,
  }
}

function serializeExtrinsic(
  extrinsic: RawExtrinsic,
  blockTimestamp: string,
  ingestSource: string,
): RawExtrinsicRow {
  const signer = extractSigner(extrinsic.signature)
  return {
    block_height: extrinsic.block.height,
    block_timestamp: blockTimestamp,
    extrinsic_index: extrinsic.index,
    extrinsic_hash: extrinsic.hash ?? '',
    version: extrinsic.version ?? 0,
    signer,
    effective_signer: null,
    fee: extrinsic.fee?.toString() ?? null,
    tip: extrinsic.tip?.toString() ?? null,
    success: extrinsic.success ? 1 : 0,
    signature_json: extrinsic.signature ? toJsonString(extrinsic.signature) : null,
    call_name: extrinsic.call?.name ?? '',
    call_args_json: toJsonString(withoutRelayChainProof(extrinsic.call?.name, extrinsic.call?.args ?? null)),
    error_json: extrinsic.error == null ? null : toJsonString(extrinsic.error),
    ingest_source: ingestSource,
  }
}

function serializeCall(call: RawCall, blockTimestamp: string, ingestSource: string): RawCallRow {
  const callAddress = callAddressToString(call.address)
  if (callAddress == null) {
    throw new Error(`Call ${call.id} is missing address`)
  }

  return {
    block_height: call.block.height,
    block_timestamp: blockTimestamp,
    extrinsic_index: call.extrinsicIndex,
    call_address: callAddress,
    parent_call_address: call.address.length > 1 ? callAddressToString(call.address.slice(0, -1)) : null,
    call_name: call.name ?? '',
    origin_json: call.origin == null ? null : toJsonString(call.origin),
    args_json: toJsonString(withoutRelayChainProof(call.name, call.args ?? null)),
    success: call.success == null ? null : (call.success ? 1 : 0),
    error_json: call.error == null ? null : toJsonString(call.error),
    ingest_source: ingestSource,
  }
}

function serializeEvent(event: RawEvent, blockTimestamp: string, ingestSource: string): RawEventRow {
  return {
    block_height: event.block.height,
    block_timestamp: blockTimestamp,
    event_index: event.index,
    extrinsic_index: event.extrinsicIndex ?? null,
    call_address: callAddressToString(event.callAddress),
    phase: event.phase,
    event_name: event.name ?? '',
    args_json: toJsonString(event.args ?? null),
    ingest_source: ingestSource,
  }
}

function serializeSnapshot(
  payloadJson: string,
  block: { height: number; hash: string; timestamp?: number; specVersion: number },
  ingestSource: string
): RawBlockSnapshotRow {
  return {
    block_height: block.height,
    block_hash: block.hash,
    block_timestamp: toClickHouseDateTime(block.timestamp, block.height),
    spec_version: block.specVersion,
    snapshot_version: 1,
    families: SNAPSHOT_FAMILIES,
    payload_format: 'json',
    payload_json: payloadJson,
    payload_sha256: createHash('sha256').update(payloadJson).digest('hex'),
    ingest_source: ingestSource,
  }
}

// Chain time between asset-registry scans, not a block count: the interval is a
// duration, and a block count only expresses one at a fixed block time.
function rawAssetSnapshotIntervalMinutes(): number {
  return minutesFromEnvironment('RAW_ASSET_SNAPSHOT_INTERVAL_MINUTES', config.SNAPSHOT_INTERVAL_MINUTES, {
    name: 'RAW_ASSET_SNAPSHOT_INTERVAL',
  })
}

function snapshotTraceEnabled(): boolean {
  return process.env.RAW_SNAPSHOT_TRACE === 'true'
}

function phaseTraceEnabled(): boolean {
  return process.env.RAW_PHASE_TRACE === 'true'
}

async function tracePhase<T>(blockHeight: number, label: string, run: () => Promise<T>): Promise<T> {
  if (!phaseTraceEnabled()) return run()

  const startedAt = Date.now()
  console.log(`[Raw][PhaseTrace] Block ${blockHeight} ${label} start`)
  try {
    const result = await run()
    console.log(`[Raw][PhaseTrace] Block ${blockHeight} ${label} done in ${Date.now() - startedAt}ms`)
    return result
  } catch (error) {
    console.warn(`[Raw][PhaseTrace] Block ${blockHeight} ${label} failed after ${Date.now() - startedAt}ms`, error)
    throw error
  }
}

async function traceSnapshotRead<T>(blockHeight: number, label: string, read: () => Promise<T>): Promise<T> {
  if (!snapshotTraceEnabled()) return read()

  const startedAt = Date.now()
  console.log(`[Raw][SnapshotTrace] Block ${blockHeight} ${label} start`)
  try {
    const result = await read()
    console.log(`[Raw][SnapshotTrace] Block ${blockHeight} ${label} done in ${Date.now() - startedAt}ms`)
    return result
  } catch (error) {
    console.warn(`[Raw][SnapshotTrace] Block ${blockHeight} ${label} failed after ${Date.now() - startedAt}ms`, error)
    throw error
  }
}

// A swap that could have moved an XYK pool's reserves. A Broadcast swap whose
// filler type cannot be read is treated as one rather than risking a stale
// snapshot.
function swapMayAffectXykPools(event: RawEvent, specVersion: number): boolean {
  const name = event.name ?? ''
  if (!isSwapEvent(name, specVersion)) return false
  if (name.startsWith('XYK.')) return true
  if (!name.startsWith('Broadcast.Swapped')) return false

  const fillerKind = (event.args as { fillerType?: { __kind?: string } } | undefined)?.fillerType?.__kind
  return fillerKind === 'XYK' || fillerKind == null
}

function liveFinalityPollIntervalMs(): number {
  // Startup wait only (the follower's own head polling is RPC_HEAD_POLL_MS):
  // how often to re-check finality when we resumed already caught up to the
  // finalized head. 4s keeps the resume-into-follow handoff under one block at a
  // 6s block time — at 2s it is two blocks, so drop it to 1500-2000ms then (it is
  // one extra chain_getFinalizedHead against a local RPC, only during startup).
  const configured = Number.parseInt(process.env.RAW_LIVE_FINALITY_POLL_MS ?? '4000', 10)
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 4_000
}

function liveFinalityMaxUnansweredPolls(): number {
  // the endpoint 429s under our own load, so tolerate a long burst of unanswered
  // polls before giving up; at the default 4s poll this is ~5 minutes.
  const configured = Number.parseInt(process.env.RAW_LIVE_FINALITY_MAX_UNANSWERED ?? '75', 10)
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 75
}

export async function runRaw(options: RawRunOptions = {}): Promise<void> {
  validateBlockRange(options)
  // See src/indexer.ts: a wrong-chain RPC pairing must fail loudly at startup.
  await assertChainIdentity(config.RPC_URL, 'Raw')

  const pipelineId = options.pipelineId ?? process.env.RAW_PIPELINE_ID ?? 'raw-main'
  const boundedRange = boundedRawRangeFromOptions(options)
  const database = new RawDatabase(pipelineId, boundedRange)
  const { height: lastProcessedBlock } = await database.connect()

  let startBlock = options.fromBlock
  if (startBlock == null) {
    startBlock = lastProcessedBlock
    if (startBlock > 0) {
      console.log(`[Raw] Resuming ${pipelineId} from checkpoint block ${startBlock}`)
    } else if (options.toBlock == null) {
      // Fresh, unbounded run (the live follower): default to chain head and go
      // forward — the supervisor backfills history downward in parallel. Avoids
      // re-indexing from genesis on a clean database. Falls back to 0 only if the
      // head can't be resolved (e.g. a non-HTTP RPC).
      const head = await fetchChainHead(config.RPC_URL)
      if (head != null) {
        startBlock = head
        console.log(`[Raw] Fresh ${pipelineId}: starting live at chain head ${head} (backfill fills history downward)`)
      } else {
        console.warn(`[Raw] Fresh ${pipelineId}: could not resolve chain head from ${config.RPC_URL}; starting from block 0`)
      }
    }
  } else {
    console.log(`[Raw] Starting ${pipelineId} from block ${startBlock}`)
  }

  // FinalDatabase live follower: the subsquid runner only enters its finalized-block
  // follow loop — which then waits at the finalized head indefinitely — when the chain's
  // finalized head is strictly above our checkpoint. If we resume already caught up to the
  // finalized head (e.g. during a GRANDPA finality stall), it instead falls through to
  // processHotBlocks() and crashes on `supportsHotBlocks`, since RawDatabase can't hold
  // unfinalized blocks. Wait here until finality advances past the checkpoint so the runner
  // takes the finalized path; once running, a later stall just makes that loop wait, not
  // crash. Bounded backfill workers never reach the tip, so they skip this.
  if (boundedRange == null) {
    const { finalizedHead, waited } = await waitForFinalityAbove(lastProcessedBlock, {
      fetchFinalizedHead: () => fetchFinalizedHead(config.RPC_URL),
      sleep: ms => new Promise<void>(resolve => setTimeout(resolve, ms)),
      pollMs: liveFinalityPollIntervalMs(),
      maxUnanswered: liveFinalityMaxUnansweredPolls(),
      log: message => console.log(`[Raw] ${pipelineId}: ${message}`),
    })
    if (waited) {
      console.log(`[Raw] ${pipelineId}: finality advanced to ${finalizedHead}; starting follower`)
    }
  }

  rawProcessor.setBlockRange({
    from: startBlock,
    to: options.toBlock,
  })

  if (boundedRange != null) {
    await database.markRangeRunning(boundedRange.fromBlock, boundedRange.toBlock)
    if (lastProcessedBlock >= boundedRange.toBlock) {
      console.log(`[Raw] Checkpoint already reached ${boundedRange.fromBlock}-${boundedRange.toBlock}; validating finalized range`)
      try {
        await database.finalizeRange(boundedRange.fromBlock, boundedRange.toBlock)
      } catch (error) {
        await database.markRangeFailed(boundedRange.fromBlock, boundedRange.toBlock, error)
        throw error
      }
      return
    }
  }

  const registry = new AssetRegistryTracker(rawAssetSnapshotIntervalMinutes())
  const compositionCache = new PoolCompositionCache()

  // Throws on a cadence that would stop populating the % 600 pool-history MVs,
  // before a single block is indexed.
  const snapshotEveryNBlocks = snapshotEveryNBlocksFromEnvironment()
  if (snapshotEveryNBlocks > 1) {
    console.warn(
      `[Raw] RAW_SNAPSHOT_EVERY_N_BLOCKS=${snapshotEveryNBlocks}: raw_block_snapshots keeps one row per ${snapshotEveryNBlocks} blocks. ` +
      'The main (price) pipeline requires a snapshot row for every historical block it replays ' +
      '(src/indexer.ts, "Missing finalized raw snapshot"), so any range it has not already processed will fail.',
    )
  }

  let currentState: SnapshotState | null = null
  let previousBlockHash: string | null = null
  let previousBlockHeight: number | null = null
  let previousSpecVersion: number | null = null

  let lastLogBlock = startBlock
  let blocksProcessed = 0
  let extrinsicsPersisted = 0
  let callsPersisted = 0
  let eventsPersisted = 0
  let balanceRowsPersisted = 0
  let xcmRowsPersisted = 0
  let parserWarningsPersisted = 0
  let snapshotsRefreshed = 0
  let snapshotsReused = 0

  rawProcessor.run(database, async (ctx) => {
    const firstHeight = ctx.blocks[0]?.header.height
    if (firstHeight != null && previousBlockHeight != null) {
      if (firstHeight <= previousBlockHeight) {
        previousBlockHash = null
        previousBlockHeight = null
      } else if (firstHeight > previousBlockHeight + 1) {
        throw new Error(`[Raw][Integrity] Processor gap between blocks ${previousBlockHeight} and ${firstHeight}`)
      }
    }
    const ingestSource = ctx.isHead ? 'rpc' : 'sqd'
    const logInterval = ctx.isHead ? 1 : 100

    for (const block of ctx.blocks) {
      const blockHeight = block.header.height
      const blockTimestamp = toClickHouseDateTime(block.header.timestamp, blockHeight)
      const specVersion = block.header.specVersion ?? 0

      if (previousBlockHash != null && block.header.parentHash !== previousBlockHash) {
        throw new Error(
          `[Raw][Integrity] Parent hash mismatch at block ${blockHeight}: expected ${previousBlockHash}, got ${block.header.parentHash}`,
        )
      }

      const specChanged = previousSpecVersion != null && specVersion !== previousSpecVersion
      if (specChanged) {
        console.log(`[Raw][Runtime] Upgrade detected at block ${blockHeight}: v${previousSpecVersion} -> v${specVersion}`)
        compositionCache.invalidateAll()
      }

      previousBlockHash = block.header.hash
      previousBlockHeight = blockHeight
      previousSpecVersion = specVersion

      ctx.store.addBlocks([serializeBlock(block.header, ingestSource)])

      const extrinsicRows = block.extrinsics.map(extrinsic => serializeExtrinsic(extrinsic, blockTimestamp, ingestSource))
      const callRows = block.calls.map(call => serializeCall(call, blockTimestamp, ingestSource))
      const eventRows = block.events.map(event => serializeEvent(event, blockTimestamp, ingestSource))

      ctx.store.addExtrinsics(extrinsicRows)
      ctx.store.addCalls(callRows)
      ctx.store.addEvents(eventRows)

      extrinsicsPersisted += extrinsicRows.length
      callsPersisted += callRows.length
      eventsPersisted += eventRows.length

      const balances = await tracePhase(blockHeight, 'balances', () => extractBalanceObservations(
          block.header,
          blockTimestamp,
          block.events,
          block.calls,
          ingestSource,
        ))
      const xcmBridgeOperations = extractXcmBridgeAndOperationRows(block.events, block.calls, blockTimestamp, ingestSource)

      ctx.store.addBalanceObservations(balances.observations)
      ctx.store.addParserWarnings(balances.warnings)
      ctx.store.addXcmActivity(xcmBridgeOperations.xcmActivity)
      ctx.store.addBridgeEvidence(xcmBridgeOperations.bridgeEvidence)
      ctx.store.addOperationTraces(xcmBridgeOperations.operationTraces)

      balanceRowsPersisted += balances.observations.length
      parserWarningsPersisted += balances.warnings.length
      xcmRowsPersisted += xcmBridgeOperations.xcmActivity.length +
        xcmBridgeOperations.bridgeEvidence.length +
        xcmBridgeOperations.operationTraces.length

      // Force the scan when this block carries an asset-registry event: the raw
      // pipeline sees every event, and the snapshot payload written for this and
      // every following block must carry the post-change registry (a rename that
      // waits for the periodic scan bakes the OLD name into ~100 minutes of
      // snapshot payloads, which replay/backfill then treats as era truth).
      const changedAssets = await tracePhase(blockHeight, 'asset_registry', () => registry.maybeSnapshot(blockHeight, block.header, { force: hasAssetRegistryMetadataEvent(block.events) }))
      let refreshXyk = currentState == null || specChanged || compositionCache.processEvents(block.events).xykChanged

      const hasSetStorageAffectingPools = detectPoolAffectingSetStorage(block.calls)
      if (hasSetStorageAffectingPools) {
        console.warn(`[Raw][SetStorage] Pool-affecting System.set_storage detected at block ${blockHeight}`)
        compositionCache.invalidateAll()
        refreshXyk = true
      }

      const xykPoolEntries = await tracePhase(
        blockHeight,
        'pool_composition',
        () => compositionCache.getXYKPools(block.header),
      )

      const poolAccounts = new Set<string>()
      if (xykPoolEntries != null) {
        for (const pool of xykPoolEntries) {
          poolAccounts.add(pool.poolAccount)
        }
      }

      for (const event of block.events) {
        if (event.name === 'Tokens.Transfer') {
          const args = event.args as { from: string; to: string }
          if (poolAccounts.has(args.from) || poolAccounts.has(args.to)) refreshXyk = true
        }
        if (swapMayAffectXykPools(event, specVersion)) refreshXyk = true
      }

      if (refreshXyk) {
        const xykPools = xykPoolEntries != null
          ? await traceSnapshotRead(blockHeight, `xyk pools=${xykPoolEntries.length}`, () => readXYKState(block.header, xykPoolEntries))
          : currentState?.xyk_pools ?? []

        currentState = buildSnapshotState({
          assets: registry.getAssetsMetadata(),
          xykPools,
        })
        snapshotsRefreshed++
      } else if (changedAssets.length > 0 && currentState != null) {
        currentState = {
          ...currentState,
          assets: registry.getAssetsMetadata(),
        }
      } else {
        snapshotsReused++
      }

      if (currentState == null) {
        throw new Error(`Snapshot state not initialized at block ${blockHeight}`)
      }

      // The ~273 KB payload is built and stored per block by default. Under a
      // thinned cadence the serialization is skipped too, not just the row — the
      // JSON is the cost, and `currentState` (which the next block reuses) is
      // maintained above regardless of whether this height is written out.
      if (retainsSnapshotAtHeight(blockHeight, snapshotEveryNBlocks)) {
        const payload = buildSnapshotPayload(block.header, currentState)
        const payloadJson = toJsonString(payload)
        ctx.store.addSnapshots([
          serializeSnapshot(payloadJson, block.header, ingestSource),
        ])
      }

      blocksProcessed++

      if (blockHeight - lastLogBlock >= logInterval) {
        console.log(
          `[Raw][${ingestSource.toUpperCase()}] Block ${blockHeight} | ` +
          `${blocksProcessed} blocks | ` +
          `${extrinsicsPersisted} extrinsics | ` +
          `${callsPersisted} calls | ` +
          `${eventsPersisted} events | ` +
          `${balanceRowsPersisted} balances | ` +
          `${xcmRowsPersisted} xcm/bridge/operation rows | ` +
          `${parserWarningsPersisted} warnings | ` +
          `${snapshotsRefreshed} refreshed | ` +
          `${snapshotsReused} reused`,
        )

        lastLogBlock = blockHeight
        blocksProcessed = 0
        extrinsicsPersisted = 0
        callsPersisted = 0
        eventsPersisted = 0
        balanceRowsPersisted = 0
        xcmRowsPersisted = 0
        parserWarningsPersisted = 0
        snapshotsRefreshed = 0
        snapshotsReused = 0
      }
    }
  })
}
