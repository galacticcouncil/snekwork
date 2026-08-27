import type { Block } from '../types/support.ts'
import * as storage from '../types/storage.ts'
import type { AssetMetadata } from './types.ts'
import type { AssetRow } from '../db/schema.ts'
import { config } from '../config.ts'
import { MS_PER_MINUTE, shouldRunOnElapsedChainTime } from '../util/chainTimeCadence.ts'

// Every caller passes a processor block *header*, which carries the chain
// timestamp the scan cadence is measured in; the storage reads only need `Block`.
type TimestampedBlock = Block & { timestamp?: number }

interface SnapshotOptions {
  force?: boolean
}

interface TrackerOptions {
  includeUnresolvedAssets?: boolean
}

const DEFAULT_ASSET_DECIMALS = 12

function assetRow(metadata: AssetMetadata): AssetRow {
  return {
    asset_id: metadata.assetId,
    symbol: metadata.symbol,
    name: metadata.name,
    decimals: metadata.decimals,
    parachain_id: metadata.parachainId ?? null,
    origin_ecosystem: metadata.originEcosystem ?? null,
    origin_chain_id: metadata.originChainId ?? null,
    origin_asset_id: metadata.originAssetId ?? null,
  }
}

function assetMetadataChanged(previous: AssetMetadata, current: AssetMetadata): boolean {
  return previous.symbol !== current.symbol
    || previous.name !== current.name
    || previous.decimals !== current.decimals
    || previous.parachainId !== current.parachainId
    || previous.originEcosystem !== current.originEcosystem
    || previous.originChainId !== current.originChainId
    || previous.originAssetId !== current.originAssetId
}

/**
 * Decode hex-encoded bytes to UTF-8 string
 */
function decodeBytes(bytes: Uint8Array | string | undefined): string {
  if (!bytes) return ''

  if (typeof bytes === 'string') {
    if (bytes.startsWith('0x')) {
      try {
        return Buffer.from(bytes.slice(2), 'hex').toString('utf8')
      } catch {
        return bytes
      }
    }
    return bytes
  }

  // Uint8Array
  return Buffer.from(bytes).toString('utf8')
}

/**
 * Format asset type discriminant as string
 */
function formatAssetType(assetType: { __kind: string; value?: unknown }): string {
  if (assetType.__kind === 'PoolShare' && Array.isArray(assetType.value)) {
    const [asset1, asset2] = assetType.value
    return `PoolShare(${asset1},${asset2})`
  }
  return assetType.__kind
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object'
    ? value as Record<string, unknown>
    : null
}

const JUNCTION_LEVELS = new Set(['X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7', 'X8'])

/**
 * One shape for every XCM version an AssetLocation has been stored in.
 *
 * V1 and later (spec 19 onward) split a location into `{parents, interior}`.
 * XCM V0 — the genesis shape, specs 16..18 — has no `parents` at all: the whole
 * location IS the junction enum (`{__kind: 'X2', value: [...]}`), and going up
 * is spelled as leading `Parent` junctions. So V0's
 *   X2(Parent, Parachain(2000))
 * is V1's
 *   {parents: 1, interior: X1(Parachain(2000))}
 * and every reader below wants the same two facts out of both: how many levels
 * up, and which junctions are left once those are stripped.
 *
 * Basilisk registered no asset location at all while V0 was live — AssetLocations
 * is empty at block 129,696 and still empty at 1,000,000, filling in only once
 * V1 was in place — so this arm has no historic rows to resolve. It is here so a
 * genesis-era read resolves an origin instead of silently returning null, which
 * is what `parents !== 1` did to every V0 shape before.
 */
