import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ExternalAccountPill } from '../src/components/ActivityTable'
import type { ActivityRow } from '../src/types'

// A cross-chain row for an account that is a bound-EVM signer locally: the wire
// `raw`/`address` carry the bare H160, but the server resolves it to the
// substrate account it is bound to (see explorerService.ts's externalAccountRef —
// `resolved`/`accountId`), the id the account's own emoji is derived from.
const RESOLVED_ACCOUNT_ID = '0x' + 'bb'.repeat(32)
const RAW_H160 = '0x' + '11'.repeat(20)

const account: NonNullable<ActivityRow['destAccount']> = {
  kind: 'AccountKey20', accountId: RESOLVED_ACCOUNT_ID, address: RAW_H160, raw: RAW_H160, subscanUrl: null,
  tag: { id: 'kraken', name: 'Kraken', color: '#a78bfa', icon: '🦑' }, identity: null,
}

describe('ExternalAccountPill', () => {
  it('shows the system tag the server resolved for a cross-chain account', () => {
    const html = renderToStaticMarkup(<ExternalAccountPill account={account} />)
    expect(html).toContain('Kraken')
  })

  it('shows the shortened address when the account carries no tag or identity', () => {
    const html = renderToStaticMarkup(<ExternalAccountPill account={{ ...account, tag: null }} />)
    expect(html).not.toContain('Kraken')
    expect(html).toContain(RAW_H160.slice(0, 6))
  })
})
