import { useSyncExternalStore } from 'react'
import { NOMINAL_BLOCK_SECONDS } from './utils/blockTime'

// The explorer is always live. A block lands every ~6s today (2s planned) and
// the pages follow it: the SSE head stream drives the refetches, and LIVE_MS is
// the fallback interval for whenever that stream is unavailable (older browser,
// proxy hiccup, mocked test API). Polling faster than the chain only re-fetches
// the same head while forcing the API cache to expire between clients; the
// server's single-flight cache keeps DB load O(1) however many clients watch.
//
// These two timers are the only block-time knowledge in the UI that does not
// come from the chain, because neither is a value anyone reads: one is a poll
// interval, the other a cache-freshness window, and both are needed BEFORE the
// stats payload carrying the chain's own rates has been fetched at all. They
// ride on the fallback constant instead. A faster chain therefore keeps the same
// fallback cadence until someone moves that constant — a degraded-mode poll a
// block or two behind, never a wrong number on screen.
export const LIVE_MS = NOMINAL_BLOCK_SECONDS * 1000
// One nominal block of freshness for the live feeds: a poll that lands inside
// the block already on screen serves it from cache instead of asking again.
// Feeds with a rate of their own (block/extrinsic/event lists at 2-5s, detail
// pages at 20-120s) keep their own value; this is the shared "as fresh as the
// chain" default.
export const BLOCK_STALE_MS = NOMINAL_BLOCK_SECONDS * 1000

// Push channel. The API streams the ingested chain head over SSE; when a new
// block lands, main.tsx invalidates exactly the global live feeds below, so
// they refetch the moment data exists instead of waiting out the poll timer.
// The LIVE_MS interval polling stays as the fallback — a closed stream (older
// browser, mocked test env, proxy hiccup) degrades to today's behavior.
export const LIVE_PUSH_KEYS = ['stats', 'blocks', 'extrinsics', 'events', 'activity'] as const

export interface HeadPush { head: number }
type HeadListener = (push: HeadPush) => void
const headListeners = new Set<HeadListener>()
let source: EventSource | null = null
let lastHead = 0
// A head that arrived while the tab was hidden: dispatch is deferred to the
// next visibilitychange, so a background tab does no work but catches up the
// moment it is looked at (interval polling is paused while streaming, so
// silently dropping the event would leave the tab stale until the NEXT head).
let pendingHiddenHead = 0

// The newest pushed head while the stream is healthy, or ''. The api client
// stamps this onto live-feed URLs (`h=`): the nginx micro-cache keys on the
// URI alone, so without it a push-triggered refetch can HIT the entry built
// for the PREVIOUS head — with polling paused, that staleness would persist
// until the next block rather than the next tick.
export function liveHeadTag(): string {
  if (!streamHealthy || lastHead === 0) return ''
  return `${lastHead}`
}

function dispatchHead(head: number): void {
  if (typeof document !== 'undefined' && document.hidden) {
    pendingHiddenHead = head
    return
  }
  pendingHiddenHead = 0
  headListeners.forEach(l => l({ head }))
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || pendingHiddenHead === 0) return
    const push = { head: pendingHiddenHead }
    pendingHiddenHead = 0
    headListeners.forEach(l => l(push))
  })
}

// Stream health drives the polling fallback: while the SSE channel is open the
// push-covered feeds stop interval-polling entirely (requests then happen only
// when a block actually lands); any error or disconnect flips this off and the
// LIVE_MS polling takes over until the stream reconnects.
let streamHealthy = false
const healthListeners = new Set<() => void>()
function setStreamHealthy(v: boolean): void {
  if (streamHealthy === v) return
  streamHealthy = v
  healthListeners.forEach(l => l())
}
export function useHeadStream(): boolean {
  return useSyncExternalStore(
    (cb) => { healthListeners.add(cb); return () => healthListeners.delete(cb) },
    () => streamHealthy,
    () => false,
  )
}

// A pushed frame only counts when the watermark moves — reconnect replays the
// current frame, which must not trigger a redundant refetch storm. `head` is
// the raw-ingestion checkpoint the explorer's feeds read, and only ever
// advances. The frame's `main` (the price indexer's own, trailing block) is not
// a feed watermark, so it is ignored here.
export interface HeadFrame { head: number }
export function parseHeadEvent(data: string, prev: HeadFrame): HeadFrame | null {
  try {
    const raw = JSON.parse(data) as { head?: unknown }
    const head = Number.isSafeInteger(Number(raw.head)) ? Number(raw.head) : 0
    if (head <= prev.head) return null
    return { head }
  } catch { return null }
}

function connectHead(): void {
  if (source || headListeners.size === 0 || typeof EventSource === 'undefined') return
  source = new EventSource('/api/explorer/live')
  source.addEventListener('open', () => setStreamHealthy(true))
  source.addEventListener('head', e => {
    const frame = parseHeadEvent((e as MessageEvent<string>).data, { head: lastHead })
    if (frame == null) return
    lastHead = frame.head
    dispatchHead(frame.head)
  })
  // Network drops auto-reconnect (server sends `retry:`); a non-200 response
  // (e.g. the mocked test API) closes the source for good. Either way the
  // stream is unhealthy until reopened and polling carries the feeds alone.
  source.addEventListener('error', () => setStreamHealthy(false))
}
function disconnectHead(): void {
  source?.close()
  source = null
  setStreamHealthy(false)
}

export function subscribeHead(cb: HeadListener): () => void {
  headListeners.add(cb)
  connectHead()
  return () => {
    headListeners.delete(cb)
    if (headListeners.size === 0) disconnectHead()
  }
}
