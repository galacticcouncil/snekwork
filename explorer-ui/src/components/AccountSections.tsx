/* eslint-disable react-refresh/only-export-components -- shared account-section components + their count helper */
import { F, AssetIcon, AreaChart, ChartCardSkeleton, AddrPill, MomentLink, rowNav } from './ui'
import type { ChartMarker, DetailTab } from './ui'
import { Link, paths } from '../router'
import type { ActivitySlug } from '../router'
import { performancePoints } from './performance'
import { CAT } from './activityColors'
import { blockSpanSeconds } from '../utils/blockTime'
import type { LpPosition, AssetBalanceHistory, AccountProxyInfo, MultisigInfo, MultisigMembership, ProxyRelation, ValueEvent } from '../types'
import type { ListCount } from '../api/explorer'
import type { ReactNode } from 'react'

// Render helpers shared by the Account and Tag detail pages so both surface the
// same on-chain data (balances, LP positions, portfolio chart, balance history)
// with identical markup.

// Value-event marker presentation: kind → badge label, marker link slug and the
// hover-card body. The slug only needs to resolve (SLUG_TYPES groups action-level
// slugs by family); the detail page canonicalizes add- vs remove-liquidity etc.
const VALUE_EVENT_LABELS: Record<ValueEvent['kind'], string> = {
  'transfer-in': 'Transfer in', 'transfer-out': 'Transfer out', swap: 'Swap',
  liquidity: 'Liquidity',
  'cross-chain': 'Cross-chain', price: 'Price move', other: 'Transfer',
}
const VALUE_EVENT_SLUGS: Record<ValueEvent['kind'], ActivitySlug> = {
  'transfer-in': 'transfer', 'transfer-out': 'transfer', swap: 'swap',
  liquidity: 'add-liquidity',
  'cross-chain': 'cross-chain', price: 'transfer' /* unlinked */, other: 'transfer',
}
// Cross-chain markers carry the flow direction alongside the kind.
function valueEventLabel(ev: ValueEvent): string {
  if (ev.kind === 'cross-chain' && ev.direction) return ev.direction === 'in' ? 'Cross-chain in' : 'Cross-chain out'
  return VALUE_EVENT_LABELS[ev.kind]
}
// Single-marker hover card: date + kind + value, then the event's asset
// context and (for transfers) the counterparty. The kind keeps the marker's
// --mk color. Swap markers carry their traded pair (in → out); transfer and
// cross-chain markers show the token amount when the marker is exactly one
// event's leg. A 'price' marker has no asset/event row — just the signed move.
function valueEventTip(ev: ValueEvent): ReactNode {
  const dir = ev.kind === 'transfer-in' || (ev.kind === 'cross-chain' && ev.direction === 'in') ? 'from'
    : ev.kind === 'transfer-out' || (ev.kind === 'cross-chain' && ev.direction === 'out') ? 'to' : null
  const kindLabel = valueEventLabel(ev)
  const pair = ev.assetIn && ev.assetOut && (
    <span className="trade-leg">
      <AssetIcon assetId={ev.assetIn.assetId} iconAssetId={ev.assetIn.iconAssetId} symbol={ev.assetIn.symbol} size={16} parachainId={ev.assetIn.parachainId} origin={ev.assetIn.origin} />
      {' '}<span className="mono">{ev.assetIn.symbol}</span>
      <span className="muted">{' → '}</span>
      <AssetIcon assetId={ev.assetOut.assetId} iconAssetId={ev.assetOut.iconAssetId} symbol={ev.assetOut.symbol} size={16} parachainId={ev.assetOut.parachainId} origin={ev.assetOut.origin} />
      {' '}<span className="mono">{ev.assetOut.symbol}</span>
    </span>
  )
  return <>
    <div className="apx-mark-row">
      <span className="t-d">{ev.timestamp.slice(0, 10)}</span>
      <span className="t-k" style={{ color: 'var(--mk)' }}>{kindLabel}</span>
      <span className="t-p">{F.usd(ev.valueUsd)}</span>
    </div>
    {(pair || ev.asset || (dir && ev.counterparty)) && (
      <div className="apx-mark-row">
        {pair || (ev.asset && <span className="trade-leg">
          <AssetIcon assetId={ev.asset.assetId} iconAssetId={ev.asset.iconAssetId} symbol={ev.asset.symbol} size={16} parachainId={ev.asset.parachainId} origin={ev.asset.origin} />
          {' '}<span className="mono">{ev.amount != null ? `${F.amount(ev.amount, ev.asset.decimals)} ` : ''}{ev.asset.symbol}</span>
        </span>)}
        {dir && ev.counterparty && <><span className="muted">{dir}</span><AddrPill account={ev.counterparty} noCopy /></>}
      </div>
    )}
  </>
}
// Compact asset context for a cluster row: the traded pair for swap
// markers, else the (amount +) symbol of the value-bearing asset. Price-move
// markers have no asset and stay bare.
function valueEventDetail(ev: ValueEvent): ReactNode | undefined {
  if (ev.assetIn && ev.assetOut) {
    return <span className="trade-leg">
      <AssetIcon assetId={ev.assetIn.assetId} iconAssetId={ev.assetIn.iconAssetId} symbol={ev.assetIn.symbol} size={13} parachainId={ev.assetIn.parachainId} origin={ev.assetIn.origin} />
      <span className="mono">{ev.assetIn.symbol}</span>
      <span className="muted">→</span>
      <AssetIcon assetId={ev.assetOut.assetId} iconAssetId={ev.assetOut.iconAssetId} symbol={ev.assetOut.symbol} size={13} parachainId={ev.assetOut.parachainId} origin={ev.assetOut.origin} />
      <span className="mono">{ev.assetOut.symbol}</span>
    </span>
  }
  if (ev.asset) {
    return <span className="trade-leg">
      <AssetIcon assetId={ev.asset.assetId} iconAssetId={ev.asset.iconAssetId} symbol={ev.asset.symbol} size={13} parachainId={ev.asset.parachainId} origin={ev.asset.origin} />
      <span className="mono">{ev.amount != null ? `${F.amount(ev.amount, ev.asset.decimals)} ` : ''}{ev.asset.symbol}</span>
    </span>
  }
  return undefined
}
function valueEventMarker(ev: ValueEvent): ChartMarker {
  return {
    ts: ev.timestamp,
    kind: ev.kind,
    label: valueEventLabel(ev),
    valueUsd: ev.valueUsd,
    detail: valueEventDetail(ev),
    // A 'price' marker (and a cross-chain marker the server couldn't match to a
    // feed row) annotates a move with no detail row to open; everything else
    // links to the event.
    href: ev.kind === 'price' || ev.linkable === false
      ? null
      : paths.activityDetail(VALUE_EVENT_SLUGS[ev.kind], `${ev.blockHeight}-e${ev.eventIndex}`),
    tip: valueEventTip(ev),
  }
}

