import { describe, expect, it } from 'vitest'
import { foldPoolLpEntries, shareFraction } from '../src/services/poolService.ts'

// The LP ranking rests on an integer fold whose invariant must hold under
// replay and races: attributed farm custody REPLACES the pot's balance, so the
// total is conserved, never scaled or double-counted.

const POT = '0xpot'

describe('foldPoolLpEntries', () => {
  it('replaces the pot custody with the attributed owners and conserves the total', () => {
    const direct = [
      { accountId: '0xaaa', balance: 100n },
      { accountId: POT, balance: 30n },
      { accountId: '0xbbb', balance: 5n },
    ]
    const farmed = [
      { accountId: '0xbbb', shares: 20n },
      { accountId: '0xccc', shares: 10n },
    ]
    const out = foldPoolLpEntries(direct, farmed, POT)
    // The pot's 30 was fully attributed, so it disappears; nothing is scaled.
    expect(out.map(e => [e.accountId, e.shares, e.farmedShares])).toEqual([
      ['0xaaa', 100n, 0n],
      ['0xbbb', 25n, 20n],
      ['0xccc', 10n, 10n],
    ])
    const total = out.reduce((s, e) => s + e.shares, 0n)
    expect(total).toBe(100n + 30n + 5n)
  })

  it('keeps an uncovered pot remainder visible instead of scaling it away', () => {
    const out = foldPoolLpEntries(
      [{ accountId: POT, balance: 50n }],
      [{ accountId: '0xaaa', shares: 30n }],
      POT,
    )
    expect(out).toEqual([
      { accountId: '0xaaa', shares: 30n, farmedShares: 30n },
      { accountId: POT, shares: 20n, farmedShares: 0n },
    ])
    expect(out.reduce((s, e) => s + e.shares, 0n)).toBe(50n)
  })

  it('never lets attribution exceed the pot custody (no fabricated shares)', () => {
    // The pot holds less than the intervals attribute (a mid-block race):
    // the pot clamps to zero, the owners keep their attributed principal.
    const out = foldPoolLpEntries(
      [{ accountId: POT, balance: 10n }],
      [{ accountId: '0xaaa', shares: 30n }],
      POT,
    )
    expect(out).toEqual([{ accountId: '0xaaa', shares: 30n, farmedShares: 30n }])
  })

  it('folds through the account resolver and drops zero balances', () => {
    const out = foldPoolLpEntries(
      [
        { accountId: '0xETHPOT', balance: 7n },
        { accountId: '0xreal', balance: 3n },
        { accountId: '0xzero', balance: 0n },
      ],
      [],
      POT,
      id => (id === '0xETHPOT' ? '0xreal' : id),
    )
    expect(out).toEqual([{ accountId: '0xreal', shares: 10n, farmedShares: 0n }])
  })

  it('orders by shares descending with a deterministic tie-break', () => {
    const out = foldPoolLpEntries(
      [
        { accountId: '0xbbb', balance: 5n },
        { accountId: '0xaaa', balance: 5n },
        { accountId: '0xccc', balance: 9n },
      ],
      [], POT,
    )
    expect(out.map(e => e.accountId)).toEqual(['0xccc', '0xaaa', '0xbbb'])
  })
})

describe('shareFraction', () => {
  it('is exact for magnitudes beyond float precision', () => {
    // A quarter of a 24-digit total — Number(shares)/Number(total) would drift.
    const total = 4130532643919634582019372n
    expect(shareFraction(total / 4n, total)).toBe(0.25)
  })
  it('returns null for a zero or negative total (destroyed pool), never NaN', () => {
    expect(shareFraction(5n, 0n)).toBeNull()
  })
  it('sums to at most 1 across a full holder set', () => {
    const total = 1000000000000000000n
    const parts = [total / 2n, total / 3n, total - total / 2n - total / 3n]
    const sum = parts.reduce((s, p) => s + (shareFraction(p, total) ?? 0), 0)
    expect(sum).toBeLessThanOrEqual(1)
    expect(sum).toBeGreaterThan(0.999999)
  })
})
