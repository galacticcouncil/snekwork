/* eslint-disable react-refresh/only-export-components -- activity table exports slug/id/label helpers alongside its components */
import { Link, paths } from '../router'
import type { ActivitySlug } from '../router'
import { F, AddrPill, AssetChip, rowNav, Ago, AccountEmoji, ShortAddr, TagIcon, tagMemberSuffix, VoteSideBadge, TableSkeleton, Dash, EmptyRow, ErrorRow, pendingRows, LiveAnchor } from './ui'
import { useNewRows } from '../hooks/useNewRows'
import { activityBadge } from './activityColors'
import { resolveTag } from '../systemTags'
import { convictionLabel, voteSubjectLabel } from '../utils/voteRows'
import type { ActivityRow } from '../types'

// Chain badge for cross-chain (XCM) destinations — full network names, brand
// gradients for the frequent chains, neutral gray for the rest. The keys are the
// names PARACHAIN_META and RELAY_XCM_NETWORK emit in api/src/services/
// explorerService.ts; a name this map does not carry still renders, in gray.
// Basilisk sits on Kusama, so these are Kusama's chains — a Polkadot para id names
// something else entirely at the same number.
//
// Kusama and its AssetHub take the near-black of Kusama's own brand, the system
// chain cast faintly blue to tell it from the relay. Black also keeps them clear of
// the accent the local badge owns, which every counterparty here has to stay off:
// two chips a few degrees of hue apart read as one at 9px.
const CHAIN_COLORS: Record<string, [string, string]> = {
  Kusama: ['#3a3a3a', '#0f0f0f'],
  AssetHub: ['#333f4e', '#121820'],
  Karura: ['#ff4c3b', '#c2261a'],
  Bifrost: ['#5a25f0', '#3a10b0'],
  Khala: ['#c4f142', '#96c214'],
  Shiden: ['#7b3fe4', '#4f1fa8'],
  Integritee: ['#1f9dd6', '#116b96'],
  Moonriver: ['#f2a007', '#b06e05'],
  Robonomics: ['#2b6cb0', '#16406e'],
  Calamari: ['#29b6af', '#177a75'],
  Picasso: ['#c90e7c', '#8a0a55'],
  Kintsugi: ['#d4a017', '#96700d'],
  Quartz: ['#ff4d6a', '#c22343'],
  Crab: ['#ff0083', '#b5005d'],
  Mangata: ['#ff7a00', '#c25400'],
  Turing: ['#00b9a3', '#008072'],
}
export function ChainBadge({ chain }: { chain: string }) {
  const c = CHAIN_COLORS[chain] ?? ['#666', '#444']
  return <span className="chain-badge" style={{ background: `linear-gradient(135deg,${c[0]},${c[1]})` }} title={chain}>{chain || '?'}</span>
}
// The local end of a cross-chain hop. Every hop has Basilisk at one end, and
// naming it is what makes the arrow's direction readable — a row saying only
// "AssetHub → USDC 55" leaves the reader to work out which side the asset landed
// on. It takes the brand accent from the theme rather than a per-chain brand pair,
// so the one chain that is always us never reads as just another counterparty.
export function BasiliskBadge() {
  return <span className="chain-badge chain-badge-local" title="Basilisk">Basilisk</span>
}
// The external-explorer label follows the link target — cross-chain accounts
// live on Subscan for substrate chains, Solscan/Etherscan for Solana/Ethereum.
// Every explorer a bridged journey can reach, so a Base link never says "Subscan".
// Ordered longest-suffix first where hosts nest (optimistic.etherscan.io).
const EXPLORER_SITES: [string, string][] = [
  ['optimistic.etherscan.io', 'Etherscan'],
  ['solscan.io', 'Solscan'],
  ['etherscan.io', 'Etherscan'],
  ['basescan.org', 'Basescan'],
  ['arbiscan.io', 'Arbiscan'],
  ['bscscan.com', 'BscScan'],
  ['polygonscan.com', 'Polygonscan'],
  ['suiscan.xyz', 'Suiscan'],
]
export function explorerSiteName(url: string): string {
  try {
    const host = new URL(url).hostname
    for (const [suffix, name] of EXPLORER_SITES) if (host.endsWith(suffix)) return name
  } catch { /* fall through */ }
  return 'Subscan'
}
export function ExternalAccountPill({ account }: { account: NonNullable<ActivityRow['destAccount']> }) {
  // Prefer the server-resolved canonical accountId: for an AccountId32 it
  // already equals `raw`, but for a bound-EVM AccountKey20 `raw` is the bare
  // H160, not the accountId user tags/avatars are keyed by — using `raw` there
  // silently failed to match either. Fall back to `raw`/`address` only for a
  // response that predates this field (old cache entry or test fixture).
  const iconSeed = account.accountId || account.raw || account.address
  const resolved = resolveTag({ tag: account.tag ?? null })
  const identity = account.identity
  // Same pubkey, same tag/identity, even on another chain — resolved tag >
  // identity, mirroring AddrPill's name precedence and classes (the "tag" class
  // + small ✓ for a verified on-chain identity). The short address keeps showing
  // via the pill's title when a name takes its place in the body.
  const name = resolved
    ? <><span className="tag" style={resolved.color ? { color: resolved.color } : undefined}>{resolved.name}</span>{tagMemberSuffix(resolved, account.address)}</>
    : identity?.display
      ? <>
        <span className="tag">{identity.display}</span>
        {identity.verified && <span className="id-verified" title="Verified identity">✓</span>}
      </>
      : null
  const body = <>
    {resolved
      ? <TagIcon icon={resolved.icon} title={resolved.name} />
      : <AccountEmoji account={{ accountId: iconSeed, emoji: account.emoji, emojiName: account.emojiName, emojiUrl: account.emojiUrl }} />}
    {name ?? <span className="a mono"><ShortAddr addr={account.address} /></span>}
  </>
  if (!account.subscanUrl) return <span className="addr-pill" title={account.address}>{body}</span>
  const site = explorerSiteName(account.subscanUrl)
  return <a className="addr-pill ext-account" href={account.subscanUrl} target="_blank" rel="noopener" title={`${account.address} · opens ${site}`} data-no-hover="true">{body}<span className="ext-site">{site}</span></a>
}

