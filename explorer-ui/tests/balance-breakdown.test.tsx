import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { BalanceBreakdown } from '../src/components/BalanceBreakdown'
import type { AddressBalance } from '../src/types'

const HDX = { assetId: 0, symbol: 'HDX', name: 'Hydration', decimals: 12, parachainId: null }
const raw = (v: number) => BigInt(Math.round(v * 1e6)).toString() + '0'.repeat(6)
// `until` dates are rendered relative to the real Date.now() (fmtIn), so anchor
// them to now — hardcoded calendar dates would flip to "now" once real time
// passes them and silently break these assertions.
const inDays = (n: number) => new Date(Date.now() + n * 86400e3).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')

function bal(over: Partial<AddressBalance>): AddressBalance {
  return { asset: HDX, total: raw(1000), free: raw(920), reserved: raw(80), lastBlock: 1, valueUsd: 21.84, ...over }
}

// The adaptive breakdown band also renders an off-screen, aria-hidden clone
// of the legend purely to measure its natural width (see BreakdownBand) — it
// has no nested <div>s, so this strips exactly that one element before
// content assertions, which otherwise would double-count real legend rows.
function render(balance: AddressBalance): string {
  return renderToStaticMarkup(<BalanceBreakdown balance={balance} />)
    .replace(/<div class="bd-legend-measure"[^]*?<\/div>/, '')
}

describe('BalanceBreakdown', () => {
  it('renders nothing when the balance has no locked or reserved part', () => {
    const html = render(bal({ reserved: '0', frozen: undefined, breakdown: undefined }))
    expect(html).toBe('')
  })

  it('one bar + schedule sorted by time to liquidity, transferable always first', () => {
    const html = render(bal({
      frozen: raw(500),
      breakdown: [
        { kind: 'lock', source: 'vote', amount: raw(500) },
        { kind: 'lock', source: 'vesting', amount: raw(100) },
        { kind: 'deposit', source: 'identity', amount: raw(12) },
        { kind: 'deposit', source: 'referenda', amount: raw(20) },
      ],
      timeline: [
        { state: 'releasable', cause: 'vesting', amount: raw(100) },
        { state: 'scheduled', cause: 'vote', amount: raw(220), until: inDays(120) },
        { state: 'active', cause: 'vote', amount: raw(100) },
      ],
    }))
    // exactly one aggregated bar, no separate totals line
    expect(html.match(/bd-agg"/g)?.length).toBe(1)
    expect(html).not.toContain('bd-totals')
    // transferable is the first schedule row (labeled "free")
    expect(html).toContain('free')
    // reason-led rows: cause · amount · duration description
    expect(html).toContain('vesting')
    expect(html).toContain('claim to free')
    // days, never dates
    expect(html).toMatch(/in \d+d/)
    expect(html).not.toMatch(/Aug|Nov|20\d\d/)
    // exceeding ongoing votes stay open-ended
    expect(html).toContain('while voting/delegating')
    // statics lead with the reason, no "static" word
    expect(html).toContain('deposits')
    expect(html).toContain('until cleared')
    expect(html).not.toContain('static')
    // order: transferable ("free") → releasable → clearable statics →
    // still-cast votes → hard dated locks ascending
    const order = ['free', 'claim to free', 'until cleared', 'while voting/delegating']
    const idx = order.map(t => html.indexOf(t))
    expect(idx.every(i => i >= 0)).toBe(true)
    expect([...idx].sort((a, b) => a - b)).toEqual(idx)
  })

  it('vesting shows claim-now and a linear fade with day counts', () => {
    const html = render(bal({
      frozen: raw(500),
      breakdown: [{ kind: 'lock', source: 'vesting', amount: raw(500), claimable: raw(120) }],
      timeline: [
        { state: 'releasable', cause: 'vesting', amount: raw(120) },
        { state: 'scheduled', cause: 'vesting', amount: raw(380), until: inDays(200), linear: true },
      ],
    }))
    expect(html).toContain('claim to free')
    expect(html).toMatch(/in \d+d/)
    expect(html).not.toMatch(/Mar 2027/)
    expect(html).toContain('vests linearly')
    expect(html).toContain('linear-gradient')
  })

  it('open floors carry the not-before minimum in days', () => {
    const html = render(bal({
      frozen: raw(500),
      breakdown: [{ kind: 'lock', source: 'democracy', amount: raw(500) }],
      timeline: [{ state: 'active', cause: 'democracy', amount: raw(500), until: inDays(210) }],
    }))
    expect(html).toMatch(/≥ \d+d/)
    expect(html).toContain('vote (old)')
  })

  it('reserve-only assets show only the reason rows', () => {
    const html = render(bal({
      breakdown: [{ kind: 'deposit', source: 'identity', amount: raw(80) }],
    }))
    expect(html).toContain('deposits')
    expect(html).toContain('until cleared')
    expect(html).not.toContain('identity deposit')
    expect(html).not.toContain('anytime')
  })
})