// Portfolio value area chart. `netUsd` is the value shown at the top of the
// card (portfolio minus any borrowed debt); the series carries no dates of its
// own, so we borrow the first asset's balance-history point timestamps when the
// lengths line up (else a value-only tooltip). `valueEvents` (scope-agnostic —
// the parent fetches per account or tag) flag the largest transfers and swaps
// as clickable markers on the chart's time axis.
export function PortfolioChart({ title, netUsd, series, dates: datesProp, balanceHistory, loading, valueEvents }: {
  title: string; netUsd: number; series: number[]; dates?: string[]; balanceHistory?: AssetBalanceHistory[]; loading?: boolean; valueEvents?: ValueEvent[] | null
}) {
  if (!series || series.length <= 1) {
    return loading ? (
      <>
        <div className="sec-title">{title}</div>
        {/* Same shape as the loaded card below: value + the 24H/1W/1M/1Y row. */}
        <ChartCardSkeleton metrics={4} />
      </>
    ) : null
  }
  // Prefer the portfolio's own per-bucket dates; fall back to a same-length asset
  // history if that's all that lines up. Either way the AreaChart shows the date
  // on hover (no static x-axis labels).
  const bp = balanceHistory?.[0]?.points
  const dates = datesProp && datesProp.length === series.length ? datesProp
    : bp && bp.length === series.length ? bp.map(p => p.ts) : undefined
  const perf = (label: string, val: number) => (
    <span key={label} className="perf"><span className="pk">{label}</span><span className="pv" style={{ color: val >= 0 ? 'var(--green)' : 'var(--red)' }}>{val >= 0 ? '+' : ''}{val.toFixed(1)}%</span></span>
  )
  // Suppress windows whose baseline is dust or that span the account's initial
  // funding (>20× growth) — "+1859057.1%" carries no information.
  const perfItems = performancePoints(series, dates, [
    { label: '24H', days: 1 },
    { label: '1W', days: 7 },
    { label: '1M', days: 30 },
    { label: '1Y', days: 365 },
  ], { minBase: 1, maxRatio: 20 })
  const markers = valueEvents?.length ? valueEvents.map(valueEventMarker) : undefined
  return (
    <>
      <div className="sec-title">{title}</div>
      <div className="pf-card">
        <div className="pf-head"><div className="pf-now">{F.usd(netUsd)}</div>{perfItems.length > 0 && <div className="perf-row">{perfItems.map(p => perf(p.label, p.value))}</div>}</div>
        <AreaChart data={series} h={180} dates={dates} markers={markers} />
      </div>
    </>
  )
}

