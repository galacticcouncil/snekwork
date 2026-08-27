import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { LiquidityPositionsTable } from '../src/components/AccountSections'
import type { LpPosition } from '../src/types'

const pos = (venue: string, positionId: string, symbol: string): LpPosition => ({
  positionId, asset: { assetId: 690, symbol, name: null, decimals: 12, parachainId: null },
  amount: '1000000000000', shares: '1000000000000', valueUsd: 42, venue,
})

describe('LiquidityPositionsTable — venue-aware rows', () => {
  it('labels wallet-held pool shares as pool shares, never an internal position id', () => {
    const html = renderToStaticMarkup(<LiquidityPositionsTable positions={[pos('XYK', 'xyk:690:direct', 'BSX/DOT')]} />)
    expect(html).toContain('Pool shares')
    expect(html).not.toContain('xyk:690:direct')
    expect(html).toContain('XYK')
  })
  it('separates farm-deposited shares from wallet-held ones by venue badge', () => {
    const direct = renderToStaticMarkup(<LiquidityPositionsTable positions={[pos('XYK', 'xyk:690:direct', 'BSX/DOT')]} />)
    const farmed = renderToStaticMarkup(<LiquidityPositionsTable positions={[pos('XYK Farm', 'xyk:690:farm', 'BSX/DOT')]} />)
    expect(farmed).toContain('XYK Farm')
    // Different venues must not collapse onto the same badge colour.
    expect(farmed).not.toBe(direct)
  })
  it('carries the distinguishing section sub-label', () => {
    const html = renderToStaticMarkup(<LiquidityPositionsTable positions={[pos('XYK', 'xyk:690:direct', 'BSX/DOT')]} />)
    expect(html).toContain('provided to pools')
  })
})
