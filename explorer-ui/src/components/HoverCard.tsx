import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/explorer'
import { useAddressSummary, useAsset, useExtrinsic, useBlock, useTagSummary, useTrade, useStats } from '../hooks/useExplorerData'
import { F, AssetIcon, FeeAmount, hasTip, AddrPill, CallPill, PoolBadge, poolHref, StatusBadge, FinalizedBadge, AccountEmoji, emojiName, moduleName, TagIcon, TokenIconRow, UserTagPill } from './ui'
import { ayeSharePct, selectTally } from '../utils/referendumVotes'
import { resolveTag, allAssociations } from '../systemTags'
import type { AssetRef } from '../types'

// Global hover preview cards for account (.addr-pill), tag (/tag/… links),
// asset (.asset-chip), trade ([data-activity] with slug swap / /swap/…),
// extrinsic (a.hash / [data-ext] → /extrinsic/…) and block (/block/…) links.
// Each card mirrors the basic-info block of its detail page. Mounted once in App.
type VoteContext = { side: string; conviction: string; weighted: string }
type Target = {
  kind: 'account' | 'tag' | 'asset' | 'trade' | 'extrinsic' | 'block' | 'referendum'
  id: string
  vote?: VoteContext
  left: number; top: number; bottom: number
}
const SELECTOR = '.addr-pill:not([data-no-hover]), .asset-chip, a.hash, a[href*="/swap/"], a[href*="/block/"], a[href*="/referendum/"], [data-activity], [data-ext]'
const HOVER_DWELL_MS = 180

function ProfileMetrics({ portfolioUsd, tradingVolumeUsd, topAssets }: {
  portfolioUsd: number
  tradingVolumeUsd?: number | null
  topAssets?: { asset: AssetRef; valueUsd: number }[]
}) {
  return (
    <>
      <div className="hc-row"><span>Value</span><span className="mono">{F.usd(portfolioUsd)}</span></div>
      {topAssets && topAssets.length > 0 && <div className="hc-row"><span>Holdings</span><TokenIconRow assets={topAssets} size={18} /></div>}
      {(tradingVolumeUsd ?? 0) > 0 && <div className="hc-row"><span>Trading volume</span><span className="mono">{F.usd(tradingVolumeUsd)}</span></div>}
    </>
  )
}

// Same two facts the votes tables keep — the vote cast and the conviction-
// weighted votes it carries. For a tag bubble the conviction slot holds the
// group's capital-weighted average plus its voter count ("6.0x avg · 3
// accounts"), exactly what the tag page's grouped votes view shows per row.
function VoteContextRows({ vote }: { vote?: VoteContext }) {
  if (!vote) return null
  return (
    <>
      <div className="hc-row"><span>Vote</span><span className="mono">{vote.side}{vote.conviction ? ` · ${vote.conviction}` : ''}</span></div>
      <div className="hc-row"><span>Votes</span><span className="mono">{vote.weighted}</span></div>
    </>
  )
}

// A vote bubble is an account pill that also knows how that account voted, so the
// card can add the side, conviction and weighted power to the usual account rows.
function voteContext(el: Element): VoteContext | undefined {
  const host = el.closest('[data-vote-side]')
  if (!host) return undefined
  return {
    side: host.getAttribute('data-vote-side') ?? '',
    conviction: host.getAttribute('data-vote-conviction') ?? '',
    weighted: host.getAttribute('data-vote-weighted') ?? '',
  }
}

