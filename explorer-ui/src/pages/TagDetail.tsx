import { useTag, useTagActivityCounts, useTagListCount, useTagMembers, useTagValueEvents } from '../hooks/useExplorerData'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { paths, useQueryValue, setQuery } from '../router'
import { Crumbs, AddrPill, Copy, ProfilePageSkeleton, DetailTabs, TableSkeleton, TagIcon, accountHref, rowNav } from '../components/ui'
import { AccountsTable } from '../components/AccountsTable'
import { CloseAccountsSection } from '../components/CloseAccountsSection'
import { ScopedActivity } from '../components/ScopedActivity'
import { activityListCount, voteListCount } from '../utils/activityPaging'
import { VotesTab } from '../components/VotesTab'
import { profileTabs, ProfileStats, PortfolioChart, LiquidityPositionsTable } from '../components/AccountSections'
import { BalancesTreemap } from '../components/BalancesTreemap'

export function TagDetail({ tagId }: { tagId: string }) {
  const { data, isLoading, isError } = useTag(tagId)
  // The members as directory rows. Its own request, so the page's own data is
  // never held up by it — the member pills render meanwhile.
  const memberRows = useTagMembers(tagId)
  // Exact list lengths for the tab badges, shared with the lists' own totals.
  const activityTotal = useTagListCount(tagId, activityListCount('all', '', {}))
  const votesTotal = useTagListCount(tagId, voteListCount())
  const valueEvents = useTagValueEvents(tagId)
  useDocumentTitle(data?.name)
  const rawView = useQueryValue('view', 'overview')
  const legacyAtab = useQueryValue('atab', '')
  // Old links nested Extrinsics/Events under ?view=activity&atab=…; both are
  // first-level views now, so those URLs land on the promoted tab.
  const view = rawView === 'activity' && (legacyAtab === 'extrinsics' || legacyAtab === 'events') ? legacyAtab : rawView
  const activityCounts = useTagActivityCounts(tagId)

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Tags', to: paths.tags() }, { label: data?.name ?? tagId }]} />
      </div>

      {isError ? <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>Tag not found</div>
        : isLoading || !data ? <ProfilePageSkeleton /> : (() => {
          const members = data.members ?? []
          const balances = data.balances ?? []
          const liquidityPositions = data.liquidityPositions ?? []
          const portfolioSeries = data.portfolioSeries ?? []
          const balanceHistory = data.balanceHistory ?? []
          const tabs = profileTabs(balances.length, liquidityPositions.length, activityTotal.data, votesTotal.data?.total ?? undefined, activityCounts.data?.extrinsics, activityCounts.data?.events)
          const activeView = tabs.some(t => t.key === view) ? view : 'overview'
          return (
            <>
              <div className="acct-head">
                <div className="acct-avatar"><TagIcon icon={data.icon} title={data.name} className="acct-avatar-icon" /></div>
                <div className="acct-meta">
                  <div className="tag">{data.name} <span className="em" style={{ color: data.color }}>· tag</span></div>
                  <div className="full"><span className="muted">{members.length} accounts</span></div>
                </div>
                <ProfileStats tradingVolumeUsd={data.tradingVolumeUsd} valueUsd={data.portfolioUsd} />
              </div>

              <DetailTabs tabs={tabs} active={activeView} onChange={k => setQuery({ view: k === 'overview' ? null : k })} />

              {activeView === 'overview' && (<>
              {/* The same table /accounts renders: a tag is a slice of the
                  directory, and a reader who followed a tag from there should
                  find the value, holdings and lending they were just reading,
                  not a bare list of addresses. Falls back to the plain member
                  pills while the rows load — the names are already known. */}
              <div className="sec-title">Accounts · {members.length}</div>
              {memberRows.data?.rows.length
                ? <AccountsTable rows={memberRows.data.rows} skeletonRows={Math.min(members.length, 12)} memberView />
                : <div className="panel"><table className="tbl">
                  <thead><tr><th>Account</th></tr></thead>
                  <tbody>
                    {memberRows.isLoading
                      ? <TableSkeleton cols={1} rows={Math.min(members.length, 8)} />
                      : members.map(m => (
                        <tr key={m.accountId} {...rowNav(accountHref(m))}>
                          <td>
                            <span className="row gap6" style={{ alignItems: 'center' }}>
                              <AddrPill account={m} noCopy noTag />
                              <Copy text={m.address} />
                            </span>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table></div>}

              <CloseAccountsSection tagId={tagId} />

              <PortfolioChart title="Value" netUsd={data.portfolioUsd} series={portfolioSeries} dates={data.portfolioDates} balanceHistory={balanceHistory} valueEvents={valueEvents.data} />
              </>)}

              {activeView === 'balances' && (
              <BalancesTreemap balances={balances} balanceHistory={balanceHistory} />
              )}

              {activeView === 'positions' && liquidityPositions.length > 0 && (
              <LiquidityPositionsTable positions={liquidityPositions} />
              )}

              {activeView === 'activity' && <ScopedActivity scope={{ kind: 'tag', tagId }} tab="activity" />}

              {activeView === 'extrinsics' && <ScopedActivity scope={{ kind: 'tag', tagId }} tab="extrinsics" />}

              {activeView === 'events' && <ScopedActivity scope={{ kind: 'tag', tagId }} tab="events" />}

              {activeView === 'votes' && <VotesTab scope={{ kind: 'tag', tagId }} />}
            </>
          )
        })()}
    </div>
  )
}
