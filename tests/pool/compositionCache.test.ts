import { afterEach, describe, expect, it, vi } from 'vitest'
import { PoolCompositionCache } from '../../src/pool/compositionCache.ts'

interface CacheState {
  xykPools: Array<{ poolAccount: string; assetA: number; assetB: number }> | null
}

function state(cache: PoolCompositionCache): CacheState {
  return cache as unknown as CacheState
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PoolCompositionCache incremental updates', () => {
  it('keeps replayed creation events idempotent', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const cache = new PoolCompositionCache()
    state(cache).xykPools = []
    const events = [
      { name: 'XYK.PoolCreated', args: { pool: '0xpool', assetA: 1, assetB: 2 } },
    ]

    cache.processEvents(events)
    cache.processEvents(events)

    expect(state(cache).xykPools).toEqual([{ poolAccount: '0xpool', assetA: 1, assetB: 2 }])
  })

  it('updates a replayed pool identity without duplicating it', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const cache = new PoolCompositionCache()
    state(cache).xykPools = [{ poolAccount: '0xpool', assetA: 1, assetB: 2 }]

    cache.processEvents([{
      name: 'XYK.PoolCreated',
      args: { pool: '0xpool', assetA: 3, assetB: 4 },
    }])

    expect(state(cache).xykPools).toEqual([{ poolAccount: '0xpool', assetA: 3, assetB: 4 }])
  })

  it('removes a destroyed pool', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const cache = new PoolCompositionCache()
    state(cache).xykPools = [{ poolAccount: '0xpool', assetA: 1, assetB: 2 }]

    const { xykChanged } = cache.processEvents([{
      name: 'XYK.PoolDestroyed',
      args: { pool: '0xpool', assetA: 1, assetB: 2 },
    }])

    expect(xykChanged).toBe(true)
    expect(state(cache).xykPools).toEqual([])
  })

  it('fails closed on malformed composition events', () => {
    const cache = new PoolCompositionCache()
    state(cache).xykPools = []

    expect(() => cache.processEvents([{
      name: 'XYK.PoolCreated',
      args: { pool: '0xpool', assetA: 'not-a-number', assetB: 2 },
    }])).toThrow('XYK.PoolCreated.assetA is not a non-negative integer')
  })
})
