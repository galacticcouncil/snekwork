import { describe, expect, it } from 'vitest'
import {
  minutesForLegacyBlockInterval,
  MS_PER_MINUTE,
  shouldRunOnElapsedChainTime,
} from '../../src/util/chainTimeCadence.ts'

const HOUR = 60 * MS_PER_MINUTE
const TWELVE_HOURS = 12 * HOUR

// Chain time, not block count, is what makes these triggers survive a block-time
// change: the same wall-clock cadence comes out at 6s, 2s, or anything else.
describe('elapsed chain-time trigger (asset registry scan)', () => {
  const interval = 100 * MS_PER_MINUTE

  it('runs on the first evaluation, whatever the timestamp', () => {
    expect(shouldRunOnElapsedChainTime(null, Date.UTC(2026, 0, 1), interval)).toBe(true)
    expect(shouldRunOnElapsedChainTime(null, undefined, interval)).toBe(true)
  })

  it('waits until a full interval of chain time has passed', () => {
    const last = Date.UTC(2026, 0, 1, 0, 0, 0)
    expect(shouldRunOnElapsedChainTime(last, last + interval - 1, interval)).toBe(false)
    expect(shouldRunOnElapsedChainTime(last, last + interval, interval)).toBe(true)
  })

  // The point of the change: the same interval covers 3x the blocks at 2s and the
  // scan rate per unit of chain time does not move.
  it('fires at the same chain times whatever the block cadence', () => {
    const start = Date.UTC(2026, 0, 1)
    const runsAt = (blockMs: number): number[] => {
      const fired: number[] = []
      let last: number | null = null
      for (let t = start; t < start + 24 * HOUR; t += blockMs) {
        if (shouldRunOnElapsedChainTime(last, t, interval)) {
          fired.push(t)
          last = t
        }
      }
      return fired
    }

    const atSixSeconds = runsAt(6_000)
    const atTwoSeconds = runsAt(2_000)
    expect(atSixSeconds.length).toBe(atTwoSeconds.length)
    expect(atSixSeconds).toEqual(atTwoSeconds)
  })

  // Only genesis has no timestamp; it must not become a per-block scan trigger.
  it('does not trigger on a block with no chain clock', () => {
    const last = Date.UTC(2026, 0, 1)
    expect(shouldRunOnElapsedChainTime(last, undefined, interval)).toBe(false)
    expect(shouldRunOnElapsedChainTime(last, null, interval)).toBe(false)
  })
})

describe('legacy block-count intervals', () => {
  it('reads the deployed block counts as the durations they stood for at 6s', () => {
    expect(minutesForLegacyBlockInterval(7_200)).toBe(720) // 12h
    expect(minutesForLegacyBlockInterval(1_000)).toBe(100) // asset registry, live
    expect(minutesForLegacyBlockInterval(10_000)).toBe(1_000) // asset registry, backfill
  })

  it('never collapses a positive interval to zero', () => {
    expect(minutesForLegacyBlockInterval(1)).toBe(1)
  })
})
