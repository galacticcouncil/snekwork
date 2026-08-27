import type { ClickHouseClient } from '../db/client.ts'
import { normalizeAddress } from './addressIdentity.ts'
import { accountIcon } from './omniwatchIdentity.ts'

// Address tags. The whole tag set is user-curated and small, so it lives in
// memory (refreshed on every edit) for O(1) display resolution, and is also
// joined directly in ClickHouse for aggregate grouping (Holders).
export interface Tag {
  tagId: string
  name: string
  color: string
  note: string
  icon: string      // explicit icon URL/emoji, or '' to derive from first member
  members: string[] // normalized account_ids
}
export interface AccountTag { tagId: string; name: string; color: string; icon: string; memberCount: number }

let client: ClickHouseClient
const byAccount = new Map<string, AccountTag>()
const byTag = new Map<string, Tag>()

export function initTagService(c: ClickHouseClient): void { client = c }

// A tag's display icon: explicit icon if set, else the first member's icon via
// the SAME derivation the member pills use (accountIcon) — a custom image icon
// (e.g. a Discord emoji) wins over the fallback emoji char, so the group shows
// exactly what its first member shows (e.g. Treasury → 🏦, Polkadot Treasury →
// the members' custom Polkadot icon).
function iconFor(tag: Tag): string {
  if (tag.icon) return tag.icon
  const first = tag.members[0]
  if (!first) return '🏷️'
  const icon = accountIcon(first)
  return icon.emojiUrl || icon.emoji
}

export async function loadTags(): Promise<void> {
  const res = await client.query({
    query: `
      SELECT label_id, label_name, color, note, icon, account_id
      FROM price_data.account_tags FINAL
      WHERE deleted = 0
      ORDER BY label_id, account_id`,
    format: 'JSONEachRow',
  })
  const rows = await res.json<{ label_id: string; label_name: string; color: string; note: string; icon: string; account_id: string }>()
  byAccount.clear()
  byTag.clear()
  for (const r of rows) {
    let tag = byTag.get(r.label_id)
    if (!tag) {
      tag = { tagId: r.label_id, name: r.label_name, color: r.color, note: r.note, icon: r.icon, members: [] }
      byTag.set(r.label_id, tag)
    }
    tag.members.push(r.account_id)
  }
  // Resolve each tag's display icon once members are known, then index accounts.
  for (const tag of byTag.values()) {
    const icon = iconFor(tag)
    tag.icon = icon
    for (const accountId of tag.members) {
      byAccount.set(accountId, { tagId: tag.tagId, name: tag.name, color: tag.color, icon, memberCount: tag.members.length })
    }
  }
}

export function tagForAccount(accountId: string): AccountTag | null {
  return byAccount.get(accountId) ?? null
}

// AMM pool accounts — derived, non-modl ids whose transfer legs are pool plumbing
// behind trade/liquidity rows.
export function ammPoolAccounts(): Set<string> {
  const out = new Set<string>()
  for (const m of byTag.get('xyk-pools')?.members ?? []) out.add(m.toLowerCase())
  return out
}
export function getTag(tagId: string): Tag | null {
  return byTag.get(tagId) ?? null
}
export function allTags(): Tag[] {
  return [...byTag.values()].sort((a, b) => a.name.localeCompare(b.name))
}

// system-account derivations
// A reserved system account is a short ASCII marker right-padded with zeros to 32
// bytes. Both forms below are that shape, so they share one derivation.
function paddedAccountId(marker: string, sub = ''): string {
  const body = Buffer.from(marker, 'latin1').toString('hex') + sub
  return ('0x' + body.padEnd(64, '0')).toLowerCase()
}
// "modl" pallet account: 0x6d6f646c + the 8-byte PalletId + zero padding — the ids
// are compile-time constants in the runtime (PalletId(*b"…")).
export function modlAccountId(palletId: string, sub = ''): string {
  return paddedAccountId('modl' + palletId, sub)
}
// The relay chain's sovereign account here: XCM's ParentIsPreset converter maps the
// `Parent` origin to the ASCII bytes "Parent", right-padded with zeros. The same
// marker the activity decoders recognise as an XCM origin (XCM_SOVEREIGN_PREFIXES
// in explorerService.ts).
export function parentSovereignAccountId(): string {
  return paddedAccountId('Parent')
}