function normalizedLocation(location: unknown): { parents: number; junctions: Record<string, unknown>[] } | null {
  const locationRecord = objectRecord(location)
  if (locationRecord == null) return null

  const junctionsOf = (level: Record<string, unknown>): unknown[] => {
    if (level.__kind === 'Here') return []
    const valueRecord = objectRecord(level.value)
    return Array.isArray(level.value)
      ? level.value
      : level.__kind === 'X1'
        ? [level.value]
        : valueRecord == null ? [] : Object.values(valueRecord)
  }

  // XCM V0: no `parents` key, the location itself is the junction level.
  const kind = typeof locationRecord.__kind === 'string' ? locationRecord.__kind : null
  if (locationRecord.parents === undefined && kind != null && (kind === 'Here' || JUNCTION_LEVELS.has(kind))) {
    const all = junctionsOf(locationRecord).map(objectRecord).filter((v): v is Record<string, unknown> => v != null)
    let parents = 0
    while (parents < all.length && all[parents].__kind === 'Parent') parents++
    return { parents, junctions: all.slice(parents) }
  }

  // XCM V1 and later.
  const interior = objectRecord(locationRecord.interior)
  if (interior == null) return null
  return {
    parents: typeof locationRecord.parents === 'number' ? locationRecord.parents : 0,
    junctions: junctionsOf(interior).map(objectRecord).filter((v): v is Record<string, unknown> => v != null),
  }
}

function locationJunctions(location: unknown): Record<string, unknown>[] {
  return normalizedLocation(location)?.junctions ?? []
}

function junctionPayload(junction: Record<string, unknown>): Record<string, unknown> | null {
  return objectRecord(junction.value)
}

function normalizedHex(value: unknown, bytes?: number): string | null {
  const direct = typeof value === 'string' ? value : value instanceof Uint8Array ? Buffer.from(value).toString('hex') : null
  if (direct == null) return null
  const hex = direct.startsWith('0x') ? direct.toLowerCase() : `0x${direct.toLowerCase()}`
  return /^0x[0-9a-f]+$/.test(hex) && (bytes == null || hex.length === 2 + bytes * 2) ? hex : null
}

export interface AssetOrigin {
  ecosystem: 'polkadot' | 'ethereum'
  chainId: string
  assetId: string | null
}

// A GeneralKey's `data` is a fixed 32-byte field and `length` says how many of those
// bytes are the key, so the padding has to come off before the key means anything —
// `0x0900` and `0x7768` both arrive padded to 32 bytes.
function generalKeyData(junction: Record<string, unknown>, bytes?: number): string | null {
  const details = junctionPayload(junction) ?? junction
  const padded = normalizedHex(details.data)
  if (padded == null) return null
  const declared = typeof details.length === 'number' ? details.length : null
  const key = declared != null && declared * 2 <= padded.length - 2
    ? `0x${padded.slice(2, 2 + declared * 2)}`
    : padded
  return bytes == null || key.length === 2 + bytes * 2 ? key : null
}

// Decode a generic origin tuple: ecosystem + chain + origin-chain asset key.
// This preserves Ethereum GlobalConsensus/AccountKey20 locations instead of
// reducing every origin to a nullable parachain id.
export function extractAssetOrigin(location: unknown): AssetOrigin | null {
  const junctions = locationJunctions(location)
  const consensus = junctions.find(j => j.__kind === 'GlobalConsensus')
  const network = consensus ? (junctionPayload(consensus) ?? consensus) : null
  const networkKind = String(network?.__kind ?? network?.type ?? '')
  if (networkKind === 'Ethereum') {
    const details = objectRecord(network?.value) ?? network
    const rawChainId = details?.chainId ?? details?.chain_id ?? details?.value
    const chainId = typeof rawChainId === 'bigint' || typeof rawChainId === 'number' || typeof rawChainId === 'string'
      ? String(rawChainId) : ''
    const account = junctions.find(j => j.__kind === 'AccountKey20')
    const accountDetails = account ? (junctionPayload(account) ?? account) : null
    const assetId = normalizedHex(accountDetails?.key, 20)
    return chainId && assetId ? { ecosystem: 'ethereum', chainId, assetId } : null
  }

  const parachainId = extractParachainId(location)
  if (parachainId == null) return null
  const originJunction = junctions.find(j => j.__kind !== 'Parachain')
  let assetId: string | null = null
  if (originJunction?.__kind === 'GeneralIndex') assetId = String(originJunction.value)
  else if (originJunction?.__kind === 'AccountKey20') {
    const details = junctionPayload(originJunction) ?? originJunction
    assetId = normalizedHex(details.key, 20)
  } else if (originJunction?.__kind === 'GeneralKey') {
    assetId = generalKeyData(originJunction)
  }
  return { ecosystem: 'polkadot', chainId: String(parachainId), assetId }
}