// Row label + category color both live in activityColors, so the coding stays
// one edit wide across every surface that shows an activity.
const badge = activityBadge

// Canonical detail-page slug for a activity row — mirrors badge() labels.
export function activitySlug(r: ActivityRow): ActivitySlug {
  switch (r.type) {
    case 'trade': return 'swap'
    case 'xcm': return 'cross-chain'
    case 'liquidity': return r.liqAction === 'Remove' ? 'remove-liquidity' : r.liqAction === 'Create' ? 'create-pool' : r.liqAction === 'Destroy' ? 'destroy-pool' : r.liqAction === 'Claim' ? 'claim-rewards' : 'add-liquidity'
    case 'vote': return 'vote'
    default: return 'transfer'
  }
}
export function activityId(r: ActivityRow): string | null {
  if (r.eventIndex != null) return `${r.blockHeight}-e${r.eventIndex}`
  if (r.extrinsicIndex != null) return `${r.blockHeight}-${r.extrinsicIndex}`
  return null
}
const SLUG_LABEL: Record<ActivitySlug, string> = {
  swap: 'Swap', transfer: 'Transfer', 'cross-chain': 'Cross-chain',
  'add-liquidity': 'Add liquidity', 'remove-liquidity': 'Remove liquidity', 'create-pool': 'Create pool', 'destroy-pool': 'Destroy pool', 'claim-rewards': 'Claim rewards',
  vote: 'Vote',
}
export function activityLabel(slug: ActivitySlug): string { return SLUG_LABEL[slug] }