// Tags are a fixed, code-defined set — there is no create/edit/delete API. This is
// the canonical definition; an empty `icon` derives the avatar from the first
// member's omniwatch emoji (e.g. Treasury → 🏦). seedDefaultTags() syncs this set
// into the database on every start, so a fresh database gets all of them and an
// existing one picks up additions.
//
// Deliberately tiny. Everything an address book can carry that is not derived from
// the chain itself is a claim about who owns an account, and a claim inherited from
// another network is simply false here — so this seed holds only accounts whose
// identity follows from a runtime constant, and syncStructuralTags() generates the
// rest (pool accounts, LM pots, sovereigns) from indexed data.
export const DEFAULT_TAGS: { tagId: string; name: string; color: string; note: string; icon: string; addresses: string[] }[] = [
  {
    // Explicit icon: with no explicit icon a tag borrows its first member's emoji,
    // and "first" follows account-id sort order — adding a member can silently
    // change the tag's face.
    tagId: 'treasury', name: 'Treasury', color: '', note: 'Basilisk treasury pallet account (PalletId py/trsry)', icon: '🏦',
    addresses: [modlAccountId('py/trsry')],
  },
  {
    // XCM's ParentIsPreset converter maps the relay's `Parent` origin to the ASCII
    // bytes "Parent" right-padded with zeros, so this is the account a Kusama-origin
    // Transact executes as on Basilisk. It holds nothing today — inbound KSM is
    // backed by Basilisk's sovereign account ON Kusama, not by this one — but it is
    // exact rather than speculative, and it is the one sovereign the structural
    // 'sovereigns' tag cannot find: that scan matches the 'sibl'/'para' markers, and
    // the relay carries neither.
    tagId: 'kusama-sovereign', name: 'Kusama Sovereign', color: '#e6007a',
    note: 'The Kusama relay chain\'s sovereign account on Basilisk (XCM Parent origin) — holds assets and dispatches calls on the relay\'s behalf',
    icon: '🛰️',
    addresses: [parentSovereignAccountId()],
  },
]

// Tags whose members are protocol PLUMBING (pools, pots, sovereign accounts) —
// excluded from "economic actor" surfaces like the BSX top movers, unlike the
// Treasury, which represents a deliberate actor. Every id here is defined by
// DEFAULT_TAGS or STRUCTURAL_TAGS; a name no definition claims silently suppresses
// nothing.
export const SYSTEM_TAG_IDS = new Set(['liquidity-mining', 'xyk-pools', 'lbp-pools', 'sovereigns', 'kusama-sovereign'])

// Tagged module (modl) accounts that count as economic actors — the top-movers
// exception list: module plumbing stays hidden, the Treasury's DCA program shows.
export function economicModuleAccounts(tags: Tag[]): string[] {
  return tags.filter(t => !SYSTEM_TAG_IDS.has(t.tagId))
    .flatMap(t => t.members)
    .filter(m => m.startsWith('0x6d6f646c'))
}

// Structural system-account families, derived from indexed data so they are
// recreated automatically after a from-scratch reindex and pick up new members
// (pools, farms, HRMP channels) on every sync:
//  - XYK and LBP pool accounts come with their PoolCreated event,
//  - liquidity-mining pots and sibling-parachain sovereigns are recognizable
//    by their account-id structure alone (prefix scan over known balances).
const LM_PREFIXES = ['OmniWhLM', 'Omni//LM', 'XYK///LM', 'xykLMpID'].map(id => ('0x' + Buffer.from('modl' + id, 'latin1').toString('hex')).toLowerCase())
// A sovereign account is 20 meaningful bytes + zero padding under one of two
// markers: 'sibl' for a sibling parachain, 'para' for a (relay-registered) para
// id. Matching only 'sibl' left the 'para' form untagged.
export const SOVEREIGN_PREFIXES = ['sibl', 'para'].map(id => ('0x' + Buffer.from(id, 'latin1').toString('hex')).toLowerCase())
const STRUCTURAL_TAGS = [
  { tagId: 'xyk-pools', name: 'XYK Pool', color: '#86c4f5', note: 'XYK AMM pair account — holds the pool reserves', icon: '💧' },
  { tagId: 'lbp-pools', name: 'LBP Pool', color: '#4a8fd6', note: 'Liquidity bootstrapping pool account — holds the reserves of a time-boxed token launch', icon: '💧' },
  { tagId: 'liquidity-mining', name: 'Liquidity Mining', color: 'var(--accent)', note: 'Liquidity-mining pallet pots (global/yield farm sub-accounts)', icon: '🚜' },
  { tagId: 'sovereigns', name: 'Parachain Sovereign', color: '#e6007a', note: 'Parachain sovereign account (sibl/para + para id) — holds assets on behalf of that chain', icon: '🛰️' },
] as const