/**
 * Extract parachainId from an AssetLocation.
 * Matches: { parents: 1, interior: X1(Parachain(id)) } or X2(Parachain(id), ...),
 * and the equivalent XCM V0 shapes, where "one level up" is a leading `Parent`
 * junction instead of a `parents` field: X2(Parent, Parachain(id)) and up.
 * Native Basilisk assets have no location -> returns null.
 */
export function extractParachainId(location: unknown): number | null {
  const normalized = normalizedLocation(location)
  if (normalized == null || normalized.parents !== 1) return null
  const { junctions } = normalized
  if (junctions.length === 0) return null

  const parachainJunction = junctions.find(junction => junction.__kind === 'Parachain')
  if (!parachainJunction) return null

  // If the only junction is Parachain, this is a native token of that chain — not bridged
  if (junctions.length === 1) return null

  return typeof parachainJunction.value === 'number' &&
    Number.isSafeInteger(parachainJunction.value) &&
    parachainJunction.value >= 0
    ? parachainJunction.value
    : null
}

// AssetRegistry.AssetLocations, newest shape first. The XCM version the location
// is stored in moved with the runtime: V0 junctions with no `parents` at genesis
// (v16), V1 from spec 19, V3 from spec 101, V5 from spec 128. normalizedLocation
// reads all four, mapping V0's leading `Parent` junctions onto the `parents`
// count the later shapes carry as a field.
interface AssetLocationsCodec {
  getMany(block: Block, keys: number[]): Promise<unknown[]>
}

function assetLocationsCodec(block: Block): AssetLocationsCodec | null {
  const codecs = storage.assetRegistry.assetLocations
  if (codecs.v128.is(block)) return codecs.v128
  if (codecs.v115.is(block)) return codecs.v115
  if (codecs.v101.is(block)) return codecs.v101
  if (codecs.v25.is(block)) return codecs.v25
  if (codecs.v19.is(block)) return codecs.v19
  if (codecs.v16.is(block)) return codecs.v16
  return null
}

async function readAssetLocations(block: Block, assetIds: number[]): Promise<Array<[number, unknown]>> {
  const codec = assetLocationsCodec(block)
  if (codec == null) return []

  const locations = await codec.getMany(block, assetIds)
  return assetIds.map((assetId, index) => [assetId, locations[index]])
}

// AssetRegistry.Assets, newest shape first. Every Basilisk era stores only
// name/assetType here — unlike Hydration, symbol and decimals were never folded
// into AssetDetails, so they always come from AssetMetadataMap below.
interface AssetDetailsCodec {
  getPairs(block: Block): Promise<[k: number, v: ({ name: Uint8Array | string; assetType: { __kind: string; value?: unknown } } | undefined)][]>
}

function assetDetailsCodec(block: Block): AssetDetailsCodec | null {
  const codecs = storage.assetRegistry.assets
  if (codecs.v124.is(block)) return codecs.v124
  if (codecs.v115.is(block)) return codecs.v115
  if (codecs.v108.is(block)) return codecs.v108
  if (codecs.v101.is(block)) return codecs.v101
  if (codecs.v25.is(block)) return codecs.v25
  if (codecs.v16.is(block)) return codecs.v16
  return null
}

export function isPlaceholderAssetMetadata(metadata: Pick<AssetMetadata, 'assetId' | 'symbol' | 'name' | 'assetType'>): boolean {
  const hasGeneratedLabels = metadata.symbol === `Asset${metadata.assetId}` &&
    metadata.name === `Asset ${metadata.assetId}`
  return hasGeneratedLabels && (metadata.assetType == null || metadata.assetType === 'External')
}

export class AssetRegistryTracker {
  private cache: Map<number, AssetMetadata> = new Map()
  // Chain time of the last scan, not the height of it: the scan cadence is a
  // duration ("about every 100 minutes"), and a block count only expresses a
  // duration at one particular block time. null forces the first scan.
  private lastSnapshotTimestampMs: number | null = null
  private snapshotIntervalMinutes: number
  private seededAssetRows: AssetRow[] = []
  private includeUnresolvedAssets: boolean

