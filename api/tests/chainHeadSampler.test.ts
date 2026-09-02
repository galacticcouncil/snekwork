import { describe, expect, it } from 'vitest'
import { createChainHeadSampler, settleWithin } from '../src/services/chainHeadSampler.ts'

/** a controllable clock, so staleness and deadlines are tested without waiting */
function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

const TIMEOUT = 10_000
const STALE = 60_000

describe('chain head sampler', () => {
  it('exposes a fresh sample after a successful refresh', async () => {
    const c = clock()
    const s = createChainHeadSampler({
      fetchHeight: async () => 17_000_000,
      timeoutMs: TIMEOUT, staleMs: STALE, now: c.now,
    })
    await s.refresh()
    expect(s.current()).toEqual({ height: 17_000_000, ageMs: 0 })
  })

  it('keeps the last good height while a later refresh answers nothing', async () => {
    const c = clock()
    let answer: number | null = 17_000_000
    const s = createChainHeadSampler({
      fetchHeight: async () => answer,
      timeoutMs: TIMEOUT, staleMs: STALE, now: c.now,
    })
    await s.refresh()
    answer = null
    c.advance(5_000)
    await s.refresh()
    expect(s.current()).toEqual({ height: 17_000_000, ageMs: 5_000 })
  })

  // the 47h freeze: a stale head reported as fresh made blocksBehindHead read 0
  it('reports a stale sample as no sample at all', async () => {
    const c = clock()
    const s = createChainHeadSampler({
      fetchHeight: async () => 17_000_000,
      timeoutMs: TIMEOUT, staleMs: STALE, now: c.now,
    })
    await s.refresh()
    c.advance(STALE + 1)
    const sample = s.current()
    expect(sample.height).toBeNull()
    expect(sample.ageMs).toBe(STALE + 1)
  })

  // the root cause: one non-settling refresh used to hold a boolean guard forever
  it('a refresh that never settles does not disable the sampler', async () => {
    const c = clock()
    let calls = 0
    const s = createChainHeadSampler({
      fetchHeight: () => {
        calls += 1
        // first attempt hangs for good; later attempts answer
        if (calls === 1) return new Promise<number | null>(() => {})
        return Promise.resolve(17_000_123)
      },
      timeoutMs: TIMEOUT, staleMs: STALE, now: c.now,
    })

    // do not await: this attempt never settles on its own
    void s.refresh()
    expect(s.current().height).toBeNull()

    // while inside the deadline the guard still suppresses duplicate work
    c.advance(TIMEOUT - 1)
    await s.refresh()
    expect(calls).toBe(1)

    // once the deadline lapses the next tick retries and recovers
    c.advance(2)
    await s.refresh()
    expect(calls).toBe(2)
    expect(s.current().height).toBe(17_000_123)
  })

  it('never reports a height before the first successful sample', async () => {
    const c = clock()
    const s = createChainHeadSampler({
      fetchHeight: async () => null,
      timeoutMs: TIMEOUT, staleMs: STALE, now: c.now,
    })
    await s.refresh()
    expect(s.current()).toEqual({ height: null, ageMs: null })
  })

  it('survives a refresh that rejects', async () => {
    const c = clock()
    const s = createChainHeadSampler({
      fetchHeight: async () => { throw new Error('ECONNRESET') },
      timeoutMs: TIMEOUT, staleMs: STALE, now: c.now,
    })
    await expect(s.refresh()).resolves.toBeUndefined()
    expect(s.current().height).toBeNull()
  })
})

describe('settleWithin', () => {
  it('resolves the value when the promise settles in time', async () => {
    await expect(settleWithin(Promise.resolve(7), 1_000)).resolves.toBe(7)
  })

  it('resolves null when the promise rejects', async () => {
    await expect(settleWithin(Promise.reject(new Error('nope')), 1_000)).resolves.toBeNull()
  })

  it('resolves null on deadline even though the promise never settles', async () => {
    await expect(settleWithin(new Promise<number>(() => {}), 20)).resolves.toBeNull()
  })
})