// Coarse activity type(s) an id is matched against — action-level slugs of the
// same family are interchangeable at resolve time (slug is presentation).
export const SLUG_TYPES: Record<ActivitySlug, ActivityRow['type'][]> = {
  swap: ['trade'], transfer: ['transfer'],
  'cross-chain': ['xcm'], 'add-liquidity': ['liquidity'], 'remove-liquidity': ['liquidity'], 'create-pool': ['liquidity'], 'destroy-pool': ['liquidity'], 'claim-rewards': ['liquidity'],
  vote: ['vote'],
}

export function parseId(id: string): { height: number; eventIndex: number | null; extrinsicIndex: number | null } | null {
  const m = /^(\d+)-(e)?(\d+)$/.exec(id)
  if (!m) return null
  return { height: Number(m[1]), eventIndex: m[2] ? Number(m[3]) : null, extrinsicIndex: m[2] ? null : Number(m[3]) }
}

// Canonical URL for a resolved row, or null when the current slug+id are already canonical.
export function canonicalTarget(row: ActivityRow, slug: ActivitySlug, id: string): string | null {
  const canonicalSlug = activitySlug(row)
  const canonicalId = activityId(row) ?? id
  return canonicalSlug !== slug || canonicalId !== id ? paths.activityDetail(canonicalSlug, canonicalId) : null
}

// Where an event that is NOT an activity of its own belongs: the activity whose
// extrinsic it is part of. The transfer legs and fee withdrawals of an OTC fill, a
// swap are that action's plumbing — real events, deliberately
// not rendered as rows — so an id naming one resolves to no row at all.
//
// Only an extrinsic with exactly ONE activity hands over unambiguously. A batch
// holding several would make the choice arbitrary, so it returns null and the caller
// says so instead, pointing at the extrinsic that lists them all.
export function subordinateActivityTarget(rows: ActivityRow[], extrinsicIndex: number | null | undefined): string | null {
  if (extrinsicIndex == null) return null
  const owners = rows.filter(r => r.extrinsicIndex === extrinsicIndex)
  if (owners.length !== 1) return null
  const owner = owners[0]
  const ownerId = activityId(owner)
  return ownerId
    ? paths.activityDetail(activitySlug(owner), ownerId)
    : paths.extrinsic(`${owner.blockHeight}-${owner.extrinsicIndex}`)
}

// Conviction beside the side badge. It carries its own word because on a
// narrow screen the row wraps and the multiplier lands alone on a line, where
// a bare "6x" reads as a stray number rather than as how hard someone voted.
export function ConvictionTag({ conviction }: { conviction: string | null | undefined }) {
  const label = convictionLabel(conviction)
  if (!label) return null
  return <span className="muted conviction-tag" title="Conviction — the lock multiplier applied to this vote">{label}</span>
}

export function ActivityBadge({ r }: { r: ActivityRow }) {
  const { label, col } = badge(r)
  return <span className="activity-badge-group"><span className="pill-badge" style={{ color: col, background: `color-mix(in srgb, ${col} 15%, transparent)` }}>{label}</span></span>
}

