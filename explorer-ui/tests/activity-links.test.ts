import { describe, it, expect } from 'vitest'
import { activitySlug, activityId, activityLabel, canonicalTarget, subordinateActivityTarget, parseId, SLUG_TYPES } from '../src/components/ActivityTable'
import { LIQ_LABELS } from '../src/components/activityColors'
import type { ActivityRow } from '../src/types'

const base: ActivityRow = {
  type: 'transfer', blockHeight: 100, timestamp: '2026-07-10 00:00:00',
  eventIndex: 7, extrinsicIndex: 2, who: null, to: null, asset: null,
  assetIn: null, assetOut: null, amount: null, amountIn: null, amountOut: null, valueUsd: null,
}

describe('activitySlug', () => {
  it('maps rows to canonical slugs', () => {
    expect(activitySlug({ ...base, type: 'trade' })).toBe('swap')
    expect(activitySlug(base)).toBe('transfer')
    expect(activitySlug({ ...base, type: 'xcm' })).toBe('cross-chain')
    expect(activitySlug({ ...base, type: 'liquidity', liqAction: 'Add' })).toBe('add-liquidity')
    expect(activitySlug({ ...base, type: 'liquidity', liqAction: 'Remove' })).toBe('remove-liquidity')
    expect(activitySlug({ ...base, type: 'liquidity', liqAction: 'Destroy' })).toBe('destroy-pool')
    expect(activitySlug({ ...base, type: 'liquidity', liqAction: 'Claim' })).toBe('claim-rewards')
    expect(activitySlug({ ...base, type: 'vote', voteSide: 'Aye' })).toBe('vote')
  })
})

// The slug label (crumbs/route title) and the liqAction label (the detail page's
// Action field, via LIQ_LABELS[row.liqAction ?? ''] ?? LIQ_LABELS.Add in
// ActivityDetail) are two independent maps that must still agree on a pool
// destruction — the same double-naming reward-claim rows already need.
describe('destroy-pool labels', () => {
  it('names the slug and the liquidity action the same way', () => {
    expect(activityLabel('destroy-pool')).toBe('Destroy pool')
    expect(LIQ_LABELS.Destroy).toBe('Destroy pool')
  })
})

describe('activityId', () => {
  it('prefers the event index', () => expect(activityId(base)).toBe('100-e7'))
  it('falls back to the extrinsic index', () => expect(activityId({ ...base, eventIndex: null })).toBe('100-2'))
  it('returns null with neither', () => expect(activityId({ ...base, eventIndex: null, extrinsicIndex: null })).toBe(null))
})

describe('canonicalTarget', () => {
  it('returns null when the row already matches the current slug and event-form id', () => {
    expect(canonicalTarget(base, 'transfer', '100-e7')).toBe(null)
  })

  it('canonicalizes on slug mismatch (row is a swap, current slug is transfer)', () => {
    const row: ActivityRow = { ...base, type: 'trade' }
    expect(canonicalTarget(row, 'transfer', '100-e7')).toBe('/swap/100-e7')
  })

  it('upgrades an extrinsic-form id to the event form when the slug already matches', () => {
    expect(canonicalTarget(base, 'transfer', '100-2')).toBe('/transfer/100-e7')
  })

  it('canonicalizes both slug and id when both are wrong', () => {
    const row: ActivityRow = { ...base, type: 'trade' }
    expect(canonicalTarget(row, 'transfer', '100-2')).toBe('/swap/100-e7')
  })
})

describe('parseId', () => {
  it('parses the event-index form', () => {
    expect(parseId('123-e45')).toEqual({ height: 123, eventIndex: 45, extrinsicIndex: null })
  })
  it('parses the extrinsic-index form', () => {
    expect(parseId('123-45')).toEqual({ height: 123, eventIndex: null, extrinsicIndex: 45 })
  })
  it('returns null for non-numeric input', () => expect(parseId('abc')).toBe(null))
  it('returns null for a dangling separator', () => expect(parseId('12-')).toBe(null))
})

describe('SLUG_TYPES', () => {
  it('maps swap to the trade coarse type', () => {
    expect(SLUG_TYPES.swap).toEqual(['trade'])
  })
  it('maps cross-chain to xcm', () => expect(SLUG_TYPES['cross-chain']).toEqual(['xcm']))
  it('maps liquidity slugs to liquidity', () => {
    expect(SLUG_TYPES['add-liquidity']).toEqual(['liquidity'])
    expect(SLUG_TYPES['remove-liquidity']).toEqual(['liquidity'])
    expect(SLUG_TYPES['claim-rewards']).toEqual(['liquidity'])
  })
  it('maps transfer and vote to their own singleton types', () => {
    expect(SLUG_TYPES.transfer).toEqual(['transfer'])
    expect(SLUG_TYPES.vote).toEqual(['vote'])
  })
})

// An id can name an event that is real, is part of an activity, and is deliberately
// not a row of its own: the transfer legs and fee withdrawals of a swap. Before this,
// such an id answered "No transfer activity found" under a page titled "Transfer" —
// asserting a family the event never belonged to, and stranding the reader one click
// from what it actually is.
describe('subordinateActivityTarget', () => {
  const at = (extrinsicIndex: number | null, over: Partial<ActivityRow> = {}): ActivityRow => ({
    type: 'transfer', blockHeight: 13278487, timestamp: '2026-07-23 01:43:42', eventIndex: 12,
    extrinsicIndex, who: null, to: null, asset: null, assetIn: null, assetOut: null,
    amount: null, amountIn: null, amountOut: null, valueUsd: null, ...over,
  } as ActivityRow)

  it('hands a plumbing event over to the activity owning its extrinsic', () => {
    // The real case: a routed swap emits transfer legs and the swap at e12.
    const rows = [at(2, { type: 'trade', eventIndex: 12 })]
    expect(subordinateActivityTarget(rows, 2)).toBe('/swap/13278487-e12')
  })

  it('refuses to guess when the extrinsic holds several activities', () => {
    const rows = [
      at(2, { type: 'trade', eventIndex: 12 }),
      at(2, { type: 'trade', eventIndex: 20 }),
    ]
    expect(subordinateActivityTarget(rows, 2)).toBeNull()
  })

  it('has nowhere to hand over when nothing owns the extrinsic', () => {
    expect(subordinateActivityTarget([at(9, { type: 'trade' })], 2)).toBeNull()
    expect(subordinateActivityTarget([], 2)).toBeNull()
    // A hook event has no extrinsic to be owned by.
    expect(subordinateActivityTarget([at(2, { type: 'trade' })], null)).toBeNull()
  })

  // An owner with no addressable row falls back to the extrinsic rather than
  // building a broken activity URL.
  it('falls back to the extrinsic when the owner has no id of its own', () => {
    const rows = [at(2, { type: 'transfer', eventIndex: null, extrinsicIndex: 2 })]
    expect(subordinateActivityTarget(rows, 2)).toBe('/transfer/13278487-2')
  })
})
