// Block counts as durations. Everything that turns a runtime's block arithmetic
// into the time a reader actually sees — countdowns, referendum phases, "how
// long ago" — resolves its seconds-per-block here, so no two surfaces can drift
// apart on what a block is worth.

// Last-resort block time, for the moment before any payload has arrived.
// Nothing displayed should reach for it: the chain publishes both of its own
// block times in the stats payload — `avgBlockSec`, the measured pace, for a
// live block delta, and `nominalBlockSec`, the runtime's slot time, for a
// runtime block-count constant (see api/src/services/blockTime.ts for why the
// two are not interchangeable). What is left for this constant is the
// poll/freshness timers in live.ts, which are needed before the first fetch
// resolves.
export const NOMINAL_BLOCK_SECONDS = 6

// Resolve a seconds-per-block from the payload, whichever of the two rates the
// caller asked for, falling back only when the payload is not loaded yet.
export function blockSeconds(fromChain: number | null | undefined): number {
  return fromChain != null && Number.isFinite(fromChain) && fromChain > 0 ? fromChain : NOMINAL_BLOCK_SECONDS
}

// Two units, largest first: 3d 4h · 1h 17m · 12m · 45s. `seconds` keeps the
// second component under an hour, which a live countdown needs to visibly tick.
export function fmtDuration(totalSeconds: number, opts: { seconds?: boolean } = {}): string {
  const s = Math.max(0, Math.round(totalSeconds))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  if (m > 0) return opts.seconds ? `${m}m ${sec}s` : `${m}m`
  return `${sec}s`
}

// A block count as a duration at the given pace.
export function blockSpanSeconds(blocks: number, secondsPerBlock?: number | null): number {
  return Math.max(0, Math.round(blocks * blockSeconds(secondsPerBlock)))
}
