import { describe, expect, it } from 'vitest'
import { curveThresholdPerbill, perbillOfRational, PERBILL, referendaTracks, trackById, undecidingTimeoutBlocks } from './referendaTracks.ts'

// The pinned tracks (no RPC in unit tests, so referendaTracks() serves the
// fallback copy) must reproduce the runtime's own `referenda.tracks` constant,
// transcribed from Basilisk spec 134. The curve shape checks below pin the
// CONSTRUCTION anchors of the runtime's `make_linear` / `make_reciprocal` calls —
// the points the Rust const-eval solved for — so a mistranscribed parameter
// cannot pass.
//
// Every block count here is a duration at Basilisk's CURRENT 2s block, which spec
// 134 rescaled by 3 from the 6s era. The fallback is only reached when the node's
// RPC is down, so a stale copy shows every referendum the wrong pace at exactly
// the moment nothing can correct it.

const day = (n: number) => Math.round((n / 7) * PERBILL) // decision periods are 7 days

describe('referendaTracks (pinned fallback)', () => {
  it('carries the runtime track periods', () => {
    const treasurer = trackById(5)!
    expect(treasurer.name).toBe('treasurer')
    expect(treasurer.preparePeriod).toBe(1_800)     // 1 hour of 2s blocks
    expect(treasurer.decisionPeriod).toBe(302_400)  // 7 days
    expect(treasurer.confirmPeriod).toBe(21_600)    // 12 hours
    expect(treasurer.decisionDeposit).toBe('50000000000000000000') // 50M BSX (12 dec)
    expect(trackById(1)!.decisionPeriod).toBe(43_200) // whitelisted_caller: 1 day
    expect(referendaTracks()).toHaveLength(8)
    expect(trackById(99)).toBeNull()
  })

  it('undeciding timeout pins to 14 days of 2s blocks without a node', () => {
    expect(undecidingTimeoutBlocks()).toBe(604_800)
  })
})

describe('curveThresholdPerbill', () => {
  it('APP_RECIP = make_reciprocal(1, 7, 80%, 50%, 100%): near 100% at open, 80% after day 1, 50% at close', () => {
    const curve = trackById(5)!.minApproval
    expect(curveThresholdPerbill(curve, 0)).toBeGreaterThan(PERBILL - 10)
    expect(Math.abs(curveThresholdPerbill(curve, day(1)) - 0.8 * PERBILL)).toBeLessThan(10)
    expect(Math.abs(curveThresholdPerbill(curve, PERBILL) - 0.5 * PERBILL)).toBeLessThan(10)
  })

  it('SUP_LINEAR = make_linear(7, 7, 0%, 50%): 50% at open, halved mid-period, 0 at close', () => {
    const curve = trackById(5)!.minSupport // treasurer, and root
    expect(curveThresholdPerbill(curve, 0)).toBe(0.5 * PERBILL)
    expect(curveThresholdPerbill(curve, PERBILL / 2)).toBe(0.25 * PERBILL)
    expect(curveThresholdPerbill(curve, PERBILL)).toBe(0)
    expect(trackById(0)!.minSupport).toEqual(curve)
  })

  // whitelisted_caller's support bar is a linear curve, not a reciprocal: it opens
  // at 1% and reaches zero after a single day, which is what lets a whitelisted
  // referendum confirm on almost no turnout.
  it('SUP_WHITELISTED = make_linear(1, 7, 0%, 1%): 1% at open, 0 from day 1', () => {
    const curve = trackById(1)!.minSupport
    expect(curveThresholdPerbill(curve, 0)).toBe(0.01 * PERBILL)
    expect(Math.abs(curveThresholdPerbill(curve, day(1)))).toBeLessThan(10)
    expect(curveThresholdPerbill(curve, PERBILL)).toBe(0)
  })

  it('APP_LINEAR_FLAT = make_linear(4, 7, 50%, 100%): flat 50% from day 4', () => {
    const curve = trackById(7)!.minApproval // tipper
    expect(curveThresholdPerbill(curve, 0)).toBe(PERBILL)
    expect(Math.abs(curveThresholdPerbill(curve, day(2)) - 0.75 * PERBILL)).toBeLessThan(5)
    expect(Math.abs(curveThresholdPerbill(curve, day(4)) - 0.5 * PERBILL)).toBeLessThan(5)
    expect(curveThresholdPerbill(curve, day(6))).toBe(0.5 * PERBILL)
    expect(curveThresholdPerbill(curve, PERBILL)).toBe(0.5 * PERBILL)
  })

  it('SUP_RECIP = make_reciprocal(5, 7, 1%, 0%, 50%): 50% at open, 1% after day 5, clamps at 0', () => {
    const curve = trackById(6)!.minSupport // spender, and general_admin
    expect(Math.abs(curveThresholdPerbill(curve, 0) - 0.5 * PERBILL)).toBeLessThan(10)
    expect(Math.abs(curveThresholdPerbill(curve, day(5)) - 0.01 * PERBILL)).toBeLessThan(10)
    // Negative yOffset region: the raw curve dips below zero at the close and the
    // pallet clamps.
    expect(curveThresholdPerbill(curve, PERBILL)).toBe(0)
    expect(trackById(4)!.minSupport).toEqual(curve)
  })

  // The fast tracks reach the same 1% two days earlier, which is the whole
  // difference between them and the deliberative ones.
  it('SUP_FAST_RECIP = make_reciprocal(3, 7, 1%, 0%, 50%): 1% after day 3', () => {
    const curve = trackById(7)!.minSupport // tipper, canceller, killer
    expect(Math.abs(curveThresholdPerbill(curve, 0) - 0.5 * PERBILL)).toBeLessThan(100)
    expect(Math.abs(curveThresholdPerbill(curve, day(3)) - 0.01 * PERBILL)).toBeLessThan(10)
    expect(curveThresholdPerbill(curve, PERBILL)).toBe(0)
    expect(trackById(2)!.minSupport).toEqual(curve)
  })

  it('clamps x outside [0, 1]', () => {
    const curve = trackById(5)!.minSupport
    expect(curveThresholdPerbill(curve, -50)).toBe(0.5 * PERBILL)
    expect(curveThresholdPerbill(curve, 2 * PERBILL)).toBe(0)
  })
})

describe('perbillOfRational', () => {
  it('floors 21-digit planck ratios in BigInt', () => {
    // Real figures from OpenGov 383's Confirmed tally.
    const ayes = 2825554561793640949598n, nays = 8066804111818188671n
    // 2825554561793640949598 * 1e9 / 2833621365905459138269, floored.
    expect(perbillOfRational(ayes, ayes + nays)).toBe(997153182)
  })
  it('caps at 100% and rejects undefined ratios', () => {
    expect(perbillOfRational(5n, 2n)).toBe(PERBILL)
    expect(perbillOfRational(1n, 0n)).toBeNull()
  })
})
