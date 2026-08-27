import { describe, it, expect } from 'vitest'
import { DEFAULT_TAGS, SYSTEM_TAG_IDS, modlAccountId, parentSovereignAccountId } from '../src/services/tagService.ts'
import { normalizeAddress } from '../src/services/addressIdentity.ts'

// Every address in the code-defined tag set must resolve to an AccountId32 —
// seedDefaultTags() skips (with a warning) anything that doesn't, so a typo here
// would silently drop a member on the next fresh-DB seed.
describe('DEFAULT_TAGS', () => {
  it('resolves every configured address to an account id', () => {
    for (const tag of DEFAULT_TAGS) {
      for (const address of tag.addresses) {
        const n = normalizeAddress(address)
        expect(n?.accountId, `${tag.tagId}: ${address}`).toMatch(/^0x[0-9a-f]{64}$/)
      }
    }
  })

  it('has unique tag ids and no duplicate members within a tag', () => {
    const ids = DEFAULT_TAGS.map(t => t.tagId)
    expect(new Set(ids).size).toBe(ids.length)
    for (const tag of DEFAULT_TAGS) {
      const members = tag.addresses.map(a => normalizeAddress(a)?.accountId)
      expect(new Set(members).size, tag.tagId).toBe(members.length)
    }
  })

  // The seed is deliberately tiny. A tag is a CLAIM about who owns an account, and
  // an address book carried over from another network makes that claim falsely —
  // the same public key is a different party on a different chain, and a Kraken
  // deposit address or a Polkadot treasury pot named here would label a Basilisk
  // account that has nothing to do with either. So every member must be derivable
  // from a runtime constant, and this test is what keeps a hand-typed address from
  // being added without one. Everything else is generated from indexed data by
  // syncStructuralTags().
  it('seeds only accounts derived from a runtime constant', () => {
    const derived = new Set([modlAccountId('py/trsry'), parentSovereignAccountId()])
    for (const tag of DEFAULT_TAGS) {
      for (const address of tag.addresses) {
        expect(derived, `${tag.tagId}: ${address} is not a derived system account`).toContain(address)
      }
    }
  })

  it('names the treasury pallet account and the relay sovereign', () => {
    const byId = new Map(DEFAULT_TAGS.map(t => [t.tagId, t]))
    expect(byId.get('treasury')?.addresses).toEqual(['0x6d6f646c70792f74727372790000000000000000000000000000000000000000'])
    expect(byId.get('kusama-sovereign')?.addresses).toEqual(['0x506172656e740000000000000000000000000000000000000000000000000000'])
  })

  // Suppression is keyed by tag id, so a name in SYSTEM_TAG_IDS that no definition
  // claims suppresses nothing while reading as though it does.
  it('names only tags that exist in every system-tag id', () => {
    const defined = new Set(DEFAULT_TAGS.map(t => t.tagId))
    for (const id of SYSTEM_TAG_IDS) {
      if (defined.has(id)) continue
      // The rest come from STRUCTURAL_TAGS, which is not exported; assert the set
      // is exactly the structural family plus the relay sovereign.
      expect(['xyk-pools', 'lbp-pools', 'liquidity-mining', 'sovereigns']).toContain(id)
    }
    expect(SYSTEM_TAG_IDS.has('kusama-sovereign')).toBe(true)
    expect(SYSTEM_TAG_IDS.has('treasury')).toBe(false)
  })
})

// One account, one tag. Two definitions naming the same pot made its label depend on
// insertion order (byAccount kept the last label_id, the grouped SQL aggregates kept
// any()), and let a system pot escape the suppression the other tag exists to apply.
describe('default tag membership is exclusive', () => {
  it('never claims one account under two tags', () => {
    const owner = new Map<string, string>()
    for (const def of DEFAULT_TAGS) {
      for (const address of def.addresses) {
        const accountId = normalizeAddress(address)?.accountId
        if (!accountId) continue
        const previous = owner.get(accountId)
        expect(previous, `${accountId} claimed by both ${previous} and ${def.tagId}`).toBeUndefined()
        owner.set(accountId, def.tagId)
      }
    }
  })
})
