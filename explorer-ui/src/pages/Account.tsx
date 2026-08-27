import { useEffect, useState } from 'react'
import { useAddress, useAddressHistory, useAddressValueEvents, useAccountActivityCounts, useAccountListCount, useStats } from '../hooks/useExplorerData'
import { useNow } from '../hooks/useNow'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { paths, redirect, useQueryValue, setQuery } from '../router'
import { Crumbs, F, Copy, ShortAddr, ProfilePageSkeleton, DetailTabs, moduleName, emojiName, AccountEmoji, UserTagPill } from '../components/ui'
import { PortfolioChart, ProfileStats, profileTabs, LiquidityPositionsTable, ProxyMultisigSection } from '../components/AccountSections'
import { BalancesTreemap } from '../components/BalancesTreemap'
import { CloseAccountsSection } from '../components/CloseAccountsSection'
import { ScopedActivity } from '../components/ScopedActivity'
import { activityListCount, voteListCount } from '../utils/activityPaging'
import { VotesTab } from '../components/VotesTab'
import { allAssociations } from '../userTags'

// Hydration opens any route with the account preselected, so the app shows this
// account's balances and positions. Deep-link to the swap page: it is the app's
// landing route, and every other section stays one click away.
function hydrationAppUrl(address: string): string {
  return `https://app.hydration.net/trade/swap/market?account=${encodeURIComponent(address)}`
}

