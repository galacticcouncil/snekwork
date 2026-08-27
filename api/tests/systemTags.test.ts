import { describe, it, expect } from 'vitest'
import { modlAccountId, parentSovereignAccountId, economicModuleAccounts, initTagService, loadTags, retireUnknownTagMemberships, SYSTEM_TAG_IDS, DEFAULT_TAGS, SOVEREIGN_PREFIXES } from '../src/services/tagService.ts'
import type { Tag } from '../src/services/tagService.ts'
import type { ClickHouseClient } from '../src/db/client.ts'

describe('system-account derivations', () => {
  it('builds modl pallet account ids ("modl" + 8-byte pallet id, zero-padded)', () => {
    expect(modlAccountId('py/trsry')).toBe('0x6d6f646c70792f74727372790000000000000000000000000000000000000000')
    expect(modlAccountId('xykLMpID')).toBe('0x6d6f646c78796b4c4d7049440000000000000000000000000000000000000000')
    // The optional sub-account suffix lands between the pallet id and the padding.
    expect(modlAccountId('py/trsry', '08627411')).toBe('0x6d6f646c70792f74727372790862741100000000000000000000000000000000')
  })

  // The relay's own account here is NOT a 'sibl'/'para' sovereign: XCM's
  // ParentIsPreset converter maps the Parent origin to the ASCII bytes "Parent",
  // right-padded — the same marker the activity decoders recognise as an XCM origin.
  it('derives the relay sovereign from the Parent origin marker', () => {
    expect(parentSovereignAccountId()).toBe('0x506172656e740000000000000000000000000000000000000000000000000000')
    expect(SOVEREIGN_PREFIXES.some(p => parentSovereignAccountId().startsWith(p))).toBe(false)
  })

  it('ships reproducible, derived membership in DEFAULT_TAGS', () => {
    const ids = DEFAULT_TAGS.map(t => t.tagId)
    expect(ids).toEqual(['treasury', 'kusama-sovereign'])
    expect(DEFAULT_TAGS.flatMap(t => t.addresses))
      .toEqual([modlAccountId('py/trsry'), parentSovereignAccountId()])
  })

  // A sovereign account is 20 meaningful bytes under one of two markers. Matching
  // only 'sibl' left the 'para' form (e.g. para 2001) untagged.
  it('recognises both sovereign markers, not just sibl', () => {
    const hex = (s: string) => '0x' + Buffer.from(s, 'latin1').toString('hex')
    expect(SOVEREIGN_PREFIXES).toEqual([hex('sibl'), hex('para')])
    const para2001 = '0x70617261d1070000000000000000000000000000000000000000000000000000'
    expect(SOVEREIGN_PREFIXES.some(p => para2001.startsWith(p))).toBe(true)
  })
})

describe('economicModuleAccounts — movers exception list', () => {
  const tag = (tagId: string, members: string[]): Tag => ({ tagId, name: tagId, color: '', note: '', icon: '', members })
  it('admits tagged module accounts except system-tag members', () => {
    const tags = [
      tag('treasury', ['0x6d6f646c70792f74727372790000000000000000000000000000000000000000']),
      tag('liquidity-mining', ['0x6d6f646c78796b4c4d7049440000000000000000000000000000000000000000']),
      tag('xyk-pools', ['0x1111111111111111111111111111111111111111111111111111111111111111']),
    ]
    const out = economicModuleAccounts(tags)
    expect(out).toContain('0x6d6f646c70792f74727372790000000000000000000000000000000000000000')
    expect(out).not.toContain('0x6d6f646c78796b4c4d7049440000000000000000000000000000000000000000') // system tag
    expect(out).not.toContain('0x1111111111111111111111111111111111111111111111111111111111111111') // not modl
    expect(SYSTEM_TAG_IDS.has('liquidity-mining')).toBe(true)
    expect(SYSTEM_TAG_IDS.has('treasury')).toBe(false)
  })
})

// A membership row is only ever inserted, so dropping a tag from code has to
// actively tombstone what an earlier deployment seeded — otherwise loadTags keeps
// serving it and a retired tag goes on labelling its account. That is what the
// retire pass is for, and it is how a deployment sheds the tags this fork removed.
describe('retireUnknownTagMemberships', () => {
  it('tombstones a tag no code definition claims', async () => {
    const commands: { query: string; query_params?: Record<string, unknown> }[] = []
    let tagRows: Record<string, unknown>[] = [{
      label_id: 'contracts', label_name: 'Contract', color: '', note: '', icon: '📜',
      account_id: '0x531a654d1696ed52e7275a8cede955e82620f99a0000000000000000000000ff',
    }]
    const client = {
      query: async () => ({ json: async () => tagRows }),
      command: async (cmd: { query: string; query_params?: Record<string, unknown> }) => {
        commands.push(cmd)
        tagRows = []   // the mutation is synchronous; the reload that follows sees none
      },
      insert: async () => {},
    } as unknown as ClickHouseClient

    initTagService(client)
    await loadTags()
    await retireUnknownTagMemberships()
    expect(commands).toHaveLength(1)
    expect(commands[0].query).toContain('deleted = 1')
    expect(commands[0].query_params).toMatchObject({ tagIds: ['contracts'] })

    // Idempotent: nothing left to retire on the next start.
    await retireUnknownTagMemberships()
    expect(commands).toHaveLength(1)
  })
})