function parseTarget(el: Element): Omit<Target, 'left' | 'top' | 'bottom'> | null {
  if (el.closest('[data-no-hover]')) return null
  const act = el.getAttribute('data-activity')
  if (act) {
    const [slug, id] = act.split('/')
    if (slug === 'swap') return { kind: 'trade', id }
    const ext = el.getAttribute('data-ext')
    return ext ? { kind: 'extrinsic', id: ext } : null
  }
  const ext = el.getAttribute('data-ext'); if (ext) return { kind: 'extrinsic', id: ext }
  const href = el.getAttribute('href') || ''
  if (/^https?:\/\//i.test(href)) {
    try {
      const url = new URL(href)
      if (url.origin !== window.location.origin) return null
    } catch { return null }
  }
  const rm = href.match(/\/referendum\/(opengov|democracy)\/(\d+)$/); if (rm) return { kind: 'referendum', id: `${rm[1]}/${rm[2]}` }
  const am = href.match(/\/account\/([^?#]+)$/); if (am) return { kind: 'account', id: decodeURIComponent(am[1]), vote: voteContext(el) }
  // A user tag's aggregate view now shares the system /tag/:id namespace —
  // disambiguate via the viewer's own tag-map, same as TagDetail's own routing.
  const tm = href.match(/\/tag\/([^?#]+)$/)
  if (tm) {
    const id = decodeURIComponent(tm[1])
    // A folded tag bubble knows how the group voted, same as an account bubble.
    const vote = voteContext(el)
    return { kind: 'tag', id, vote }
  }
  const sm = href.match(/\/asset\/(\d+)$/); if (sm) return { kind: 'asset', id: sm[1] }
  const trm = href.match(/\/(?:trade|swap)\/([^?#]+)$/); if (trm) return { kind: 'trade', id: decodeURIComponent(trm[1]) }
  const xm = href.match(/\/extrinsic\/([^?#]+)$/); if (xm) return { kind: 'extrinsic', id: decodeURIComponent(xm[1]) }
  const bm = href.match(/\/block\/(\d+)(?:[?#]|$)/); if (bm) return { kind: 'block', id: bm[1] }
  return null
}

export function HoverCards() {
  const [target, setTarget] = useState<Target | null>(null)
  const showTimer = useRef<number | undefined>(undefined)
  const hideTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    function onOver(e: MouseEvent) {
      const t = e.target as HTMLElement
      if (t.closest('.hovercard')) return
      if (t.closest('[data-no-hover]')) return
      const el = t.closest(SELECTOR)
      if (!el) return
      if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return
      const parsed = parseTarget(el)
      if (!parsed) return
      window.clearTimeout(showTimer.current)
      window.clearTimeout(hideTimer.current)
      // Avoid full account/asset/detail requests when the pointer merely sweeps
      // across a table. Leaving before the dwell expires cancels the query wholly.
      showTimer.current = window.setTimeout(() => {
        if (!el.isConnected) return
        const r = el.getBoundingClientRect()
        setTarget({ ...parsed, left: r.left, top: r.top, bottom: r.bottom })
      }, HOVER_DWELL_MS)
    }
    function onOut(e: MouseEvent) {
      if ((e.target as HTMLElement).closest('[data-no-hover]')) return
      const el = (e.target as HTMLElement).closest(SELECTOR)
      if (!el) return
      if (e.relatedTarget instanceof Node && (el.contains(e.relatedTarget) || (e.relatedTarget as Element).closest?.('.hovercard'))) return
      window.clearTimeout(showTimer.current)
      hideTimer.current = window.setTimeout(() => setTarget(null), 160)
    }
    // Close the card as soon as navigation happens — clicking a link (incl. the
    // card's own "View …" link or a row) changes the route; without this the card
    // lingers over the next page until the mouse moves.
    const onNav = () => { window.clearTimeout(showTimer.current); window.clearTimeout(hideTimer.current); setTarget(null) }
    document.addEventListener('mouseover', onOver)
    document.addEventListener('mouseout', onOut)
    window.addEventListener('popstate', onNav)
    window.addEventListener('explorer:navigation', onNav)
    document.addEventListener('click', onNav, true)
    return () => {
      document.removeEventListener('mouseover', onOver)
      document.removeEventListener('mouseout', onOut)
      window.clearTimeout(showTimer.current)
      window.clearTimeout(hideTimer.current)
      window.removeEventListener('popstate', onNav)
      window.removeEventListener('explorer:navigation', onNav)
      document.removeEventListener('click', onNav, true)
    }
  }, [])

  if (!target) return null
  const W = 360
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 9999
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 9999
  const cardWidth = Math.min(W, Math.max(0, viewportWidth - 24))
  const left = Math.max(12, Math.min(target.left, viewportWidth - cardWidth - 12))
  // The card is `position: fixed` and placed in viewport coordinates, so it never
  // extends the document height. An absolutely-positioned card dropped below a
  // pill near the page bottom grew the page, which flip-flopped the layout and
  // made the card flicker. Flip above the anchor when there isn't room below, and
  // cap the height so the card always fits the viewport.
  const spaceBelow = viewportHeight - target.bottom
  const placeAbove = spaceBelow < 240 && target.top > spaceBelow
  const vStyle = placeAbove
    ? { bottom: Math.round(viewportHeight - target.top + 8), maxHeight: Math.max(96, Math.round(target.top - 16)) }
    : { top: Math.round(target.bottom + 8), maxHeight: Math.max(96, Math.round(spaceBelow - 16)) }
  return (
    <div className="hovercard" style={{ left, overflowY: 'auto', ...vStyle }}
      onMouseEnter={() => window.clearTimeout(hideTimer.current)}
      onMouseLeave={() => setTarget(null)}>
      {target.kind === 'account' ? <AccountHover id={target.id} vote={target.vote} />
        : target.kind === 'tag' ? <TagHover id={target.id} vote={target.vote} />
        : target.kind === 'asset' ? <AssetHover id={Number(target.id)} />
        : target.kind === 'trade' ? <TradeHover id={target.id} />
        : target.kind === 'referendum' ? <ReferendumHover id={target.id} />
        : target.kind === 'block' ? <BlockHover id={Number(target.id)} />
        : <ExtrinsicHover id={target.id} />}
    </div>
  )
}

// Referendum card: what the vote was and where it stands. Asks for limit=1 because
// only the tallies and counts are shown here — the full voter list belongs to the
// page, and the endpoint caches its vote scan for a minute either way.
function ReferendumHover({ id }: { id: string }) {
  const [pallet, index] = id.split('/')
  const { data } = useQuery({
    queryKey: ['referendum-hover', pallet, index],
    queryFn: ({ signal }) => api.referendum(pallet as 'opengov' | 'democracy', Number(index), signal, 1),
    staleTime: 60_000,
  })
  if (!data) return <div className="hc-sub mono">Loading…</div>
  // Same selection and same BigInt share the page uses, so the card cannot say a
  // different percentage than the page it links to, and the AYE row still names its
  // source when the chain published no tally of its own (every Democracy referendum).
  const tally = selectTally(data)
  const ayePct = ayeSharePct(tally.ayes, tally.nays)
  return (
    <>
      <div className="hc-head">
        <span className="hc-emoji">🗳️</span>
        <div style={{ minWidth: 0 }}>
          <div className="hc-title">{data.title ?? `Referendum #${data.index}`}</div>
          <div className="hc-sub mono">{pallet === 'democracy' ? 'Democracy' : 'OpenGov'} #{data.index} · {data.status}{data.track != null ? ` · track ${data.track}` : ''}</div>
        </div>
      </div>
      {ayePct != null && <div className="tally-bar" style={{ marginBottom: 8 }}>
        <div className="tally-aye" style={{ width: `${ayePct}%` }} />
        <div className="tally-nay" style={{ width: `${100 - ayePct}%` }} />
      </div>}
      {ayePct != null && <div className="hc-row">
        <span>{tally.source === 'chain' ? 'AYE' : 'AYE (attributed)'}</span>
        <span className="mono">{ayePct.toFixed(1)}%</span>
      </div>}
      <div className="hc-row"><span>Voters</span><span className="mono">{F.int(data.directTally.voters)}</span></div>
      <div className="hc-row"><span>AYE / NAY</span><span className="mono">{F.int(data.directTally.ayeVoters)} / {F.int(data.directTally.nayVoters)}</span></div>
    </>
  )
}

// Compact account card: display name (priority tag / module / identity
// / emoji name) and the value. No address — the pill being hovered already shows
// it.
const MAX_HOVER_TAGS = 4
function AccountHover({ id, vote }: { id: string; vote?: VoteContext }) {
  const { data } = useAddressSummary(id)
  if (!data) return <div className="hc-sub mono">Loading…</div>
  const mod = moduleName(data.accountId)
  const topAssets = data.topAssets
  const resolved = resolveTag(data)
  const ident = data.identity
  const title = resolved?.name ?? mod ?? ident?.display ?? data.emojiName ?? emojiName(data.emoji) ?? 'Account'
  // The ✓ mark stays exclusive to a genuinely displayed, verified on-chain
  // identity — never a tag/module label.
  const showIdentityCheck = !resolved && !mod && !!ident?.display && ident.verified
  const associations = allAssociations(data)
  return (
    <>
      <div className="hc-head">
        {resolved
          ? <TagIcon icon={resolved.icon} title={resolved.name} className="hc-emoji" />
          : mod ? <span className="hc-emoji">⚙️</span>
            : <AccountEmoji account={data} className="hc-emoji" />}
        <div style={{ minWidth: 0 }}>
          <div className="hc-title">{title}
            {resolved ? <span className="em" style={resolved.color ? { color: resolved.color } : undefined}> · tag</span>
              : showIdentityCheck && <span className="id-verified" title="Verified identity" style={{ marginLeft: 5 }}>✓</span>}</div>
        </div>
      </div>
      {associations.length > 0 && (
        <div className="hc-tags">
          {associations.slice(0, MAX_HOVER_TAGS).map(a => (
            <UserTagPill key={`system-${a.id}`} tag={a} address={data.ss58} noCopy />
          ))}
          {associations.length > MAX_HOVER_TAGS && <span className="hc-tags-more">+{associations.length - MAX_HOVER_TAGS}</span>}
        </div>
      )}
      <VoteContextRows vote={vote} />
      <ProfileMetrics {...data} topAssets={topAssets} />
    </>
  )
}

// Tag chips (grouped accounts): the tag identity plus the combined metrics of
// all member accounts — the same figures the tag detail header shows.
function TagHover({ id, vote }: { id: string; vote?: VoteContext }) {
  const { data } = useTagSummary(id)
  if (!data) return <div className="hc-sub mono">Loading…</div>
  const topAssets = data.topAssets
  return (
    <>
      <div className="hc-head">
        <TagIcon icon={data.icon} title={data.name} className="hc-emoji" />
        <div>
          <div className="hc-title">{data.name}<span className="em" style={{ color: data.color }}> · tag</span></div>
          <div className="hc-sub mono">{data.members.length} account{data.members.length === 1 ? '' : 's'}</div>
        </div>
      </div>
      <VoteContextRows vote={vote} />
      <ProfileMetrics {...data} topAssets={topAssets} />
    </>
  )
}

function AssetHover({ id }: { id: number }) {
  const { data } = useAsset(id)
  if (!data) return <div className="hc-sub mono">Loading…</div>
  const a = data.asset
  const ch = a.change24h
  return (
    <>
      <div className="hc-head">
        <AssetIcon assetId={a.assetId} iconAssetId={a.iconAssetId} symbol={a.symbol} size={28} parachainId={a.parachainId} origin={a.origin} />
        <div>
          <div className="hc-title">{a.symbol}</div>
          <div className="hc-sub">{a.name ?? `#${a.assetId}`}</div>
        </div>
      </div>
      <div className="hc-row"><span>Price</span><span className="mono">{F.priceUsd(a.price)}</span></div>
      <div className="hc-row"><span>24h</span><span className="mono" style={{ color: ch == null ? 'var(--text-low)' : ch >= 0 ? 'var(--green)' : 'var(--red)' }}>{F.pct(ch)}</span></div>
      <div className="hc-row"><span>Holders</span><span className="mono">{F.int(data.holderCount)}</span></div>
      <div className="hc-row"><span>Asset ID</span><span className="mono muted">#{a.assetId}</span></div>
    </>
  )
}

function TradeHover({ id }: { id: string }) {
  const { data } = useTrade(id)
  if (!data) return <div className="hc-sub mono">Loading…</div>
  const detailId = data.extrinsicIndex != null ? `${data.blockHeight}-${data.extrinsicIndex}` : data.eventIndex != null ? `${data.blockHeight}-e${data.eventIndex}` : id
  const hops = data.route.length ? data.route : [{ pool: data.venue, poolId: null, assetIn: data.assetIn, assetOut: data.assetOut }]
  return (
    <>
      <div className="hc-head">
        <span className="hc-emoji">T</span>
        <div>
          <div className="hc-title">Trade</div>
          <div className="hc-sub mono">{detailId} · {data.direction} via {data.venue}</div>
        </div>
      </div>
      <div className="hc-row"><span>Result</span><StatusBadge ok={data.success} /></div>
      {data.valueUsd != null && <div className="hc-row"><span>Value</span><span className="mono">{F.usd(data.valueUsd)}</span></div>}
      <div className="hc-route">
        <div className="hc-route-title"><span>Route</span><span className="mono">{hops.length} hop{hops.length === 1 ? '' : 's'}</span></div>
        {hops.map((h, i) => (
          <div className="hc-hop" key={`${h.pool}-${h.assetIn.assetId}-${h.assetOut.assetId}-${i}`}>
            <PoolBadge pool={h.pool} poolId={h.poolId} to={poolHref(h.poolId)} />
            <span className="hc-hop-assets">
              <span className="trade-leg"><AssetIcon assetId={h.assetIn.assetId} iconAssetId={h.assetIn.iconAssetId} symbol={h.assetIn.symbol} size={16} parachainId={h.assetIn.parachainId} origin={h.assetIn.origin} /><span className="mono">{h.assetIn.symbol}</span></span>
              <span className="muted">→</span>
              <span className="trade-leg"><AssetIcon assetId={h.assetOut.assetId} iconAssetId={h.assetOut.iconAssetId} symbol={h.assetOut.symbol} size={16} parachainId={h.assetOut.parachainId} origin={h.assetOut.origin} /><span className="mono">{h.assetOut.symbol}</span></span>
            </span>
          </div>
        ))}
      </div>
    </>
  )
}

// Mirrors the extrinsic detail's basic-info block. The call name sits on its own
// full-width line (never wraps); the hash is shortened.
function ExtrinsicHover({ id }: { id: string }) {
  const { data } = useExtrinsic(id)
  if (!data) return <div className="hc-sub mono">Loading…</div>
  return (
    <>
      <div className="hc-head">
        <span className="hc-emoji">📄</span>
        <div>
          <div className="hc-title">Extrinsic</div>
          <div className="hc-sub mono">{data.blockHeight}-{data.index}</div>
        </div>
      </div>
      <div className="hc-call" title={data.callName}><CallPill name={data.callName} /></div>
      <div className="hc-row"><span>Time</span><span className="mono">{F.datetime(data.timestamp)}</span></div>
      <div className="hc-row"><span>Result</span><StatusBadge ok={data.success} /></div>
      <div className="hc-row"><span>Hash</span><span className="mono">{F.shortHash(data.hash)}</span></div>
      {data.signer && <div className="hc-row"><span>Signer</span><AddrPill account={data.signer} noCopy /></div>}
      <div className="hc-row"><span>Fee</span><span className="mono"><FeeAmount payment={data.feePayment} nativeRaw={data.fee} link={false} /></span></div>
      {hasTip(data.feePayment, data.tip) && <div className="hc-row"><span>Tip</span><span className="mono"><FeeAmount payment={data.feePayment} nativeRaw={data.tip} part="tip" link={false} /></span></div>}
    </>
  )
}

// Mirrors the block detail's basic-info block; hash shortened.
function BlockHover({ id }: { id: number }) {
  const { data } = useBlock(id)
  const { data: stats } = useStats(!!data)
  if (!data) return <div className="hc-sub mono">Loading…</div>
  return (
    <>
      <div className="hc-head">
        <span className="hc-emoji">🧊</span>
        <div>
          <div className="hc-title">Block <span className="num">{F.int(data.height)}</span></div>
          <div className="hc-sub mono">{F.shortHash(data.hash)}</div>
        </div>
      </div>
      <div className="hc-row"><span>Status</span><FinalizedBadge finalized={data.height <= (stats?.finalizedBlock ?? -1)} /></div>
      <div className="hc-row"><span>Time</span><span className="mono">{F.datetime(data.timestamp)}</span></div>
      {data.author && <div className="hc-row"><span>Author</span><AddrPill account={data.author} noCopy /></div>}
      <div className="hc-row"><span>Spec</span><span className="mono">basilisk/{data.specVersion}</span></div>
      <div className="hc-row"><span>Extrinsics</span><span className="mono">{F.int(data.extrinsicCount)}</span></div>
      <div className="hc-row"><span>Events</span><span className="mono">{F.int(data.eventCount)}</span></div>
    </>
  )
}