export async function syncStructuralTags(): Promise<void> {
  const [xykRes, lbpRes, prefixRes] = await Promise.all([
    client.query({
      query: `SELECT DISTINCT JSONExtractString(args_json, 'pool') AS acc FROM price_data.raw_events WHERE event_name = 'XYK.PoolCreated'`,
      format: 'JSONEachRow',
    }),
    // LBP pools name their account on the creation event exactly as XYK does.
    client.query({
      query: `SELECT DISTINCT JSONExtractString(args_json, 'pool') AS acc FROM price_data.raw_events WHERE event_name = 'LBP.PoolCreated'`,
      format: 'JSONEachRow',
    }),
    client.query({
      query: `SELECT DISTINCT account_id FROM price_data.account_asset_latest_balances
              WHERE ${SOVEREIGN_PREFIXES.map(p => `startsWith(account_id, '${p}')`).join(' OR ')}
                 OR startsWith(account_id, '0x6d6f646c')`,
      format: 'JSONEachRow',
    }),
  ])
  const poolAccounts = (rows: { acc: string }[]): string[] =>
    rows.map(r => r.acc.toLowerCase()).filter(a => /^0x[0-9a-f]{64}$/.test(a))
  const xyk = poolAccounts(await xykRes.json<{ acc: string }>())
  const lbp = poolAccounts(await lbpRes.json<{ acc: string }>())
  const prefixAccounts = (await prefixRes.json<{ account_id: string }>()).map(r => r.account_id.toLowerCase())
  const membersByTag: Record<string, string[]> = {
    'xyk-pools': xyk,
    'lbp-pools': lbp,
    'liquidity-mining': prefixAccounts.filter(a => LM_PREFIXES.some(p => a.startsWith(p))),
    'sovereigns': prefixAccounts.filter(a => SOVEREIGN_PREFIXES.some(p => a.startsWith(p))),
  }
  const rows: Record<string, unknown>[] = []
  for (const def of STRUCTURAL_TAGS) {
    const existing = new Set(byTag.get(def.tagId)?.members ?? [])
    for (const account_id of new Set(membersByTag[def.tagId])) {
      if (existing.has(account_id) || byAccount.has(account_id)) continue // never steal an account from another tag
      rows.push({ label_id: def.tagId, label_name: def.name, color: def.color, note: def.note, icon: def.icon, account_id, deleted: 0 })
    }
  }
  if (!rows.length) return
  await client.insert({ table: 'price_data.account_tags', values: rows, format: 'JSONEachRow' })
  await loadTags()
  console.log(`[tags] synced ${rows.length} structural system account(s) (pools, LM pots, sovereigns)`)
}

let structuralTagRefreshTimer: ReturnType<typeof setInterval> | null = null
export function startStructuralTagRefresh(): void {
  if (structuralTagRefreshTimer) return
  structuralTagRefreshTimer = setInterval(() => { void syncStructuralTags().catch(() => {}) }, 60 * 60_000)
  structuralTagRefreshTimer.unref()
}

