import { describe, it, expect } from 'vitest'
import { resolveTag, allAssociations } from '../src/systemTags'
import type { AccountRef } from '../src/types'

const ACC = '0x' + 'ab'.repeat(32)
const account: AccountRef = {
  accountId: ACC, address: '15xx', emoji: '🦊',
  tag: { id: 'kraken', name: 'Kraken', color: '#a78bfa', icon: '🦑' },
  identity: null,
}

// System tags ride on the account ref itself, so resolution is a pure read: the
// pill, the hover card and the account page all get the same one tag, or none.
describe('resolveTag', () => {
  it('resolves the account ref\'s own system tag', () => {
    expect(resolveTag(account)).toMatchObject({ kind: 'system', id: 'kraken', name: 'Kraken', icon: '🦑' })
  })

  it('is null for an untagged account', () => {
    expect(resolveTag({ ...account, tag: null })).toBe(null)
  })

  it('carries the member count so a pill can disambiguate a group member', () => {
    expect(resolveTag({ ...account, tag: { ...account.tag!, memberCount: 4 } })).toMatchObject({ memberCount: 4 })
  })
})

describe('allAssociations', () => {
  it('lists the system tag for the detail/hover surfaces', () => {
    expect(allAssociations(account).map(a => a.id)).toEqual(['kraken'])
  })

  it('is empty for an untagged account', () => {
    expect(allAssociations({ ...account, tag: null })).toEqual([])
  })
})
