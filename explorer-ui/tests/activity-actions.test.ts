import { describe, expect, it } from 'vitest'
import { assetIconCandidates, normalizeActivityAction, originChainIconUrl, ACTIVITY_ACTIONS } from '../src/components/ui'
import { activitySlug, SLUG_TYPES } from '../src/components/ActivityTable'
import { activityBadge } from '../src/components/activityColors'
import type { ActivityRow } from '../src/types'

describe('trade activity actions', () => {
  it('offers swap on every surface using the shared action list', () => {
    expect(ACTIVITY_ACTIONS.trade).toContainEqual({ v: 'swap', label: 'Swap' })
    expect(normalizeActivityAction('trade', 'swap')).toBe('swap')
  })

  it('does not accept the trade-only action on another activity family', () => {
    expect(normalizeActivityAction('liquidity', 'swap')).toBe('')
  })
})

describe('origin asset icons', () => {
  const ethereumUsdc = { ecosystem: 'ethereum', chainId: '1', assetId: '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' } as const

  it('prefers the canonical Ethereum contract icon over the missing local icon', () => {
    const sources = assetIconCandidates('USDC', ethereumUsdc)
    expect(sources[0]).toContain('/ethereum/1/assets/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/icon.svg')
    // `not.toContain(expect.stringContaining(...))` compares array members with
    // Object.is, and an asymmetric matcher is never identical to a string, so that
    // form passed for every input. Map to booleans instead: the list length is part
    // of the assertion, so a candidate appearing or vanishing both fail here.
    expect(sources.map(source => source.includes('/polkadot/'))).toEqual([false, false, false, false])
    expect(sources[2]).toContain('/v1/assets/usdc.svg')
  })

  it('derives the matching origin-chain badge', () => {
    expect(originChainIconUrl(ethereumUsdc)).toContain('/ethereum/1/icon.svg')
  })
})

describe('reward claim classification', () => {
  it('offers and routes liquidity-mining claims as claim-rewards activities', () => {
    expect(ACTIVITY_ACTIONS.liquidity).toContainEqual({ v: 'Claim', label: 'Claim LP Rewards' })
    expect(normalizeActivityAction('liquidity', 'Claim')).toBe('Claim')
    expect(activitySlug({ type: 'liquidity', liqAction: 'Claim' } as ActivityRow)).toBe('claim-rewards')
    expect(SLUG_TYPES['claim-rewards']).toEqual(expect.arrayContaining(['liquidity']))
  })

  it('names the claim after the position it pays out', () => {
    expect(activityBadge({ type: 'liquidity', liqAction: 'Claim' } as ActivityRow).label).toBe('Claim LP Rewards')
  })
})
