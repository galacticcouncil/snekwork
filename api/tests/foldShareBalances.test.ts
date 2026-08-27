import { describe, it, expect, vi } from 'vitest'

// Per-account display fold: a held receipt token is shown as the asset it stands
// for, its balance merged into that asset's row. Basilisk registers no such token —
// its only derived asset is the XYK share, and an LP share is a claim on TWO
// reserves, so no single asset displays it — which means the live table is empty and
// the fold is a no-op on every real account.
//
// An empty table is exactly why the fold is exercised against an INJECTED one here.
// The merge is not trivial: it sums 128-bit balances, rescales across a decimal
// difference, and must leave unfolded assets alone — and a bug in any of that would
// silently mis-state a portfolio the day the first entry is added, with no test to
// catch it because no real account would have triggered the path.
const FOLD: Record<number, number> = { 690: 69, 4200: 420, 90001: 9001, 111: 11 }
// 111 → 11 is the pair that does NOT share decimals (18 vs 6).
const DECIMALS: Record<number, number> = { 690: 18, 69: 18, 4200: 18, 420: 18, 90001: 9, 9001: 9, 111: 18, 11: 6, 5: 12, 0: 12 }

vi.mock('../src/services/explorerAssets.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/explorerAssets.ts')>()
  return {
    ...actual,
    SHARE_TOKEN_UNDERLYING_ID: FOLD,
    displayAssetId: (id: number) => FOLD[id] ?? id,
    assetDescriptor: (id: number) => ({
      assetId: id, iconAssetId: id, symbol: `#${id}`, name: null,
      decimals: DECIMALS[id] ?? 12, parachainId: null, origin: null,
    }),
  }
})

const { foldShareBalances } = await import('../src/services/explorerService.ts')
const { assetDescriptor } = await import('../src/services/explorerAssets.ts')
type AddressBalance = import('../src/services/explorerService.ts').AddressBalance

const bal = (assetId: number, total: string, valueUsd: number | null): AddressBalance =>
  ({ asset: assetDescriptor(assetId), total, free: total, reserved: '0', lastBlock: 1, valueUsd })

describe('foldShareBalances', () => {
  it('relabels a lone folded holding as its display asset', () => {
    const out = foldShareBalances([bal(690, '100', 100)])
    expect(out).toHaveLength(1)
    expect(out[0].asset.assetId).toBe(69)
    expect(out[0].total).toBe('100')
    expect(out[0].valueUsd).toBe(100)
  })

  it('merges a folded holding into an existing display row (sums total + value)', () => {
    const out = foldShareBalances([bal(69, '30', 30), bal(690, '100', 100)])
    expect(out).toHaveLength(1)
    expect(out[0].asset.assetId).toBe(69)
    expect(out[0].total).toBe('130')
    expect(out[0].valueUsd).toBe(130)
  })

  it('merges regardless of order and uses big-integer addition', () => {
    const big = '9490407169607873746'
    const out = foldShareBalances([bal(4200, big, 16000), bal(420, '33341836379303215', 56)])
    expect(out).toHaveLength(1)
    expect(out[0].asset.assetId).toBe(420)
    expect(out[0].total).toBe((BigInt(big) + 33341836379303215n).toString())
    expect(out[0].valueUsd).toBe(16056)
  })

  it('folds multiple families independently and leaves other assets untouched', () => {
    const out = foldShareBalances([bal(690, '1', 1), bal(90001, '2', 2), bal(5, '3', 3)])
    const ids = out.map(b => b.asset.assetId).sort((a, b) => a - b)
    expect(ids).toEqual([5, 69, 9001])
  })

  // The two sides of a fold need not share decimals, and summing raw integers across
  // a scale difference is off by 10^Δ — a whole portfolio's worth of error.
  it('rescales a folded raw balance to the display asset\'s decimals', () => {
    const out = foldShareBalances([bal(11, '1000000', 1), bal(111, '1000000000000000000', 1)])
    expect(out).toHaveLength(1)
    expect(out[0].asset.assetId).toBe(11)
    expect(out[0].asset.decimals).toBe(6)
    // One unit at 18 decimals plus one unit at 6 is two units, not 1e18 + 1e6.
    expect(out[0].total).toBe('2000000')
  })

  it('is a no-op (same array reference) when nothing held folds', () => {
    const input = [bal(5, '10', 10), bal(0, '20', 20)]
    expect(foldShareBalances(input)).toBe(input)
  })
})