  constructor(snapshotIntervalMinutes?: number, nativeAssetMetadata?: AssetMetadata, options: TrackerOptions = {}) {
    this.snapshotIntervalMinutes = snapshotIntervalMinutes ?? config.SNAPSHOT_INTERVAL_MINUTES
    this.includeUnresolvedAssets = options.includeUnresolvedAssets ?? true
    if (nativeAssetMetadata) {
      this.cache.set(nativeAssetMetadata.assetId, { ...nativeAssetMetadata })
      this.seededAssetRows.push({
        asset_id: nativeAssetMetadata.assetId,
        symbol: nativeAssetMetadata.symbol,
        name: nativeAssetMetadata.name,
        decimals: nativeAssetMetadata.decimals,
        parachain_id: nativeAssetMetadata.parachainId ?? null,
        origin_ecosystem: nativeAssetMetadata.originEcosystem ?? null,
        origin_chain_id: nativeAssetMetadata.originChainId ?? null,
        origin_asset_id: nativeAssetMetadata.originAssetId ?? null,
      })
    }
  }

  /**
   * Perform snapshot scan if interval has passed
   * Returns AssetRow[] for any new or changed assets (for ClickHouse persistence)
   */
  async maybeSnapshot(blockHeight: number, block: TimestampedBlock, options: SnapshotOptions = {}): Promise<AssetRow[]> {
    // Check if snapshot is needed. The interval is chain time read off the blocks
    // themselves, so it means the same thing live, during backfill (a historical
    // block carries the time it was authored at), and after a block-time change.
    if (!options.force && !shouldRunOnElapsedChainTime(
      this.lastSnapshotTimestampMs,
      block.timestamp,
      this.snapshotIntervalMinutes * MS_PER_MINUTE,
    )) {
      return []
    }

    console.log(`[AssetRegistry] Scanning at block ${blockHeight}${options.force ? ' (forced)' : ''}`)

    const newAssets: AssetRow[] = []
    const discoveredAssets = new Map<number, AssetMetadata>()
    let unresolvedAssetsSkipped = 0
    const addDiscoveredAsset = (metadata: AssetMetadata): void => {
      if (!this.includeUnresolvedAssets && isPlaceholderAssetMetadata(metadata)) {
        unresolvedAssetsSkipped++
        return
      }
      discoveredAssets.set(metadata.assetId, metadata)
    }

    // Basilisk always splits asset metadata across two maps: AssetRegistry.Assets
    // holds name + assetType, AssetRegistry.AssetMetadataMap holds symbol +
    // decimals. That has been true from genesis through spec 134 — there is no
    // merged-AssetDetails era to fall back from, so this is the only path.
    const assetDetails = assetDetailsCodec(block)
    if (assetDetails == null) {
      console.warn(`[AssetRegistry] No matching AssetRegistry.Assets storage version at block ${blockHeight}`)
    } else {
      const assetDetailsPairs = await assetDetails.getPairs(block)

      // Build map of assetId -> name/assetType
      const detailsMap = new Map<number, { name: string, assetType: string }>()
      for (const [assetId, details] of assetDetailsPairs) {
        if (!details) continue
        detailsMap.set(assetId, {
          name: decodeBytes(details.name).trim() || `Asset ${assetId}`,
          assetType: formatAssetType(details.assetType),
        })
      }

      // Get symbol/decimals from AssetMetadataMap (one shape across all specs)
      if (storage.assetRegistry.assetMetadataMap.v16.is(block)) {
        const metadataPairs = await storage.assetRegistry.assetMetadataMap.v16.getPairs(block)
        const metadataAssetIds = new Set<number>()

        for (const [assetId, metadata] of metadataPairs) {
          if (!metadata) continue
          metadataAssetIds.add(assetId)
          if (metadata.decimals == null) {
            if (!this.includeUnresolvedAssets) {
              unresolvedAssetsSkipped++
              continue
            }
          }

          const details = detailsMap.get(assetId)
          const assetMetadata: AssetMetadata = {
            assetId,
            symbol: decodeBytes(metadata.symbol).trim() || `Asset${assetId}`,
            name: details?.name || `Asset ${assetId}`,
            decimals: metadata.decimals ?? DEFAULT_ASSET_DECIMALS,
            assetType: details?.assetType,
          }

          addDiscoveredAsset(assetMetadata)
        }

        // Handle assets that have details but no metadata entry (shouldn't happen, but be defensive)
        for (const [assetId, details] of detailsMap) {
          if (!metadataAssetIds.has(assetId)) {
            if (!this.includeUnresolvedAssets) {
              console.warn(`[AssetRegistry] Asset ${assetId} has details but no metadata, skipping until decimals are known`)
              unresolvedAssetsSkipped++
            } else {
              console.warn(`[AssetRegistry] Asset ${assetId} has details but no metadata, using defaults`)
              addDiscoveredAsset({
                assetId,
                symbol: `Asset${assetId}`,
                name: details.name,
                decimals: DEFAULT_ASSET_DECIMALS,
                assetType: details.assetType,
              })
            }
          }
        }
      } else {
        console.warn(`[AssetRegistry] No matching AssetRegistry.AssetMetadataMap storage version at block ${blockHeight}`)
      }
    }

    // Read every location once, then derive origin chains and parachain ids.
    const allAssetIds = [...discoveredAssets.keys()]
    if (allAssetIds.length > 0) {
      try {
        for (const [assetId, location] of await readAssetLocations(block, allAssetIds)) {
          const metadata = discoveredAssets.get(assetId)
          if (metadata == null) continue

          metadata.parachainId = extractParachainId(location) ?? undefined
          const origin = extractAssetOrigin(location)
          metadata.originEcosystem = origin?.ecosystem
          metadata.originChainId = origin?.chainId
          metadata.originAssetId = origin?.assetId ?? undefined
        }
      } catch (error) {
        console.warn('[AssetRegistry] Failed to read asset locations:', error)
      }
    }

    // Compare with cache and identify new/changed assets
    for (const [assetId, metadata] of discoveredAssets) {
      const existing = this.cache.get(assetId)

      if (!existing) {
        console.log(`[AssetRegistry] New asset discovered: ${assetId} (${metadata.symbol})`)
        newAssets.push(assetRow(metadata))
      } else if (assetMetadataChanged(existing, metadata)) {
        console.log(`[AssetRegistry] Asset ${assetId} metadata changed`)
        newAssets.push(assetRow(metadata))
      }

      this.cache.set(assetId, metadata)
    }

    if (this.seededAssetRows.length > 0) {
      const seenIds = new Set(newAssets.map(asset => asset.asset_id))
      for (const row of this.seededAssetRows) {
        if (!seenIds.has(row.asset_id)) {
          newAssets.push(row)
        }
      }
      this.seededAssetRows = []
    }

    // Genesis carries no timestamp. Recording 0 costs exactly one extra scan —
    // the next timestamped block is epoch-milliseconds past 0, so it re-scans
    // immediately and the normal cadence runs from there — while any further
    // timestamp-less block is skipped by shouldRunOnElapsedChainTime rather than
    // scanning every block.
    this.lastSnapshotTimestampMs = block.timestamp ?? 0

    const skippedSuffix = unresolvedAssetsSkipped > 0
      ? `, ${unresolvedAssetsSkipped} unresolved assets skipped`
      : ''
    console.log(`[AssetRegistry] Scan complete: ${discoveredAssets.size} total assets, ${newAssets.length} new/changed${skippedSuffix}`)

    return newAssets
  }

