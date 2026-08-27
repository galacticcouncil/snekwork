import type { AccountRef } from './types'

// Tag resolution. The server ships each account's system tag on its accountRef
// (shared-cacheable), so resolving one is a pure read of the ref: exactly one
// tag per account, and `allAssociations()` lists it as the single association
// the account page and hover card render.
// `memberCount` disambiguates a pill wearing this tag on behalf of one of its
// several members (see AddrPill/ExternalAccountPill's `·xyz` suffix) — absent
// or 1 means the tag can only ever mean the one account it's shown next to.
export interface ResolvedTag { kind: 'system'; id: string; name: string; color: string; icon: string; memberCount?: number }

export function resolveTag(account: Pick<AccountRef, 'tag'>): ResolvedTag | null {
  return account.tag ? { kind: 'system', id: account.tag.id, name: account.tag.name, color: account.tag.color, icon: account.tag.icon, memberCount: account.tag.memberCount } : null
}

export function allAssociations(account: Pick<AccountRef, 'tag'>): ResolvedTag[] {
  const tag = resolveTag(account)
  return tag ? [tag] : []
}
