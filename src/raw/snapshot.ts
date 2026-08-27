import { xxhashAsHex } from '@polkadot/util-crypto'
import type { AssetMetadata } from '../registry/types.ts'
import type { Block } from '../types/support.ts'
import * as storage from '../types/storage.ts'
import { toClickHouseDateTime } from './json.js'
import type {
  SnapshotPayload,
  SnapshotState,
  SnapshotXykPoolState,
} from './types.js'
import { forEachConcurrent } from '../util/collections.js'

const POOL_STORAGE_PREFIXES = [
  'Tokens', 'XYK',
].map(name => xxhashAsHex(name, 128).slice(2))

function snapshotReadBatchSize(): number {
  const configured = Number.parseInt(process.env.RAW_SNAPSHOT_READ_BATCH_SIZE ?? '100', 10)
  return Number.isSafeInteger(configured) && configured > 0 ? Math.min(configured, 500) : 100
}

function snapshotReadBatchConcurrency(): number {
  const configured = Number.parseInt(process.env.RAW_SNAPSHOT_READ_BATCH_CONCURRENCY ?? '2', 10)
  return Number.isSafeInteger(configured) && configured > 0 ? Math.min(configured, 8) : 2
}

function chunkIndexed<T>(items: T[], size: number): Array<Array<{ item: T; index: number }>> {
  const chunks: Array<Array<{ item: T; index: number }>> = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size).map((item, offset) => ({ item, index: index + offset })))
  }
  return chunks
}

async function getManyChunked<K, V>(
  keys: K[],
  read: (keys: K[]) => Promise<V[]>,
): Promise<V[]> {
  if (keys.length === 0) return []
  const results = new Array<V>(keys.length)
  const chunks = chunkIndexed(keys, snapshotReadBatchSize())
  await forEachConcurrent(chunks, snapshotReadBatchConcurrency(), async (chunk) => {
    const values = await read(chunk.map(({ item }) => item))
    for (let index = 0; index < chunk.length; index++) {
      results[chunk[index].index] = values[index]
    }
  })
  return results
}

export function detectPoolAffectingSetStorage(calls: Array<{ name?: string; args?: unknown }>): boolean {
  for (const call of calls) {
    if (call.name !== 'System.set_storage') continue

    const items = (call.args as { items?: Array<[string, string]> } | undefined)?.items
    if (items == null) continue

    for (const [key] of items) {
      const prefix = key.startsWith('0x') ? key.slice(2, 34) : key.slice(0, 32)
      if (POOL_STORAGE_PREFIXES.some(value => value === prefix)) {
        return true
      }
    }
  }

  return false
}

export async function readXYKState(
  block: Block,
  pools: Array<{ poolAccount: string; assetA: number; assetB: number }>
): Promise<SnapshotXykPoolState[]> {
  if (!storage.tokens.accounts.v108.is(block)) {
    throw new Error(`Unsupported Tokens.Accounts storage for XYK pools at block ${block.height}`)
  }

  const keys: [string, number][] = []
  for (const pool of pools) {
    keys.push([pool.poolAccount, pool.assetA])
    keys.push([pool.poolAccount, pool.assetB])
  }

  const balances = await getManyChunked(keys, page => storage.tokens.accounts.v108.getMany(block, page))
  return pools.map((pool, index) => {
    const balanceA = balances[index * 2]
    const balanceB = balances[index * 2 + 1]
    return {
      pool_account: pool.poolAccount,
      asset_a: pool.assetA,
      asset_b: pool.assetB,
      reserve_a: (balanceA?.free ?? 0n).toString(),
      reserve_b: (balanceB?.free ?? 0n).toString(),
    }
  })
}

export function buildSnapshotState(input: {
  assets: AssetMetadata[]
  xykPools: SnapshotXykPoolState[]
}): SnapshotState {
  return {
    assets: [...input.assets].sort((a, b) => a.assetId - b.assetId),
    xyk_pools: [...input.xykPools].sort((a, b) => a.pool_account.localeCompare(b.pool_account)),
  }
}

export function buildSnapshotPayload(
  block: { height: number; hash: string; timestamp?: number; specVersion: number },
  state: SnapshotState
): SnapshotPayload {
  return {
    schema_version: 1,
    block: {
      height: block.height,
      hash: block.hash,
      timestamp: toClickHouseDateTime(block.timestamp, block.height),
      spec_version: block.specVersion,
    },
    assets: {
      items: state.assets.map(asset => ({ ...asset })),
    },
    xyk: {
      pools: state.xyk_pools.map(pool => ({ ...pool })),
    },
  }
}
