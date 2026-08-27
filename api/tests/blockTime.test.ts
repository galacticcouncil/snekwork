import { describe, expect, it, vi } from 'vitest'
import {
  NOMINAL_BLOCKS_PER_HOUR, NOMINAL_PARA_BLOCK_MS, NOMINAL_RELAY_BLOCK_MS, RUNTIME_SLOT_MS_LADDER,
  avgBlockMsSql, blocksPerHour, clampBlockMs, dailyBlockCountSql, dailyBlockMs,
  decideParaBlockTime, measuredParaBlockMs, nominalBlockMsMismatch, resolveNominalBlockMs,
} from '../src/services/blockTime.ts'

vi.mock('../src/services/runtimeConstants.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/runtimeConstants.ts')>()),
  runtimeParaBlockMs: vi.fn(() => 2_000),
}))
import { paraBlockMsFromConstants } from '../src/services/runtimeConstants.ts'

// Basilisk's block time has been 12s, then 6s, and is 2s since spec 134.
// Everything derived from it either measures the chain or is pinned with a
// documented migration action; these pin the arithmetic that decides which.

// Spec 134 DECOUPLES the author slot from the block interval: SLOT_DURATION stays
// 6000 while MILLISECS_PER_BLOCK drops to 2000, and AllowMultipleBlocksPerSlot
// lets one author produce 3 blocks per slot. Read at blocks 8,000,000 and
// 13,000,000 (6s chains) and at the Aug-2026 head (a measured 2.2s chain),
// `aura.slotDuration` reads 6000 at all three — the one metadata constant that
// looks authoritative and silently is not. These pin the replacement: constants
// that are fixed WALL-CLOCK quantities expressed in blocks, which therefore
// divide out to the block time in whatever era the chain is in.
//
// Every literal below is a real value read off Basilisk at the spec named.
describe('paraBlockMsFromConstants', () => {
  // treasury.spendPeriod = 3d of blocks; convictionVoting.voteLockingPeriod = 7d.
  it('reads 12000 from the oldest era, where only the treasury constant exists', () => {
    // spec 105 predates OpenGov, so voteLockingPeriod is simply not published.
    expect(paraBlockMsFromConstants(21_600, null)).toBe(12_000)
  })

  it('reads 6000 from the pre-upgrade runtime', () => {
    expect(paraBlockMsFromConstants(43_200, 100_800)).toBe(6_000)
  })

  it('reads 2000 from spec 134, where aura.slotDuration still says 6000', () => {
    expect(paraBlockMsFromConstants(129_600, 302_400)).toBe(2_000)
  })

  it('works from either constant alone', () => {
    expect(paraBlockMsFromConstants(129_600, null)).toBe(2_000)
    expect(paraBlockMsFromConstants(null, 302_400)).toBe(2_000)
    expect(paraBlockMsFromConstants(null, null)).toBeNull()
  })

  // Disagreement means one of the two wall-clock premises (3d / 7d) changed.
  // Picking a side would silently rescale every projected date, so refuse and
  // let the caller fall back to the measured ladder.
  it('refuses when the two constants disagree rather than picking one', () => {
    expect(paraBlockMsFromConstants(129_600, 100_800)).toBeNull()
  })

  it('refuses a value that does not divide the wall-clock premise exactly', () => {
    expect(paraBlockMsFromConstants(7_000, null)).toBeNull()
    expect(paraBlockMsFromConstants(0, null)).toBeNull()
  })

  // system.blockHashCount was the Hydration derivation's other premise, a 4-hour
  // retention the runtime restated at each block-time change. Basilisk publishes
  // the bare substrate default and left it at 250 through BOTH of its changes, so
  // it holds no duration at all: a block time read out of it is invented, and
  // since metadata OUTRANKS every measurement, that invented value would win.
  // The reader is gone, and its absence is what this asserts — the arithmetic
  // cannot refuse an input it is still being handed.
  it('publishes no reader for a constant that carries no duration', async () => {
    const module = await import('../src/services/runtimeConstants.ts')
    expect(Object.keys(module)).not.toContain('runtimeBlockHashCount')
    expect(Object.keys(module)).toEqual(expect.arrayContaining(['runtimeSpendPeriodBlocks', 'runtimeVoteLockingPeriodBlocks']))
  })
})

describe('avgBlockMsSql', () => {
  it('averages the newest sample of indexed blocks', () => {
    const sql = avgBlockMsSql(100)
    expect(sql).toContain('price_data.blocks')
    expect(sql).not.toContain('price_data.raw_blocks')
    expect(sql).toContain('ORDER BY block_height DESC LIMIT 100')
    expect(sql).toContain("dateDiff('millisecond'")
    // count()-1 intervals between count() samples, and never a division by zero.
    expect(sql).toContain('greatest(count() - 1, 1)')
  })

  it('needs at least two blocks to have an interval at all', () => {
    expect(avgBlockMsSql(1)).toContain('LIMIT 2')
    expect(avgBlockMsSql(1000)).toContain('LIMIT 1000')
  })
})

