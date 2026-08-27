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
   */
  async getXYKPools(block: Block): Promise<XYKPoolEntry[] | null> {
    if (!storage.xyk.poolAssets.v183.is(block)) {
      if (this.xykSupported) throw new Error(`Unsupported XYK.PoolAssets storage at block ${block.height}`)
      return null
    }
    this.xykSupported = true
    if (!this.xykBootstrapped) {
      const pairs = await storage.xyk.poolAssets.v183.getPairs(block)
      this.xykPools = pairs
        .filter(([_, assetPair]) => assetPair !== undefined)
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