export function Account({ address }: { address: string }) {
  const { data, isLoading, isError } = useAddress(address)
  const now = useNow()
  // The proxy announcement delays are block counts the page states in time, so
  // they convert at the chain's measured pace.
  const { data: stats } = useStats(!!data?.proxy)
  const canonicalAddress = data ? (data.evmAddress ?? data.ss58Polkadot) : null
  const rawView = useQueryValue('view', 'overview')
  const legacyAtab = useQueryValue('atab', '')
  // Old links nested Extrinsics/Events under ?view=activity&atab=…; both are
  // first-level views now, so those URLs land on the promoted tab.
  const view = rawView === 'activity' && (legacyAtab === 'extrinsics' || legacyAtab === 'events') ? legacyAtab : rawView
  // Only the Balances treemap reads the per-asset balance history, and it is 98-99%
  // of the history payload — so the Overview asks for the value series alone. The
  // need latches: a reader who lands on `?view=balances` gets the full shape on the
  // first request, and coming back to the Overview reuses it instead of trading it
  // for the light one.
  const [needBalanceHistory, setNeedBalanceHistory] = useState(view === 'balances')
  if (view === 'balances' && !needBalanceHistory) setNeedBalanceHistory(true)
  const history = useAddressHistory(canonicalAddress, !needBalanceHistory)
  const valueEvents = useAddressValueEvents(canonicalAddress)
  // The Activity tab badge is the exact length of the activity list, shared with
  // the list's own unfiltered total; absent while it resolves, and absent for good
  // on a feed too deep to count (rather than showing an overshooting estimate).
  const activityTotal = useAccountListCount(canonicalAddress, activityListCount('all', '', {}))
  const votesTotal = useAccountListCount(canonicalAddress, voteListCount())
  // Raw extrinsic/event counts badge the two promoted tabs; ScopedActivity asks
  // for the same key, so the two share one request.
  const activityCounts = useAccountActivityCounts(address)

  // Document title mirrors the header's display-name logic: best-known name
  // (module > identity > emoji name) plus the short canonical address.
  const shortAddr = data ? F.shortAddr(data.evmAddress ?? data.ss58Polkadot) : null
  // The document title names the ACCOUNT itself (module → identity → emoji
  // name) — its tag memberships are chips on the page, not its name.
  const acctName = data ? (moduleName(data.accountId) ?? data.identity?.display ?? data.emojiName ?? emojiName(data.emoji)) : null
  useDocumentTitle(data ? (acctName ? `${acctName} · ${shortAddr}` : shortAddr) : undefined)

  // Canonicalize the URL: always show the Polkadot SS58 (substrate) or EVM H160
  // address, never the raw AccountId32 / Hydration SS58. Replace (not push) so the
  // back button still works.
  useEffect(() => {
    if (!data) return
    const canonical = data.evmAddress ?? data.ss58Polkadot
    if (canonical && address !== canonical) redirect(`${paths.account(canonical)}${window.location.search}`)
  }, [data, address])

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Accounts', to: paths.accounts() }, { label: data ? F.shortAddr(data.evmAddress ?? data.ss58Polkadot) : '…' }]} />
      </div>

      {isError ? <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>Address not recognized</div>
        : isLoading || !data ? <ProfilePageSkeleton /> : (() => {
          const mod = moduleName(data.accountId)
          const associations = allAssociations(data)
          const tabs = profileTabs(data.balances.length, data.liquidityPositions?.length ?? 0, activityTotal.data, votesTotal.data?.total ?? undefined, activityCounts.data?.extrinsics, activityCounts.data?.events)
          const activeView = tabs.some(t => t.key === view) ? view : 'overview'
          return (
            <>
              {/* Above the header card and right-aligned, matching
                  "Open in Subsquare" on a referendum. */}
              <div className="ext-link-row">
                <a className="ext-link" href={hydrationAppUrl(canonicalAddress ?? address)} target="_blank" rel="noopener">Open in Hydration ↗</a>
              </div>
              <div className="acct-head">
                {/* The page is about the ACCOUNT, so the header always wears the
                    account's own face, never the tag's. Tag membership lives in
                    the chip row below, where it links to the tag's aggregate page
                    instead of making every member page impersonate the tag. */}
                <div className="acct-avatar">{mod ? '⚙️'
                  : <AccountEmoji account={data} className="acct-avatar-icon" imgClass="acct-avatar-img" />}</div>
                <div className="acct-meta">
                  <div className="tag">{mod
                    ? <span style={{ fontSize: 18 }}>{mod}</span>
                    : data.identity?.display
                      ? <span style={{ fontSize: 18 }}>{data.identity.display}{data.identity.verified && <span className="id-verified" title="Verified identity" style={{ marginLeft: 5 }}>✓</span>}</span>
                      : <span style={{ fontSize: 18 }}>{emojiName(data.emoji) ?? 'Account'}</span>}
                    {data.proxy?.isPure && <span className="badge" title="Keyless pure-proxy account — controlled only through its proxies" style={{ color: 'var(--neutral)', background: 'color-mix(in srgb, var(--neutral) 14%, transparent)' }}>pure proxy</span>}
                    {data.multisig && <span className="badge" title={`Multisig account — any ${data.multisig.threshold} of ${data.multisig.signatories.length} signatories can act`} style={{ color: 'var(--neutral)', background: 'color-mix(in srgb, var(--neutral) 14%, transparent)' }}>{data.multisig.threshold}/{data.multisig.signatories.length} multisig</span>}</div>
                  {/* No EVM badge here: the 0x prefix already says it (and the
                      identities card shows "EVM (H160)") — the badge forced the
                      address to wrap mid-token on phones. */}
                  <div className="full">
                    <span className="mono"><ShortAddr addr={data.evmAddress ?? data.ss58Polkadot} full /></span> <Copy text={data.evmAddress ?? data.ss58Polkadot} />
                  </div>
                  {associations.length > 0 && (
                    <div className="row gap6" style={{ marginTop: 2, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span className="muted" style={{ fontFamily: 'GeistMono', fontSize: 11 }}>Tags</span>
                      {associations.map(a => <UserTagPill key={`system-${a.id}`} tag={a} address={data.evmAddress ?? data.ss58Polkadot} noCopy noMemberSuffix />)}
                    </div>
                  )}
                </div>
                <ProfileStats tradingVolumeUsd={data.tradingVolumeUsd} valueUsd={data.portfolioUsd} />
              </div>

              <DetailTabs tabs={tabs} active={activeView} onChange={k => setQuery({ view: k === 'overview' ? null : k })} />

              {activeView === 'overview' && (<>
              {(() => {
                // Identity rows beyond what the header already shows: the on-chain
                // identity fields. The header's primary address, and the raw account
                // id, are never repeated.
                const rows: { dt: string; dd: React.ReactNode }[] = []
                if (data.identity?.display) rows.push({
                  dt: 'On-chain identity',
                  dd: <>{data.identity.display}{data.identity.verified
                    ? <span className="badge ok" style={{ marginLeft: 6 }}>Verified</span>
                    : <span className="muted mono" style={{ fontSize: 11, marginLeft: 6 }}>unverified</span>}</>,
                })
                if (data.identity?.email) rows.push({ dt: 'Email', dd: <span className="mono"><a href={`mailto:${data.identity.email}`}>{data.identity.email}</a></span> })
                if (data.identity?.web) rows.push({ dt: 'Website', dd: <span className="mono"><a href={data.identity.web} target="_blank" rel="noopener">{data.identity.web}</a></span> })
                if (data.identity?.twitter) {
                  const handle = data.identity.twitter.replace(/^@/, '')
                  rows.push({ dt: 'X', dd: <span className="mono"><a href={`https://x.com/${handle}`} target="_blank" rel="noopener">@{handle}</a></span> })
                }
                if (data.evmAddress && data.ss58Polkadot) rows.push({ dt: 'Polkadot (SS58)', dd: <span className="mono"><ShortAddr addr={data.ss58Polkadot} full /> <Copy text={data.ss58Polkadot} /></span> })
                if (!rows.length) return null
                return (
                  <div className="id-card">
                    <div className="id-card-head">Identities</div>
                    <div className="dl">
                      {rows.map(r => <span key={r.dt} style={{ display: 'contents' }}><div className="dt">{r.dt}</div><div className="dd">{r.dd}</div></span>)}
                    </div>
                  </div>
                )
              })()}

              <ProxyMultisigSection proxy={data.proxy} multisig={data.multisig} memberships={data.multisigMemberships} now={now} blockSec={stats?.avgBlockSec} />

              <CloseAccountsSection address={canonicalAddress ?? address} />

              <PortfolioChart title="Value" netUsd={data.portfolioUsd} series={history.data?.portfolioSeries ?? data.portfolioSeries ?? []} dates={history.data?.portfolioDates ?? data.portfolioDates} balanceHistory={history.data?.balanceHistory ?? data.balanceHistory} loading={history.isLoading || (history.isFetching && !history.data)} valueEvents={valueEvents.data} />
              </>)}

              {activeView === 'balances' && (
              <BalancesTreemap balances={data.balances} balanceHistory={history.data?.balanceHistory ?? data.balanceHistory} />
              )}

              {activeView === 'positions' && data.liquidityPositions && (
              <LiquidityPositionsTable positions={data.liquidityPositions} />
              )}

              {activeView === 'activity' && <ScopedActivity scope={{ kind: 'account', address }} tab="activity" />}

              {activeView === 'extrinsics' && <ScopedActivity scope={{ kind: 'account', address }} tab="extrinsics" />}

              {activeView === 'events' && <ScopedActivity scope={{ kind: 'account', address }} tab="events" />}

              {activeView === 'votes' && <VotesTab scope={{ kind: 'account', address }} />}
            </>
          )
        })()}
    </div>
  )
}
