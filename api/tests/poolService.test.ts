import { describe, expect, it } from 'vitest'
import {
  buildComposition,
  carrySeries,
  dailyGrid,
  foldTopSeries,
  rankPools,
  type AssetLiquiditySeries,
} from '../src/services/poolService.ts'
import type { PriceInfo } from '../src/services/explorerService.ts'

const prices = (entries: [number, number][]): Map<number, PriceInfo> =>
  new Map(entries.map(([id, price]) => [id, { price, change24h: 0 }]))

describe('buildComposition', () => {
  // Unregistered test asset ids fall back to 12 decimals in the registry.
  it('values every leg and computes USD shares when all legs are priced', () => {
    const { entries, tvlUsd } = buildComposition(prices([[7, 2], [9, 1]]), [
      { assetId: 7, raw: 1_000_000_000_000n },   // 1.0 → $2
      { assetId: 9, raw: 2_000_000_000_000n },   // 2.0 → $2
    ])
    expect(tvlUsd).toBeCloseTo(4)
    expect(entries[0].sharePct).toBeCloseTo(50)
    expect(entries[1].usd).toBeCloseTo(2)
    expect(entries[0].amount).toBe('1000000000000')
  })

  it('returns null TVL and null shares when any leg is unpriced — never a partial sum', () => {
    const { entries, tvlUsd } = buildComposition(prices([[7, 2]]), [
      { assetId: 7, raw: 1_000_000_000_000n },
      { assetId: 9, raw: 2_000_000_000_000n },
    ])
    expect(tvlUsd).toBeNull()
    expect(entries[0].usd).toBeCloseTo(2)   // the priced leg keeps its own value
    expect(entries[0].sharePct).toBeNull()
    expect(entries[1].usd).toBeNull()
  })
})

describe('dailyGrid', () => {
  it('builds an inclusive continuous day axis', () => {
    expect(dailyGrid('2026-02-27', '2026-03-02')).toEqual(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02'])
  })

  it('returns empty on malformed bounds', () => {
    expect(dailyGrid('nope', '2026-03-02')).toEqual([])
  })
})

describe('carrySeries', () => {
  const grid = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05']

  it('carries the last value forward only inside the sampled range', () => {
    const points = new Map([['2026-01-02', 10], ['2026-01-04', 20]])
    expect(carrySeries(grid, points)).toEqual([null, 10, 10, 20, null])
  })

  it('extends a live series to lastDay but never before its first sample', () => {
    const points = new Map([['2026-01-02', 10]])
    expect(carrySeries(grid, points, '2026-01-05')).toEqual([null, 10, 10, 10, 10])
  })

  it('a destroyed series ends at its last sample instead of forward-filling to now', () => {
    const points = new Map([['2026-01-01', 5], ['2026-01-02', 7]])
    expect(carrySeries(grid, points)).toEqual([5, 7, null, null, null])
  })
})

describe('foldTopSeries', () => {
  const s = (key: string, amounts: (number | null)[]): AssetLiquiditySeries => ({
    key, label: key, amounts, usd: amounts.map(a => (a == null ? null : a * 2)),
  })

  it('keeps the top N by peak amount and folds the rest into Other', () => {
    const folded = foldTopSeries([s('a', [1, 2]), s('b', [9, 1]), s('c', [3, 3]), s('d', [0, 1])], 2)
    expect(folded.map(x => x.key)).toEqual(['b', 'c', 'other'])
    const other = folded[2]
    expect(other.amounts).toEqual([1, 3])   // a + d, null-safe
    expect(other.usd).toEqual([2, 6])
  })

  it('leaves small sets untouched', () => {
    const input = [s('a', [1]), s('b', [2])]
    expect(foldTopSeries(input, 5)).toBe(input)
  })

  it('treats all-null buckets in the fold as null, not zero', () => {
    const folded = foldTopSeries([s('a', [5, 5]), s('b', [4, 4]), s('c', [null, 1]), s('d', [null, null])], 2)
    const other = folded[2]
    expect(other.amounts).toEqual([null, 1])
  })
})

// Composition bands must survive a full rotation of the pool: an asset that
// dominated years ago but has left (DOT) and a young asset that is large today
// both get their own band; ranking by the endpoint would erase the past era,
// ranking by peak USD would erase the present one under a shrunken TVL.
// The /liquidity index ranks every venue by what it holds. Two rules carry it,
// and both matter more than they look: 278 of the chain's 307 pools cannot be
// priced at all (XYK pairs of tokens nothing trades), so dropping the unpriced
// would quietly delete most of the list, while counting them as zero would rank
// them among the genuinely empty as if that had been measured.
describe('rankPools', () => {
  const pool = (name: string, tvlUsd: number | null) =>
    ({ kind: 'xyk' as const, poolId: 1, name, tvlUsd, sharePct: null, composition: [], hasPegs: false })

  it('puts the largest pool first', () => {
    const { pools } = rankPools([pool('small', 10), pool('large', 1000), pool('mid', 100)])
    expect(pools.map(p => p.name)).toEqual(['large', 'mid', 'small'])
  })

  it('keeps an unpriced pool, ranked below every priced one — including the empty', () => {
    const { pools } = rankPools([pool('unpriced', null), pool('empty', 0), pool('held', 5)])
    expect(pools.map(p => p.name)).toEqual(['held', 'empty', 'unpriced'])
  })

  it('shares out of everything pooled, and says nothing about a pool it cannot price', () => {
    const { totalTvlUsd, pools } = rankPools([pool('a', 75), pool('b', 25), pool('c', null)])
    expect(totalTvlUsd).toBe(100)
    expect(pools[0].sharePct).toBeCloseTo(75)
    expect(pools[1].sharePct).toBeCloseTo(25)
    expect(pools[2].sharePct).toBeNull()
  })

  it('has no total when nothing can be priced, and claims no shares', () => {
    const { totalTvlUsd, pools } = rankPools([pool('a', null), pool('b', null)])
    expect(totalTvlUsd).toBeNull()
    for (const p of pools) expect(p.sharePct).toBeNull()
  })

  it('leaves the callers array alone', () => {
    const input = [pool('small', 1), pool('large', 2)]
    rankPools(input)
    expect(input.map(p => p.name)).toEqual(['small', 'large'])
  })
})
