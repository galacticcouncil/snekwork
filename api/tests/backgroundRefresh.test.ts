import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The scheduler imports its refresh functions; stub them so the test exercises
// only the cadence/serialization logic, not the heavy service graph.
const proxy = vi.fn(async () => {})
vi.mock('../src/services/proxyMultisigService.ts', () => ({ refreshProxyMultisig: () => proxy() }))

const { startBackgroundRefresh, stopBackgroundRefresh, dueTasks } = await import('../src/services/backgroundRefresh.ts')

describe('dueTasks cadence', () => {
  const tasks = [
    { name: 'a', everyTicks: 1, run: async () => {} },
    { name: 'b', everyTicks: 3, run: async () => {} },
  ]
  it('runs every-tick tasks each tick and every-3rd tasks only on multiples of 3', () => {
    expect(dueTasks(1, tasks).map(t => t.name)).toEqual(['a'])
    expect(dueTasks(2, tasks).map(t => t.name)).toEqual(['a'])
    expect(dueTasks(3, tasks).map(t => t.name)).toEqual(['a', 'b'])
    expect(dueTasks(6, tasks).map(t => t.name)).toEqual(['a', 'b'])
  })

  it('schedules the proxy/multisig reconstruction on every tick (~60s)', () => {
    for (const tick of [1, 2, 3, 4]) expect(dueTasks(tick).map(t => t.name), `tick ${tick}`).toContain('proxy-multisig')
  })
})

describe('startBackgroundRefresh scheduling', () => {
  beforeEach(() => { vi.useFakeTimers(); proxy.mockClear() })
  afterEach(() => { stopBackgroundRefresh(); vi.useRealTimers() })

  it('runs an initial pass once, then every 60s', async () => {
    startBackgroundRefresh()
    await vi.advanceTimersByTimeAsync(0)
    expect(proxy).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(proxy).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(proxy).toHaveBeenCalledTimes(3)
  })

  it('skips a tick while a batch is still running (no pile-up)', async () => {
    let release: () => void = () => {}
    proxy.mockImplementationOnce(() => new Promise<void>(r => { release = r }))
    startBackgroundRefresh()
    await vi.advanceTimersByTimeAsync(0)
    expect(proxy).toHaveBeenCalledTimes(1)
    // a tick fires while the batch is still in flight → skipped, no new run
    await vi.advanceTimersByTimeAsync(60_000)
    expect(proxy).toHaveBeenCalledTimes(1)
    // unblock: the next tick resumes the normal cadence
    release()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(proxy).toHaveBeenCalledTimes(2)
  })

  it('isolates a failing task so the scheduler keeps ticking', async () => {
    proxy.mockRejectedValueOnce(new Error('boom'))
    startBackgroundRefresh()
    await vi.advanceTimersByTimeAsync(0)
    expect(proxy).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(proxy).toHaveBeenCalledTimes(2)
  })
})