describe('clampBlockMs', () => {
  it('passes a plausible measurement through unchanged', () => {
    // The pace actually measured on the live chain in Aug 2026.
    expect(clampBlockMs(2298)).toBe(2298)
    expect(clampBlockMs(4969.7)).toBe(4969.7)
  })

  it('falls back to the nominal for an unusable read', () => {
    for (const bad of [null, undefined, NaN, 0, -1, 100, 60_000, Infinity]) {
      expect(clampBlockMs(bad as number)).toBe(NOMINAL_PARA_BLOCK_MS)
    }
  })
})

describe('resolveNominalBlockMs', () => {
  // A measured pace is snapped to the runtime's slot ladder, so the value the
  // date projections ride on is a step function that moves exactly once — at
  // the runtime upgrade — instead of tracking throughput noise.
  it('keeps today’s pace on the 2s rung', () => {
    for (const measured of [1_700, 1_900, 2_000, 2_094, 2_220, 2_308, 2_600]) {
      expect(resolveNominalBlockMs(measured)).toBe(2_000)
    }
  })

  it('resolves the pre-upgrade 6s era’s pace to the 6s rung', () => {
    for (const measured of [4_806, 5_414, 5_588, 6_000, 6_534]) {
      expect(resolveNominalBlockMs(measured)).toBe(6_000)
    }
  })

  // The retired 12s rung is deliberately gone: the chain cannot return to it,
  // and keeping it turned a stall into a doubled date. A slow reading now
  // resolves to 6s and is separately rejected as out of band.
  it('does not resolve a stall to a retired 12s era', () => {
    expect(RUNTIME_SLOT_MS_LADDER).not.toContain(12_000)
    expect(resolveNominalBlockMs(10_454)).toBe(6_000)
    expect(nominalBlockMsMismatch(10_454)).not.toBeNull()
  })

  it('every rung resolves to itself', () => {
    for (const rung of RUNTIME_SLOT_MS_LADDER) expect(resolveNominalBlockMs(rung)).toBe(rung)
  })

  it('falls back to the nominal for an unusable measurement', () => {
    expect(resolveNominalBlockMs(0)).toBe(NOMINAL_PARA_BLOCK_MS)
  })
})

describe('nominalBlockMsMismatch', () => {
  it('stays quiet across the whole range real production covers', () => {
    for (const measured of [2_094, 2_220, 2_308, 1_900, 2_400, 4_806, 5_588, 6_000]) {
      expect(nominalBlockMsMismatch(measured)).toBeNull()
    }
  })

  // Measured over 600k blocks, aligned 100-block windows ranged 4454-10454ms.
  // The fast end is ordinary elastic scaling and must be accepted; the slow end
  // is a stall and must be rejected, because at 10 454ms a 12s-rung ladder used
  // to double every projected date.
  it('accepts the fast end of the observed range and rejects the slow end', () => {
    expect(nominalBlockMsMismatch(4_454)).toBeNull()
    expect(nominalBlockMsMismatch(10_454)).not.toBeNull()
  })

  it('names a slot time that is not on the ladder', () => {
    // 3.5s sits between the 6s and 2s rungs and is close to neither.
    const warning = nominalBlockMsMismatch(3_500)
    expect(warning).toContain('RUNTIME_SLOT_MS_LADDER')
    expect(warning).toContain('3500ms/block')
  })
})

describe('blocksPerHour', () => {
  it('matches the nominal constant at the nominal slot time', () => {
    expect(blocksPerHour(NOMINAL_PARA_BLOCK_MS)).toBe(NOMINAL_BLOCKS_PER_HOUR)
    expect(NOMINAL_BLOCKS_PER_HOUR).toBe(1_800)
  })

  it('tracks a slower chain', () => {
    expect(blocksPerHour(6_000)).toBe(600)
    expect(Math.round(blocksPerHour(2_298))).toBe(1_567)
  })

  it('degrades to the nominal rather than dividing by an absurd value', () => {
    expect(blocksPerHour(0)).toBe(NOMINAL_BLOCKS_PER_HOUR)
  })
})

describe('relay block time', () => {
  it('is Kusama’s own 6s and is not the parachain constant', () => {
    // Separate constants because only the parachain one moves at a block-time
    // upgrade — and it already has, twice, while this stayed at 6000.
    expect(NOMINAL_RELAY_BLOCK_MS).toBe(6_000)
    expect(NOMINAL_RELAY_BLOCK_MS).not.toBe(NOMINAL_PARA_BLOCK_MS)
  })
})