export function profileTabs(
  balanceCount: number,
  liquidityPositionCount: number,
  // The activity list's own total. `activity.complete === false` means it counts
  // only the newest rows of a longer feed, which the badge marks with a `+` rather
  // than passing off as the account's whole history.
  activity?: ListCount,
  votesCount?: number,
  // Raw extrinsic/event counts for the flattened first-level tabs.
  extrinsicsCount?: number,
  eventsCount?: number,
): DetailTab[] {
  return [
    { key: 'overview', label: 'Overview' },
    { key: 'balances', label: 'Balances', count: balanceCount },
    ...(liquidityPositionCount > 0 ? [{ key: 'positions', label: 'Positions', count: liquidityPositionCount }] : []),
    { key: 'activity', label: 'Activity', ...(activity?.total == null ? {} : { count: activity.total, countAtLeast: !activity.complete }) },
    // Extrinsics and Events are first-level tabs, not sub-tabs of Activity: all
    // three are ways of listing what the account did, and burying two of them
    // one level down made them invisible.
    { key: 'extrinsics', label: 'Extrinsics', ...(extrinsicsCount == null ? {} : { count: extrinsicsCount }) },
    { key: 'events', label: 'Events', ...(eventsCount == null ? {} : { count: eventsCount }) },
    ...(votesCount && votesCount > 0 ? [{ key: 'votes', label: 'Votes', count: votesCount }] : []),
  ]
}

export function ProfileStats({ tradingVolumeUsd, valueUsd }: {
  tradingVolumeUsd?: number | null
  valueUsd: number
}) {
  const trading = tradingVolumeUsd ?? 0
  return (
    <div className="acct-stats">
      {trading > 0 && <div className="acct-bal subtle">
        <div className="lab">Trading</div>
        <div className="amt">{F.usd(trading)}</div>
      </div>}
      <div className="acct-bal">
        <div className="lab">Value</div>
        <div className="amt">{F.usd(valueUsd)}</div>
      </div>
    </div>
  )
}

// Venue → badge colour, so wallet-held pool shares read apart from the same
// shares deposited in a liquidity-mining farm. Both are liquidity, so they stay
// inside that family's blues rather than borrowing a hue that means something
// else elsewhere.
const LP_VENUE_COLORS: Record<string, string> = { XYK: CAT.liquidity, 'XYK Farm': CAT.liquidityCreate }

