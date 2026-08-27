import type { Block } from '../types/support.ts'
import * as storage from '../types/storage.ts'

interface XYKPoolEntry {
  poolAccount: string  // AccountId32 hex
  assetA: number
  assetB: number
}

function eventArgs(value: unknown, eventName: string): Record<string, unknown> {
  if (value == null || typeof value !== 'object') {
    throw new Error(`${eventName} has no decodable arguments`)
  }
  return value as Record<string, unknown>
}

// Basilisk's XYK lifecycle events were positional tuples until spec 55 (block
// 1,322,823) — v16 carries [who, assetA, assetB, shares] with no pool account at
// all, v19 appends [shareToken, pool]. The surgical cache update below reads the
// named fields of the modern (v55+) struct, so anything that is not that shape
// falls back to a full re-read of XYK.PoolAssets, which is era-agnostic. Decoding
// the tuple forms in place is left to the legacy-decode phase.
function isModernLifecycleArgs(args: Record<string, unknown>): boolean {
  return !Array.isArray(args) && typeof args.pool === 'string'
}

function numberArg(args: Record<string, unknown>, name: string, eventName: string): number {
  const value = args[name]
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${eventName}.${name} is not a non-negative integer`)
  }
  return value as number
}

function stringArg(args: Record<string, unknown>, name: string, eventName: string): string {
  const value = args[name]
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${eventName}.${name} is not a non-empty string`)
  }
  return value
}

interface XYKPoolAssetsCodec {
  getPairs(block: Block): Promise<[k: string, v: ([number, number] | undefined)][]>
}

/**
 * Basilisk has two XYK.PoolAssets shapes: the genesis-era v16 codec (a `Default`
 * map to an [AssetId, AssetId] tuple) and the v25 codec from spec 25 (block
 * 395,664) onward (an `Optional` map to [u32, u32]). Both decode a pool account
 * to the same pair of numbers, so only codec selection differs. Returns null
 * when neither matches — the caller decides whether that is "not launched yet"
 * or a regression.
 */
function xykPoolAssetsCodec(block: Block): XYKPoolAssetsCodec | null {
  if (storage.xyk.poolAssets.v25.is(block)) return storage.xyk.poolAssets.v25
  if (storage.xyk.poolAssets.v16.is(block)) return storage.xyk.poolAssets.v16
  return null
}

export class PoolCompositionCache {
  // XYK: list of pool entries (account -> asset pair)
  private xykPools: XYKPoolEntry[] | null = null

  // Track whether bootstrap has been done
  private xykBootstrapped = false
  // A pallet can legitimately be absent before launch. Once a codec has worked,
  // however, losing compatibility after a runtime upgrade must fail closed
  // instead of turning a live pool family into an empty/stale snapshot.
  private xykSupported = false

  /**
   * Process events from a block to update cache.
   * Call this BEFORE reading pool state for the block.
   * Returns flags indicating which caches were invalidated.
   */
  processEvents(events: Array<{ name: string; args: unknown }>): { xykChanged: boolean } {
    let xykChanged = false

    for (const event of events) {
      switch (event.name) {
        case 'XYK.PoolCreated': {
          const args = eventArgs(event.args, event.name)
          if (!isModernLifecycleArgs(args)) {
            this.xykBootstrapped = false
            this.xykPools = null
            xykChanged = true
            break
          }
          // Surgical add: push new pool entry
          if (this.xykPools !== null) {
            const entry = {
              poolAccount: stringArg(args, 'pool', event.name),
              assetA: numberArg(args, 'assetA', event.name),
              assetB: numberArg(args, 'assetB', event.name),
            }
            const existingIndex = this.xykPools.findIndex(pool => pool.poolAccount === entry.poolAccount)
            if (existingIndex < 0) {
              this.xykPools.push(entry)
              console.log(`[PoolCache] Incremental: XYK pool created (assetA=${entry.assetA}, assetB=${entry.assetB})`)
            } else {
              this.xykPools[existingIndex] = entry
            }
          }
          xykChanged = true
          break
        }
        case 'XYK.PoolDestroyed': {
          const args = eventArgs(event.args, event.name)
          if (!isModernLifecycleArgs(args)) {
            this.xykBootstrapped = false
            this.xykPools = null
            xykChanged = true
            break
          }
          const poolAccount = stringArg(args, 'pool', event.name)
          // Surgical remove: filter out pool by account
          if (this.xykPools !== null) {
            this.xykPools = this.xykPools.filter(p => p.poolAccount !== poolAccount)
            console.log(`[PoolCache] Incremental: XYK pool destroyed (assetA=${numberArg(args, 'assetA', event.name)}, assetB=${numberArg(args, 'assetB', event.name)})`)
          }
          xykChanged = true
          break
        }
      }
    }

    return { xykChanged }
  }

  /**
   * Invalidate all cached pool compositions.
   * Called on runtime upgrades where storage migrations may have
   * changed pool compositions without emitting events.
   */
  invalidateAll(): void {
    this.xykBootstrapped = false
    this.xykPools = null
    console.log('[PoolCache] All caches invalidated (runtime upgrade)')
  }

  /**
   * Get XYK pool entries. Bootstraps from storage on first call.
   *
   * Basilisk has two XYK.PoolAssets shapes: the genesis-era v16 codec (a
   * `Default` map to a [AssetId, AssetId] tuple) and the v25 codec from spec 25
   * (block 395,664) onward (an `Optional` map to [u32, u32]). Both decode to the
   * same pair of numbers, so only the codec selection differs.
   */
  async getXYKPools(block: Block): Promise<XYKPoolEntry[] | null> {
    const poolAssets = xykPoolAssetsCodec(block)
    if (poolAssets == null) {
      if (this.xykSupported) throw new Error(`Unsupported XYK.PoolAssets storage at block ${block.height}`)
      return null
    }
    this.xykSupported = true
    if (!this.xykBootstrapped) {
      const pairs = await poolAssets.getPairs(block)
      this.xykPools = pairs
        .filter(([, assetPair]) => assetPair !== undefined)
        .map(([poolAccount, assetPair]) => ({
          poolAccount: poolAccount as string,
          assetA: assetPair![0],
          assetB: assetPair![1],
        }))
      this.xykBootstrapped = true
      console.log(`[PoolCache] Bootstrap xyk at block ${block.height}: ${this.xykPools.length} pools`)
    }
    return this.xykPools
  }
}