// ── the deposit fuse's period pin ───────────────────────────────────────────
// ── the wall-clock-anchored sample and the refusal to move ──────────────────
// A 100-block window can sit entirely inside one stall; a day cannot. Measured
// over 600k blocks, aligned 100-block windows ranged 4454-10454ms while the
// 24h-anchored figure stayed at ~5.6s throughout.
describe('dailyBlockCountSql', () => {
  it('counts a fixed span of wall clock, not a fixed number of blocks', () => {
    const sql = dailyBlockCountSql()
    expect(sql).toContain('INTERVAL 24 HOUR')
    expect(sql).toContain('price_data.blocks')
    expect(sql).toContain('count()')
    expect(sql).not.toContain('LIMIT')
  })
})

describe('dailyBlockMs', () => {
  it('turns a day of blocks into a per-block average', () => {
    expect(dailyBlockMs(14_400)).toBe(6_000)
    expect(dailyBlockMs(43_200)).toBe(2_000)
    // A day at the live Aug 2026 pace of ~2.3s.
    expect(Math.round(dailyBlockMs(37_600) as number)).toBe(2_298)
  })

  it('refuses a sample too small to be a day of chain', () => {
    for (const n of [null, undefined, NaN, 0, -1, 999]) expect(dailyBlockMs(n as number)).toBeNull()
  })

  it('refuses an implausible average instead of substituting one', () => {
    // 2000 blocks/day = 43.2s per block: a stalled or half-ingested day.
    expect(dailyBlockMs(2_000)).toBeNull()
  })
})

describe('decideParaBlockTime', () => {
  it('prefers runtime metadata over any measurement', () => {
    const d = decideParaBlockTime(2_000, 5_588, 6_000)
    expect(d.nominalMs).toBe(2_000)
    expect(d.source).toBe('metadata')
    // ...and says so, because every hand-pinned block count now needs re-pinning.
    expect(d.warning).toContain('SECURITY_FUSE_PERIOD_BLOCKS')
  })

  it('is quiet when metadata confirms what was already held', () => {
    expect(decideParaBlockTime(6_000, 5_588, 6_000).warning).toBeNull()
  })

  it('infers from a good measurement when metadata is unavailable', () => {
    const d = decideParaBlockTime(null, 5_588, null)
    expect(d).toMatchObject({ nominalMs: 6_000, source: 'measured', warning: null })
  })

  // THE load-bearing guard: an out-of-band sample must not MOVE the value. The
  // reviewer's 600k-block sweep found ~1% of 100-block windows above the old
  // 6s/12s boundary; holding is what keeps such a moment from rescaling every
  // projected date and republishing the whole lock snapshot.
  it('holds the previous value on an out-of-band measurement instead of moving', () => {
    const d = decideParaBlockTime(null, 10_454, 6_000)
    expect(d.nominalMs).toBe(6_000)
    expect(d.source).toBe('held')
    expect(d.measuredMs).toBe(10_454)
    expect(d.warning).toContain('holding 6000ms/block rather than moving')
  })

  it('holds a 2s resolution through a stall just as firmly', () => {
    const d = decideParaBlockTime(null, 9_000, 2_000)
    expect(d.nominalMs).toBe(2_000)
    expect(d.source).toBe('held')
  })

  it('holds, and reports null, when the chain cannot be measured at all', () => {
    const d = decideParaBlockTime(null, null, 2_000)
    expect(d).toMatchObject({ nominalMs: 2_000, source: 'held', measuredMs: null })
    expect(d.warning).toContain('could not be measured')
  })

  it('starts from the nominal before anything has been established', () => {
    expect(decideParaBlockTime(null, null, null).nominalMs).toBe(NOMINAL_PARA_BLOCK_MS)
    expect(decideParaBlockTime(null, 10_454, null).nominalMs).toBe(NOMINAL_PARA_BLOCK_MS)
  })

  it('still moves when the chain genuinely upgrades and metadata is down', () => {
    const d = decideParaBlockTime(null, 1_990, 6_000)
    expect(d).toMatchObject({ nominalMs: 2_000, source: 'measured' })
  })
})

describe('measuredParaBlockMs degradation', () => {
  it('degrades a failed measurement to the runtime-reported nominal, not the constant', async () => {
    // With the mocked runtime on a 2s slot, one broken 100-block read must not
    // report 6s throughput for a cache window on a 2s chain.
    const failing = { query: vi.fn(async () => { throw new Error('clickhouse down') }) }
    await expect(measuredParaBlockMs(failing as never)).resolves.toBe(2_000)
  })
})