  /**
   * Get decimals map for all assets (used by price calculation module)
   */
  getDecimals(): Map<number, number> {
    const decimalsMap = new Map<number, number>()
    for (const [assetId, metadata] of this.cache) {
      decimalsMap.set(assetId, metadata.decimals)
    }
    return decimalsMap
  }

  getCacheSize(): number {
    return this.cache.size
  }

  getAssetRows(): AssetRow[] {
    return [...this.cache.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, metadata]) => ({
        asset_id: metadata.assetId,
        symbol: metadata.symbol,
        name: metadata.name,
        decimals: metadata.decimals,
        parachain_id: metadata.parachainId ?? null,
        origin_ecosystem: metadata.originEcosystem ?? null,
        origin_chain_id: metadata.originChainId ?? null,
        origin_asset_id: metadata.originAssetId ?? null,
      }))
  }

  getAssetsMetadata(): AssetMetadata[] {
    return [...this.cache.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, metadata]) => ({ ...metadata }))
  }

  /**
   * Update snapshot interval (used when switching between archive/live modes)
   */
  setSnapshotIntervalMinutes(minutes: number): void {
    this.snapshotIntervalMinutes = minutes
    console.log(`[AssetRegistry] Snapshot interval updated to ${minutes} minutes of chain time`)
  }
}