export function LiquidityPositionsTable({ positions }: { positions: LpPosition[] }) {
  if (!positions.length) return null
  return (
    <>
      <div className="sec-title" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>Liquidity positions · {positions.length}
        <span className="muted" style={{ fontFamily: 'GeistMono', fontSize: 11, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>provided to pools & farms</span>
      </div>
      <div className="panel"><table className="tbl assets-tbl">
        <thead><tr><th>Pool asset</th><th>Venue</th><th className="r">Amount</th><th className="r">Value</th></tr></thead>
        <tbody>
          {positions.map(p => {
            const col = LP_VENUE_COLORS[p.venue] ?? CAT.liquidity
            return (
              <tr key={p.positionId} {...rowNav(paths.asset(p.asset.assetId))}>
                <td data-label="Pool asset">
                  <div className="asset-row">
                    <AssetIcon assetId={p.asset.assetId} iconAssetId={p.asset.iconAssetId} symbol={p.asset.symbol} size={30} parachainId={p.asset.parachainId} origin={p.asset.origin} />
                    <div className="ar-meta"><span className="ar-sym">{p.asset.symbol}</span><span className="ar-name">Pool shares</span></div>
                  </div>
                </td>
                <td data-label="Venue"><span className="badge" style={{ background: `color-mix(in srgb, ${col} 14%, transparent)`, color: col }}>{p.venue}</span></td>
                <td data-label="Amount" className="r mono">
                  {F.amount(p.amount, p.asset.decimals)} {p.asset.symbol}
                  {p.hubAmount && <div className="muted" style={{ fontSize: 11, fontWeight: 400 }}>+ {F.amount(p.hubAmount, 12)} H2O</div>}
                </td>
                <td data-label="Value" className="r mono">{F.usd(p.valueUsd)}</td>
              </tr>
            )
          })}
        </tbody>
      </table></div>
    </>
  )
}

/* ============ proxy & multisig ============ */
// A proxy type names the activity it is allowed to perform, so it takes that
// activity's colour. Any is the exception: it authorises everything, which is
// the dangerous one, so it keeps red.
const PROXY_TYPE_COLORS: Record<string, string> = {
  Any: 'var(--red)', CancelProxy: 'var(--text-low)', Governance: CAT.vote,
  Transfer: CAT.transfer, Liquidity: CAT.liquidity, LiquidityMining: CAT.liquidityCreate,
}
function ProxyTypeBadge({ type }: { type: string }) {
  const col = PROXY_TYPE_COLORS[type] ?? 'var(--text-medium)'
  return <span className="pill-badge" title={`Proxy type: ${type}`} style={{ color: col, background: `color-mix(in srgb, ${col} 14%, transparent)` }}>{type}</span>
}
// Delay in blocks rendered with its rough wall-clock equivalent, converted at
// the chain's measured pace (`blockSec`) — the pallet counts the announcement
// delay in blocks, and what that is worth in minutes changes with block time.
function proxyDelay(delay: number, blockSec?: number): string | null {
  if (delay <= 0) return null
  const s = blockSpanSeconds(delay, blockSec)
  const human = s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`
  return `${F.int(delay)} blocks (~${human})`
}
function ProxyRelationRow({ rel, blockSec }: { rel: ProxyRelation; blockSec?: number }) {
  const delay = proxyDelay(rel.delay, blockSec)
  return (
    <span className="proxy-rel">
      <AddrPill account={rel.account} />
      <ProxyTypeBadge type={rel.proxyType} />
      {delay && <span className="muted mono" style={{ fontSize: 11 }} title="Announcement delay before the proxy call executes">delay {delay}</span>}
    </span>
  )
}

// Proxy & multisig relations for the Overview tab. Three cards, each rendered
// only when the account actually has such a relation: who can act for this
// account (its proxies) / whom it can act for, the multisig composition with
// pending operations, and multisig memberships on signer pages.
export function ProxyMultisigSection({ proxy, multisig, memberships, now, blockSec }: {
  proxy?: AccountProxyInfo | null
  multisig?: MultisigInfo | null
  memberships?: MultisigMembership[]
  now: number
  blockSec?: number
}) {
  if (!proxy && !multisig && !memberships?.length) return null
  return (
    <>
      {proxy && (
        <div className="id-card">
          <div className="id-card-head">Proxy</div>
          <div className="dl">
            {proxy.isPure && (
              <>
                <div className="dt">Pure proxy</div>
                <div className="dd proxy-dd">
                  <span className="muted">Keyless account created by</span>
                  <AddrPill account={proxy.isPure.creator} />
                  <span className="mono"><MomentLink at={proxy.isPure} now={now} /></span>
                </div>
              </>
            )}
            {proxy.delegates.length > 0 && (
              <>
                <div className="dt" title="Accounts allowed to submit calls on behalf of this account">Controlled by</div>
                <div className="dd proxy-dd">{proxy.delegates.map((r, i) => <ProxyRelationRow key={`${r.account.accountId}-${r.proxyType}-${i}`} rel={r} blockSec={blockSec} />)}</div>
              </>
            )}
            {proxy.delegatorOf.length > 0 && (
              <>
                <div className="dt" title="Accounts this account may submit calls for">Proxy for</div>
                <div className="dd proxy-dd">{proxy.delegatorOf.map((r, i) => <ProxyRelationRow key={`${r.account.accountId}-${r.proxyType}-${i}`} rel={r} blockSec={blockSec} />)}</div>
              </>
            )}
          </div>
        </div>
      )}

      {multisig && (
        <div className="id-card">
          <div className="id-card-head">Multisig · {multisig.threshold} of {multisig.signatories.length}</div>
          <div className="dl">
            <div className="dt" title={`Any ${multisig.threshold} of these ${multisig.signatories.length} accounts can act as this account`}>Signatories</div>
            <div className="dd proxy-dd">{multisig.signatories.map(s => <AddrPill key={s.accountId} account={s} />)}</div>
            {multisig.pending.length > 0 && (
              <>
                <div className="dt">Pending calls</div>
                <div className="dd proxy-dd" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
                  {multisig.pending.map(p => (
                    <span key={p.callHash} className="proxy-rel">
                      <span className="mono" title={p.callHash}>{F.shortHash(p.callHash)}</span>
                      <span className="pill-badge" style={{ color: 'var(--neutral)', background: 'color-mix(in srgb, var(--neutral) 14%, transparent)' }}>{p.approvals.length}/{multisig.threshold} approved</span>
                      {p.approvals.map(a => <AddrPill key={a.accountId} account={a} noCopy />)}
                      <span className="muted mono" style={{ fontSize: 11 }}>since <Link className="hash" to={paths.block(p.sinceBlock)}>#{F.int(p.sinceBlock)}</Link></span>
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {!!memberships?.length && (
        <div className="id-card">
          <div className="id-card-head">Multisig member</div>
          <div className="dl">
            <div className="dt" title="Multisig accounts this account is a signatory of">Signatory of</div>
            <div className="dd proxy-dd">
              {memberships.map(m => (
                <span key={m.account.accountId} className="proxy-rel">
                  <AddrPill account={m.account} />
                  <span className="pill-badge" style={{ color: 'var(--neutral)', background: 'color-mix(in srgb, var(--neutral) 14%, transparent)' }}>{m.threshold} of {m.signatories}</span>
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