// One row's activity, as a phrase. `headed` marks a surface whose page HEADER
// already states the row's context — the detail pages do, a list row has no header
// above it — so there the phrase drops the facts the header repeats and keeps only
// what it alone carries (the assets and amounts).
export function ActivityDesc({ r, headed }: { r: ActivityRow; headed?: boolean }) {
  // A hop's two ends ARE its phrase, so cross-chain is the one family that keeps
  // them on a headed surface too. Naming one end in a page subtitle is not the same
  // as drawing the journey: this page's Activity row used to read "AAVE 30.4" and
  // say nothing about where it came from or landed. So both xcm branches below
  // ignore `headed` for the chain badges, and the detail page reads like its row.
  if (r.type === 'xcm' && r.xcmDir === 'in' && r.asset) {
    // Inbound: origin chain, then the arrow, then the chain it landed on with
    // the asset it credited.
    return <span className="asset-flow"><ChainBadge chain={r.fromChain ?? ''} /> → <BasiliskBadge /><span className="trade-leg"><AssetChip asset={r.asset} /> <span className="mono">{F.amount(r.amount, r.asset.decimals)}</span></span></span>
  }
  if ((r.type === 'transfer' || r.type === 'xcm') && r.asset) {
    // Asset first, then the arrow, then the destination chain and account.
    const destChain = r.type === 'xcm' && r.destChain ? <ChainBadge chain={r.destChain} /> : null
    const destAccount = r.type === 'xcm'
      ? (r.destAccount ? <ExternalAccountPill account={r.destAccount} /> : null)
      : (r.to ? <AddrPill account={r.to} noCopy /> : null)
    const dest = destChain || destAccount ? <>{destChain}{destAccount}</> : null
    // Outbound needs the chain it left as much as inbound needs the one it reached,
    // and the asset sits beside it either way — it is the Basilisk balance that
    // moved. A local badge only earns its place opposite a counterparty, so a plain
    // local transfer and an outbound hop with nothing left to point at both skip it.
    const local = r.type === 'xcm' && dest ? <BasiliskBadge /> : null
    return <span className="asset-flow">{local}<span className="trade-leg"><AssetChip asset={r.asset} /> <span className="mono">{F.amount(r.amount, r.asset.decimals)}</span></span>{dest ? <> → {dest}</> : null}</span>
  }
  if (r.type === 'trade' && r.assetIn && r.assetOut) {
    return <span className="asset-flow"><span className="trade-leg"><AssetChip asset={r.assetIn} /> <span className="mono">{F.amount(r.amountIn, r.assetIn.decimals)}</span></span> → <span className="trade-leg"><AssetChip asset={r.assetOut} /> <span className="mono">{F.amount(r.amountOut, r.assetOut.decimals)}</span></span></span>
  }
  if (r.type === 'liquidity' && r.liqAction === 'Create' && r.assetIn && r.assetOut) {
    // Pool creation seeds two assets — show both legs side by side.
    return <span className="asset-flow"><span className="trade-leg"><AssetChip asset={r.assetIn} /> <span className="mono">{F.amount(r.amountIn, r.assetIn.decimals)}</span></span> + <span className="trade-leg"><AssetChip asset={r.assetOut} /> <span className="mono">{F.amount(r.amountOut, r.assetOut.decimals)}</span></span></span>
  }
  if (r.type === 'liquidity' && r.asset) {
    return <span className="asset-flow"><span className="trade-leg"><AssetChip asset={r.asset} /> <span className="mono">{F.amount(r.amount, r.asset.decimals)}</span></span></span>
  }
  if (r.type === 'vote' && r.asset) {
    const locked = <span className="trade-leg"><AssetChip asset={r.asset} /> <span className="mono">{F.amount(r.amount, r.asset.decimals)}</span></span>
    // Headed, the referendum, the side and the conviction are all in the page title's
    // own subtitle, so the locked capital is the one fact left to state; the
    // referendum stays reachable through that page's Referendum row.
    if (headed) return <span className="asset-flow">{locked}</span>
    // A referendum's title says what the vote was about; "Ref 255" does not. The
    // title comes from SubSquare and may not be fetched yet, so the index is the
    // fallback rather than a placeholder. Only ConvictionVoting/Democracy rows have a
    // referendum page — Council/TC votes carry a proposal hash instead, which is why
    // the label is shared with the votes table (see voteSubjectLabel).
    // The index identifies the referendum, the title says what it is: show the index
    // muted ahead of a plain link on the title, which carries the referendum hover
    // card. A hash is not an index, so a motion leads with its label alone.
    return <span className="asset-flow">{locked}
      {r.voteRef && r.voteRefPallet && <span className="muted mono ref-num">#{r.voteRef}</span>}
      {r.voteRefPallet && r.voteRef
        ? <Link to={paths.referendum(r.voteRefPallet, r.voteRef)} className="ref-link">{r.voteRefTitle ?? 'Referendum'}</Link>
        : <span className="muted">{voteSubjectLabel(r.voteRef, r.voteRefPallet, r.voteRefTitle)}</span>}
      <VoteSideBadge side={r.voteSide} /><ConvictionTag conviction={r.voteConviction} /></span>
  }
  return null
}

// Stable identity for a activity row, for React keys + live new-row detection.
function activityKey(r: ActivityRow): string {
  return [r.type, r.blockHeight, r.extrinsicIndex ?? r.eventIndex ?? '', r.assetIn?.assetId ?? r.asset?.assetId ?? '',
    r.assetOut?.assetId ?? '', r.amountIn ?? r.amount ?? '', r.who?.accountId ?? ''].join('|')
}

// `pageSize` sizes the loading skeleton, so a paged feed reserves the height it is
// about to fill and the pager beneath it does not jump. Unpaged surfaces (a block's
// or extrinsic's own activity) show whatever the record holds and leave it unset.
export function ActivityTable({ rows, noActor, now, live, anchorRef, loading, pending, error, onRetry, pageSize }: { rows: ActivityRow[]; noActor?: boolean; now: number; live?: boolean; anchorRef?: (el: HTMLElement | null) => void; loading?: boolean; pending?: boolean; error?: unknown; onRetry?: () => void; pageSize?: number }) {
  const cols = noActor ? 4 : 5
  // Deduped stable keys: same row → same key across renders (so prepended live rows
  // are detected as new without remounting the rest); duplicates get a suffix.
  const seen = new Map<string, number>()
  const keys = rows.map(r => { const b = activityKey(r); const n = seen.get(b) ?? 0; seen.set(b, n + 1); return n ? `${b}#${n}` : b })
  const fresh = useNewRows(keys, !!live)
  return (
    <div className="panel"><LiveAnchor anchorRef={anchorRef} /><table className="tbl">
      <thead><tr><th>Type</th>{!noActor && <th>Account</th>}<th>Activity</th><th className="r">Value</th><th className="r">Time</th></tr></thead>
      <tbody {...pendingRows(pending)}>
        {loading && !rows.length ? <TableSkeleton cols={cols} rows={pageSize} />
          : error && !rows.length ? <ErrorRow cols={cols} title="Couldn’t load activity" error={error} onRetry={onRetry} />
            : !rows.length ? <EmptyRow cols={cols}>No activity</EmptyRow>
              : rows.map((r, i) => {
                const slug = activitySlug(r)
                const aid = activityId(r)
                // De-emphasise low-/zero-value activity (null treated as low) so high-value rows stand out. Not hidden — just muted via the .dim class.
                const dim = r.valueUsd == null || r.valueUsd < 10
                // Unfinalized rows have no detail page yet (the classifier runs
                // at finality) — dimmed and non-navigable until then.
                const unfinalized = r.finalized === false
                const nav = aid && !unfinalized ? rowNav(paths.activityDetail(slug, aid)) : null
                const k = keys[i]
                const className = [nav?.className, dim ? 'dim' : null, fresh.has(k) ? 'row-new' : null, unfinalized ? 'unfinalized' : null].filter(Boolean).join(' ') || undefined
                const title = unfinalized ? 'Awaiting finality — may still reorganize' : undefined
                const showExt = slug !== 'swap' && r.extrinsicIndex != null
                return (
                  <tr key={k} {...(nav ?? {})} className={className} title={title} {...(aid && !unfinalized ? { 'data-activity': `${slug}/${aid}` } : {})} {...(showExt ? { 'data-ext': `${r.blockHeight}-${r.extrinsicIndex}` } : {})}>
                    <td data-label="Type"><ActivityBadge r={r} /></td>
                    {!noActor && <td data-label="Account">{r.who ? <AddrPill account={r.who} noCopy /> : <Dash />}</td>}
                    <td data-label="Activity"><ActivityDesc r={r} /></td>
                    <td data-label="Value" className="r mono">{r.valueUsd != null ? F.usd(r.valueUsd) : <Dash />}</td>
                    <td data-label="Time" className="r mono muted"><Ago ts={r.timestamp} now={now} /></td>
                  </tr>
                )
              })}
      </tbody>
    </table></div>
  )
}
