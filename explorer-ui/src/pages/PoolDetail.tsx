import { useState } from 'react'
import { usePoolActivity, usePoolDetail, usePoolLps } from '../hooks/useExplorerData'
import { useNow } from '../hooks/useNow'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Link, paths } from '../router'
import { accountHref, AddrPill, Ago, AreaChart, AssetAmount, AssetChip, AssetIcon, ChartSkeleton, Crumbs, Dash, EmptyRow, F, Pager, pendingRows, PoolBadge, rowNav, TableSkeleton } from '../components/ui'
import { ChartLegend, ShareBar, StackedAreaChart, type ShareSegment } from '../components/charts'
import { ActivityTable } from '../components/ActivityTable'
import { useAssetColors } from '../utils/iconColor'
import type { PoolDetail as PoolDetailData } from '../types'

// One XYK pool, addressed by its share/LP token id: current composition,
// parameters, the sampled history (TVL, per-asset composition) and the pool's
// recent activity.

const fmtPermill = (v: number) => `${(v / 10_000).toLocaleString('en-US', { maximumFractionDigits: 4 })}%`

function PoolBody({ d }: { d: PoolDetailData }) {
  // Share first: a pool's history is about the balance between its assets, and
  // USD hides that rotation inside the pool's own growth (see compSeries).
  const [compUnit, setCompUnit] = useState<'share' | 'usd'>('share')
  const now = useNow()
  // Register everything this page charts — history rows can hold assets the
  // pool no longer does; colorFor is the app-wide resolved colour, so a family
  // pair (vDOT/aDOT) is already separated and stays the same on every surface.
  const colorFor = useAssetColors([
    ...d.assets.map(a => a.asset),
    ...d.history.composition.map(c => c.asset),
  ])
  // The pool's OWN activity, not its share token's: a swap through this pool
  // moves its member assets, so an asset-pinned feed on the share token shows
  // liquidity and share trades while the pool's swaps are invisible.
  const activity = usePoolActivity(d.poolId, 12)
  const activityRows = activity.data ?? []

  const shareSegments: ShareSegment[] = d.tvlUsd != null
    ? d.assets.map((a, i) => ({
        key: `${a.asset.assetId}:${i}`, label: a.asset.symbol, color: colorFor(a.asset), value: a.usd ?? 0,
        tip: <><span className="t-d">{a.asset.symbol}</span><span className="t-row">{F.amount(a.amount, a.asset.decimals)} {a.asset.symbol}</span><span className="t-row">{F.usd(a.usd)}</span></>,
      }))
    : []

  // History models: composition in USD (nulls where a leg was unpriced or the
  // pool inactive); TVL as a gap-aware line series.
  //
  // Share is the default view: what a reader wants from a pool's history is how
  // its balance between the assets moved, and in USD that
  // rotation is hidden inside the pool's own growth or decline — every band
  // rises and falls together and says nothing about the mix. Normalizing each
  // bucket to 100% of its priced total answers the question directly, and the
  // absolute scale stays one click away (and in the TVL chart below).
  const bucketTotals = d.history.buckets.map((_, i) =>
    d.history.composition.reduce((s, c) => s + (c.usd[i] ?? 0), 0))
  const compSeries = d.history.composition.map(c => ({
    key: String(c.asset.assetId), label: c.asset.symbol, color: colorFor(c.asset),
    values: compUnit === 'share'
      ? c.usd.map((v, i) => (v == null || !(bucketTotals[i] > 0) ? null : (v / bucketTotals[i]) * 100))
      : c.usd,
  }))
  const hasCompUsd = compSeries.some(s => s.values.some(v => v != null))
  const tvlPoints = d.history.buckets.map((b, i) => ({ b, v: d.history.tvlUsd[i] })).filter(p => p.v != null)

  return (
    <>
      <div className="detail-card"><div className="dl">
        <div className="dt">Venue</div><div className="dd">XYK{d.destroyed && <span className="badge" style={{ marginLeft: 8, background: 'color-mix(in srgb, var(--red) 15%, transparent)', color: 'var(--red)' }}>Destroyed</span>}</div>
        <div className="dt">Pool account</div><div className="dd"><AddrPill account={d.account} /></div>
        <div className="dt">TVL</div><div className="dd mono">{d.tvlUsd != null ? F.usd(d.tvlUsd) : <Dash />}</div>
        <div className="dt">Trade fee</div><div className="dd mono">{d.feePermill != null ? fmtPermill(d.feePermill) : <Dash />}</div>
        <div className="dt">Share token</div><div className="dd"><AssetChip asset={d.shareToken} /> <span className="muted mono">#{d.poolId}</span></div>
        <div className="dt">LP supply</div><div className="dd mono">{F.amount(d.totalIssuance, d.shareToken.decimals)} <Link to={paths.holders(d.poolId)} className="hash" style={{ marginLeft: 8 }}>holders</Link></div>
        {d.createdAt && <>
          <div className="dt">Created</div>
          <div className="dd mono">{d.createdBlock != null ? <Link to={paths.block(d.createdBlock)} className="hash"><Ago ts={d.createdAt} now={now} /></Link> : <Ago ts={d.createdAt} now={now} />}</div>
        </>}
      </div></div>

      <div className="sec-title">Composition{d.destroyed && <span style={{ color: 'var(--text-low)', textTransform: 'none', letterSpacing: 0 }}> · last known, before the pool was destroyed</span>}</div>
      <div className="pf-card">
        {shareSegments.length > 0 && <ShareBar segments={shareSegments} h={30} />}
        <div className="panel" style={{ marginTop: shareSegments.length ? 14 : 0 }}><table className="tbl">
          <thead><tr><th>Asset</th><th className="r">Reserve</th><th className="r">Value</th><th className="r">Share</th></tr></thead>
          <tbody>
            {d.assets.map((a, i) => (
              <tr key={`${a.asset.assetId}:${i}`} {...rowNav(paths.asset(a.asset.assetId))}>
                <td data-label="Asset"><AssetChip asset={a.asset} /></td>
                <td data-label="Reserve" className="r"><AssetAmount asset={a.asset} raw={a.amount} /></td>
                <td data-label="Value" className="r mono">{a.usd != null ? F.usd(a.usd) : <Dash />}</td>
                <td data-label="Share" className="r mono muted">{a.sharePct != null ? `${a.sharePct.toFixed(1)}%` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </div>

      {tvlPoints.length > 1 && (
        <>
          <div className="sec-title">TVL</div>
          <div className="pf-card"><AreaChart data={tvlPoints.map(p => p.v!)} dates={tvlPoints.map(p => p.b)} color="var(--sky-deep)" floor={0} /></div>
        </>
      )}

      {hasCompUsd && d.history.buckets.length > 1 && (
        <>
          <div className="sec-title" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>Composition over time
            <span className="liq-toggle" style={{ marginLeft: 'auto' }}>
              <button className={compUnit === 'share' ? 'active' : ''} onClick={() => setCompUnit('share')}>%</button>
              <button className={compUnit === 'usd' ? 'active' : ''} onClick={() => setCompUnit('usd')}>USD</button>
            </span>
          </div>
          <div className="pf-card">
            <ChartLegend items={compSeries.map(s => ({ label: s.label, color: s.color }))} />
            <StackedAreaChart buckets={d.history.buckets} series={compSeries}
              yFmt={compUnit === 'share' ? v => `${parseFloat(v.toFixed(1))}%` : F.usd} showShare={compUnit === 'usd'} />
          </div>
        </>
      )}

      <PoolLpsSection d={d} />

      <div className="sec-title" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>Activity
        <Link to={`${paths.asset(d.poolId)}?tab=activity`} className="ext-link" style={{ marginLeft: 'auto', textTransform: 'none', letterSpacing: 0 }}>View all →</Link>
      </div>
      {activityRows.length || activity.isLoading
        ? <ActivityTable rows={activityRows} now={now} loading={activity.isLoading && !activityRows.length} pageSize={12} error={activity.error} onRetry={() => { void activity.refetch() }} />
        : <div className="panel"><table className="tbl"><tbody><EmptyRow cols={5}>No activity yet</EmptyRow></tbody></table></div>}
    </>
  )
}

// The pool's liquidity providers: holders of its share token, largest first,
// with farm-deposited principal attributed to its economic owners (rows marked
// "farm"). Share % and value are fractions of the SAME LP supply and TVL shown
// above, so the section reconciles with the pool card by construction.
// Custodial holders appear as their tagged accounts.
const LPS_PAGE = 10
function PoolLpsSection({ d }: { d: PoolDetailData }) {
  const [page, setPage] = useState(0)
  const lps = usePoolLps(d.poolId, page * LPS_PAGE, LPS_PAGE)
  const rows = lps.data?.lps ?? []
  const total = lps.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / LPS_PAGE))
  if (lps.isError) return null
  return (
    <>
      <div className="sec-title">Liquidity providers
        {lps.data && <span style={{ color: 'var(--text-low)', textTransform: 'none', letterSpacing: 0 }}> · {F.int(total)} {total === 1 ? 'holder' : 'holders'} of {d.shareToken.symbol}</span>}
      </div>
      <div className="panel"><table className="tbl">
        <thead><tr><th style={{ width: 50 }}>#</th><th>Provider</th><th className="r">Shares</th><th className="r">Share</th><th className="r">Value</th></tr></thead>
        <tbody {...pendingRows(lps.isPlaceholderData)}>
          {lps.isLoading && !rows.length ? <TableSkeleton cols={5} rows={6} />
            : rows.length ? rows.map(r => (
              <tr key={r.account.accountId} {...rowNav(accountHref(r.account))}>
                <td data-label="Rank" className="mono muted">{r.rank}</td>
                <td data-label="Provider"><AddrPill account={r.account} noCopy />
                  {r.farmedShares && <span className="badge" style={{ marginLeft: 6, background: 'var(--lavender-soft)', color: 'var(--lavender-deep)' }}
                    title={`${F.amount(r.farmedShares, d.shareToken.decimals)} of these shares are deposited in a liquidity-mining farm`}>farm</span>}
                </td>
                <td data-label="Shares" className="r mono">{F.amount(r.shares, d.shareToken.decimals)}</td>
                <td data-label="Share" className="r mono muted">{r.sharePct != null ? `${r.sharePct.toFixed(1)}%` : '—'}</td>
                <td data-label="Value" className="r mono">{r.valueUsd != null ? F.usd(r.valueUsd) : <Dash />}</td>
              </tr>
            )) : <EmptyRow cols={5}>No liquidity providers</EmptyRow>}
        </tbody>
      </table>
      {totalPages > 1 && <Pager page={page} totalPages={totalPages} onPage={setPage} />}
      </div>
    </>
  )
}

export function PoolDetail({ poolId }: { poolId: number }) {
  const { data, isLoading, isError } = usePoolDetail(poolId)
  useDocumentTitle(data ? `${data.name} pool` : undefined)
  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Assets', to: paths.assets() }, { label: data?.name ?? `Pool #${poolId}` }]} />
        <div className="detail-header">
          <div className="page-title">
            {data && <AssetIcon assetId={data.shareToken.assetId} iconAssetId={data.shareToken.iconAssetId} symbol={data.shareToken.symbol} size={30} parachainId={data.shareToken.parachainId} origin={data.shareToken.origin} />}
            {' '}{data?.name ?? `Pool #${poolId}`}
            {data && <span className="sub muted" style={{ marginLeft: 8 }}><PoolBadge pool="XYK" /></span>}
          </div>
        </div>
      </div>
      {isError
        ? <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>Pool not found</div>
        : isLoading || !data
          ? <><div className="detail-card"><ChartSkeleton h={120} /></div><div className="pf-card" style={{ marginTop: 14 }}><ChartSkeleton h={220} /></div></>
          : <PoolBody d={data} />}
    </div>
  )
}
