export interface ChainHeadSamplerOptions {
  /** returns the chain's best block height, or null when the RPC gave no usable answer */
  fetchHeight: () => Promise<number | null>
  /** ceiling on a single refresh attempt */
  timeoutMs: number
  /** beyond this age a sample is reported as no sample at all */
  staleMs: number
  now?: () => number
}

export interface ChainHeadSample {
  /** the sampled height, or null when there is no fresh sample to stand behind */
  height: number | null
  /** age of the last successful sample in ms; null if there has never been one */
  ageMs: number | null
}

export interface ChainHeadSampler {
  refresh: () => Promise<void>
  current: () => ChainHeadSample
}

/**
 * Background chain-head sampler.
 *
 * Two properties matter, both learned the hard way on 2026-08-31, when a single
 * refresh that never settled froze the reported chain head for 47 hours while the
 * process stayed healthy and `/indexer` kept answering `blocksBehindHead: 0`:
 *
 * 1. a refresh that never settles must not disable the sampler — the in-flight
 *    marker is a deadline, not a boolean, so the next tick retries once it lapses;
 * 2. a stale sample must not pass for a fresh one — past `staleMs` the sample is
 *    reported as absent, so callers fall back instead of trusting an old height.
 */
export function createChainHeadSampler(options: ChainHeadSamplerOptions): ChainHeadSampler {
  const now = options.now ?? (() => Date.now())
  let height: number | null = null
  let sampledAt: number | null = null
  let refreshStartedAt = 0

  const refresh = async (): Promise<void> => {
    const startedAt = now()
    if (refreshStartedAt !== 0 && startedAt - refreshStartedAt < options.timeoutMs) return
    refreshStartedAt = startedAt
    try {
      const sampled = await settleWithin(options.fetchHeight(), options.timeoutMs)
      if (sampled != null) {
        height = sampled
        sampledAt = now()
      }
    } finally {
      refreshStartedAt = 0
    }
  }

  const current = (): ChainHeadSample => {
    if (sampledAt == null) return { height: null, ageMs: null }
    const ageMs = now() - sampledAt
    return { height: ageMs <= options.staleMs ? height : null, ageMs }
  }

  return { refresh, current }
}

/**
 * Resolves `null` after `ms` even if `promise` never settles. The dangling promise
 * is unavoidable — if a lower layer hangs there is nothing to cancel — but it must
 * not hold the sampler hostage.
 */
export function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>(resolve => {
    const timer = setTimeout(() => resolve(null), ms)
    timer.unref?.()
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      () => { clearTimeout(timer); resolve(null) },
    )
  })
}
