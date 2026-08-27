import { createHash } from 'node:crypto'
import { createClickHouseClient, type ClickHouseClient } from '../db/client.js'
import type { AssetRow } from '../db/schema.ts'
import type { XYKPool } from '../price/types.ts'
import type { SnapshotPayload } from '../raw/types.ts'
import {
  assertFinalizedRawCoverage,
  getCompletedRawRanges,
} from '../raw/ranges.js'

interface SnapshotRow {
  block_height: number
  payload_json: string
}

interface ParseSnapshotOptions {
  nativeAssetRow?: AssetRow
}

export interface HistoricalSnapshotEntry {
  blockHeight: number
  snapshot: HistoricalSnapshotState
}

export interface HistoricalSnapshotState {
  assetRows: AssetRow[]
  compositionKey: string
  decimals: Map<number, number>
  poolAccounts: Set<string>
  xykPools: XYKPool[]
}

function toBigInt(value: string | number | bigint | null | undefined): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`Snapshot integer is not safe: ${value}`)
    }
    return BigInt(value)
  }
  if (value == null || value === '') return 0n
  return BigInt(value)
}

function asArray<T>(value: T[] | '0x' | null | undefined): T[] {
  if (value == null || value === '0x') return []
  return value
}

function toNumber(value: string | number | bigint): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'bigint'
      ? Number(value)
      : /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Snapshot asset id is not a non-negative safe integer: ${String(value)}`)
  }
  return parsed
}

function hashFields(parts: Array<string | number | bigint | null | undefined>): string {
  const hash = createHash('sha256')
  for (const part of parts) {
    hash.update(String(part ?? ''))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function buildCompositionKey(xykPoolItems: SnapshotPayload['xyk']['pools']): string {
  const hash = createHash('sha256')

  hash.update(hashFields(['xyk']))
  for (const pool of xykPoolItems) {
    hash.update(hashFields([pool.pool_account, pool.asset_a, pool.asset_b]))
  }

  return hash.digest('hex')
}

function parseSnapshot(payloadJson: string, options: ParseSnapshotOptions = {}): HistoricalSnapshotState {
  const payload = JSON.parse(payloadJson) as SnapshotPayload

  const assetItems = asArray(payload.assets.items as SnapshotPayload['assets']['items'] | '0x')
  const xykPoolItems = asArray(payload.xyk.pools as SnapshotPayload['xyk']['pools'] | '0x')

  let assetRows: AssetRow[] = assetItems.map(asset => ({
    asset_id: asset.assetId,
    symbol: asset.symbol,
    name: asset.name,
    decimals: asset.decimals,
    parachain_id: asset.parachainId ?? null,
    origin_ecosystem: asset.originEcosystem ?? null,
    origin_chain_id: asset.originChainId ?? null,
    origin_asset_id: asset.originAssetId ?? null,
  }))

  const nativeAssetRow = options.nativeAssetRow
  if (
    nativeAssetRow != null &&
    !assetRows.some(asset => asset.asset_id === nativeAssetRow.asset_id) &&
    xykPoolItems.some(pool => pool.asset_a === nativeAssetRow.asset_id || pool.asset_b === nativeAssetRow.asset_id)
  ) {
    assetRows = [...assetRows, { ...nativeAssetRow }].sort((a, b) => a.asset_id - b.asset_id)
  }

  const decimals = new Map<number, number>()
  for (const row of assetRows) {
    decimals.set(row.asset_id, row.decimals)
  }

  const xykPools: XYKPool[] = xykPoolItems.map(pool => ({
    assetA: pool.asset_a,
    assetB: pool.asset_b,
    reserveA: toBigInt(pool.reserve_a),
    reserveB: toBigInt(pool.reserve_b),
  }))

  const poolAccounts = new Set<string>()
  for (const pool of xykPoolItems) {
    poolAccounts.add(pool.pool_account)
  }

  const compositionKey = buildCompositionKey(xykPoolItems)

  return {
    assetRows,
    compositionKey,
    decimals,
    poolAccounts,
    xykPools,
  }
}

export function diffAssetRows(
  previousRows: AssetRow[] | null,
  currentRows: AssetRow[],
): AssetRow[] {
  if (previousRows == null) {
    return currentRows
  }

  const previousById = new Map(previousRows.map(row => [row.asset_id, row]))

  return currentRows.filter(row => {
    const previous = previousById.get(row.asset_id)
    return previous == null ||
      previous.symbol !== row.symbol ||
      previous.name !== row.name ||
      previous.decimals !== row.decimals ||
      previous.parachain_id !== row.parachain_id
      || previous.origin_ecosystem !== row.origin_ecosystem
      || previous.origin_chain_id !== row.origin_chain_id
      || previous.origin_asset_id !== row.origin_asset_id
  })
}

export class ClickHouseSnapshotReader {
  private readonly client: ClickHouseClient
  private readonly nativeAssetRow?: AssetRow
  private readonly finalizedOnly: boolean

  constructor(options: { client?: ClickHouseClient; nativeAssetRow?: AssetRow; finalizedOnly?: boolean } = {}) {
    this.client = options.client ?? createClickHouseClient()
    this.nativeAssetRow = options.nativeAssetRow
    this.finalizedOnly = options.finalizedOnly ?? false
  }

  async assertFinalizedCoverage(fromBlock: number, toBlock: number): Promise<void> {
    await assertFinalizedRawCoverage(this.client, fromBlock, toBlock)
  }

  async *streamRange(fromBlock: number, toBlock: number): AsyncGenerator<HistoricalSnapshotEntry> {
    const ranges = this.finalizedOnly
      ? await getCompletedRawRanges(this.client, fromBlock, toBlock)
      : [{ fromBlock, toBlock }]

    for (const range of ranges) {
      const result = await this.client.query({
        query: `
          SELECT block_height, payload_json
          FROM price_data.raw_block_snapshots FINAL
          WHERE block_height >= ${range.fromBlock}
            AND block_height <= ${range.toBlock}
          ORDER BY block_height ASC
        `,
        format: 'JSONEachRow',
      })

      try {
        for await (const rows of result.stream<SnapshotRow>()) {
          for (const row of rows) {
            const snapshotRow = row.json<SnapshotRow>()
            yield {
              blockHeight: snapshotRow.block_height,
              snapshot: parseSnapshot(snapshotRow.payload_json, { nativeAssetRow: this.nativeAssetRow }),
            }
          }
        }
      } finally {
        result.close()
      }
    }
  }

  async loadRange(fromBlock: number, toBlock: number): Promise<Map<number, HistoricalSnapshotState>> {
    const snapshots = new Map<number, HistoricalSnapshotState>()

    for await (const entry of this.streamRange(fromBlock, toBlock)) {
      snapshots.set(entry.blockHeight, entry.snapshot)
    }

    return snapshots
  }

  async close(): Promise<void> {
    await this.client.close()
  }
}