// Sync the code-defined tag set into the database: on a fresh database this
// creates every tag; on an existing one it inserts any tag or membership added
// to DEFAULT_TAGS since the last start. Idempotent — existing memberships are
// never rewritten. Called at startup after loadTags(); the only writer of
// price_data.account_tags.
export async function seedDefaultTags(): Promise<void> {
  const rows: Record<string, unknown>[] = []
  for (const def of DEFAULT_TAGS) {
    const existing = byTag.get(def.tagId)
    for (const address of def.addresses) {
      const n = normalizeAddress(address)
      if (!n?.accountId) {
        console.warn(`[tags] seed: could not resolve address ${address} for tag ${def.tagId}`)
        continue
      }
      if (existing?.members.includes(n.accountId)) continue
      // One account, one tag. Two definitions naming the same pot made its label
      // depend on insertion order — byAccount kept the last label_id, the grouped
      // SQL aggregates kept any() — and let a system pot escape the suppression the
      // other tag exists to apply. syncStructuralTags guards the same way.
      const claimed = tagForAccount(n.accountId)
      if (claimed && claimed.tagId !== def.tagId) {
        console.warn(`[tags] seed: ${n.accountId} is already tagged ${claimed.tagId}; skipping ${def.tagId}`)
        continue
      }
      rows.push({ label_id: def.tagId, label_name: def.name, color: def.color, note: def.note, icon: def.icon, account_id: n.accountId, deleted: 0 })
    }
  }
  if (!rows.length) return
  await client.insert({ table: 'price_data.account_tags', values: rows, format: 'JSONEachRow' })
  await loadTags()
  console.log(`[tags] synced ${rows.length} tag membership(s) from DEFAULT_TAGS`)
}

// A tag's presentation — name, color, note, icon — is canonical in code
// (DEFAULT_TAGS / STRUCTURAL_TAGS); there is no edit API. But membership
// rows are only ever INSERTED (seed and the structural sync skip accounts that
// already exist), so editing any of those in code would otherwise never reach an
// already-seeded database: loadTags() reads them from the table, and the
// Accounts/Holders aggregates read color and name straight from SQL. Renaming a
// tag in code and seeing the old name survive is the failure this prevents.
// Reconcile the stored row to the code definition with an in-place mutation.
// Idempotent — a tag already matching is skipped, so it costs nothing on
// subsequent starts.
// Membership rows are only ever INSERTED, so removing a tag from code leaves its
// rows behind and loadTags keeps serving them — a retired tag would go on labelling
// its account (and, when two tags named one pot, keep winning by label_id order).
// Tombstone the rows of any label_id no code definition claims. Idempotent: the
// deleted = 0 guard makes it a no-op once the table matches.
export async function retireUnknownTagMemberships(): Promise<void> {
  const known = new Set<string>([...DEFAULT_TAGS, ...STRUCTURAL_TAGS].map(d => d.tagId))
  const stale = [...byTag.keys()].filter(tagId => !known.has(tagId))
  if (!stale.length) return
  await client.command({
    query: `ALTER TABLE price_data.account_tags UPDATE deleted = 1 WHERE label_id IN {tagIds:Array(String)} AND deleted = 0`,
    query_params: { tagIds: stale },
    clickhouse_settings: { mutations_sync: '1' },
  })
  await loadTags()
  console.log(`[tags] retired ${stale.length} tag(s) no longer defined in code: ${stale.join(', ')}`)
}

export async function reconcileTagPresentation(): Promise<void> {
  type Presentation = { name: string; color: string; note: string; icon: string }
  const want = new Map<string, Presentation>()
  for (const d of [...DEFAULT_TAGS, ...STRUCTURAL_TAGS]) want.set(d.tagId, { name: d.name, color: d.color, note: d.note, icon: d.icon })
  let changed = 0
  for (const [tagId, p] of want) {
    const tag = byTag.get(tagId)
    if (!tag) continue
    // loadTags() resolves an empty icon to the first member's avatar, so the
    // in-memory icon is a derived value, not the stored one — comparing against
    // it would rewrite every derived-icon tag on every start. A tag that defines
    // no icon has nothing to reconcile.
    const iconDiffers = p.icon !== '' && tag.icon !== p.icon
    if (tag.name === p.name && tag.color === p.color && tag.note === p.note && !iconDiffers) continue
    await client.command({
      query: `ALTER TABLE price_data.account_tags
              UPDATE label_name = {name:String}, color = {color:String}, note = {note:String}${p.icon !== '' ? ', icon = {icon:String}' : ''}
              WHERE label_id = {tagId:String}`,
      query_params: { name: p.name, color: p.color, note: p.note, icon: p.icon, tagId },
      clickhouse_settings: { mutations_sync: '1' },
    })
    changed++
  }
  if (changed) {
    await loadTags()
    console.log(`[tags] reconciled presentation for ${changed} tag(s) from code definitions`)
  }
}
