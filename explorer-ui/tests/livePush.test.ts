import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { LIVE_PUSH_KEYS, parseHeadEvent } from '../src/live'
import { pendingRefetchMs } from '../src/hooks/useExplorerData'

describe('parseHeadEvent', () => {
  it('accepts a frame when the head watermark advances', () => {
    expect(parseHeadEvent('{"head":13487500,"main":13487498}', { head: 13487499 }))
      .toEqual({ head: 13487500 })
  })

  it('ignores a replayed or regressed frame — reconnects must not refetch-storm', () => {
    expect(parseHeadEvent('{"head":13487500,"main":13487498}', { head: 13487500 })).toBeNull()
    expect(parseHeadEvent('{"head":13487499,"main":13487498}', { head: 13487500 })).toBeNull()
  })

  it("ignores the frame's trailing indexer watermark, and malformed data", () => {
    // `main` advancing alone is the price indexer catching up, not a new block
    // for the feeds to read.
    expect(parseHeadEvent('{"head":13487500,"main":13487500}', { head: 13487500 })).toBeNull()
    expect(parseHeadEvent('{"head":13487500}', { head: 13487499 })).toEqual({ head: 13487500 })
    expect(parseHeadEvent('not json', { head: 0 })).toBeNull()
    expect(parseHeadEvent('{"head":"soon"}', { head: 0 })).toBeNull()
  })
})

// A detail page served from the pending layer keeps refetching until the
// finalized row replaces it — then stops.
describe('pendingRefetchMs', () => {
  it('polls only while the response says unfinalized', () => {
    expect(pendingRefetchMs({ finalized: false })).toBe(2500)
    expect(pendingRefetchMs({ finalized: true })).toBe(false)
    expect(pendingRefetchMs({})).toBe(false)
    expect(pendingRefetchMs(undefined)).toBe(false)
  })
})

// The push channel invalidates exactly the global live feeds. Each pushed key
// must actually be a feed hook's queryKey prefix in useExplorerData.ts — a
// renamed key would silently drop that feed back to interval-only freshness.
describe('LIVE_PUSH_KEYS', () => {
  it('every pushed key exists as a query key prefix in the data hooks', () => {
    const hooks = readFileSync(new URL('../src/hooks/useExplorerData.ts', import.meta.url), 'utf8')
    for (const key of LIVE_PUSH_KEYS) {
      // Match the ARRAY LITERAL rather than how it is assigned: a feed whose
      // key is chosen by a ternary (the viewer-scoped variants) still starts
      // with the pushed key, which is what react-query's prefix invalidation
      // matches on.
      expect(hooks, `queryKey prefix '${key}' missing from useExplorerData.ts`)
        .toMatch(new RegExp(`\\['${key}'[,\\]]`))
    }
  })

  it('covers the five global feeds', () => {
    expect([...LIVE_PUSH_KEYS]).toEqual(['stats', 'blocks', 'extrinsics', 'events', 'activity'])
  })

})

