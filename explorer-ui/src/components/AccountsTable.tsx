import type { ReactNode } from 'react'
import { paths } from '../router'
import { AddrPill, compactAmount, Dash, EmptyRow, F, rowNav, Sparkline, TableSkeleton, TagGroupPill, TokenIconRow, pendingRows } from './ui'
import type { TopAccountRow } from '../types'

// The accounts directory table.
//
// One renderer, because there is one directory: /accounts shows the whole
// chain's, and a tag page shows the slice of it that tag names. They were two
// different lists before — a tag's members were bare address pills with none of
// the value, holdings, lending or activity a reader had just been looking at —
// and a reader who follows a tag from the directory should land on the same
// table, not a thinner one.
//
// Sorting is the caller's: /accounts sorts server-side through the URL, a tag's
// short member list arrives already ranked. So the header renders sort buttons
// only when a handler is passed, and reads as plain labels otherwise.

export type AccountSortKey = 'value' | 'identity' | 'activity' | 'volume'

// Below 720px every row becomes a card, where a line reading "TRADING $ —"
// carries nothing: cells with no value are marked so the card can drop them.
// The desktop table keeps its dash — a column still has to line up.
const emptyIf = (empty: boolean) => empty ? ' cell-empty' : ''

// A stable identity per rendered row: a system tag's own id, an account's id,
// or its position.
function accountRowKey(r: TopAccountRow, i: number): string {
  return r.tag ? `tag:${r.tag.tagId}` : r.account ? `account:${r.account.accountId}` : `row:${i}`
}

export function AccountRow({ r, memberView }: { r: TopAccountRow; memberView?: boolean }) {
  // Module accounts touch balances on every trade, so the column shows the
  // explorer-wide rough scale (2.25M · 505k · 4.87k) rather than a full count.
  const count = (n?: number) => n != null ? <span className="mono muted">{compactAmount(n)}</span> : <Dash />
  // The whole row opens what it names, like every other directory here — a
  // tag's combined view or the account's page. rowNav defers to nested links,
  // so the pill and the sparkline keep their own targets, and a row with
  // neither stays plain rather than pretending to lead somewhere.
  // A member list is ABOUT its members: each row shows the account itself
  // (never a tag pill that would loop back to the page the reader is on) and
  // the whole row opens the account.
  const to = memberView && r.account
    ? paths.account(r.account.address)
    : r.tag ? paths.tag(r.tag.tagId) : r.account ? paths.account(r.account.address) : null
  return (
    <tr {...(to ? rowNav(to) : {})}>
      <td data-label="Account">{memberView && r.account
        ? <AddrPill account={r.account} noTag />
        : r.tag ? <TagGroupPill tag={r.tag} /> : r.account ? <AddrPill account={r.account} /> : <Dash />}</td>
      <td data-label="Value" className="r mono">{F.usd(r.portfolioUsd)}</td>
      <td data-label="Holdings" className={`holdings-cell${emptyIf(!r.topAssets?.length)}`}>{r.topAssets?.length ? <TokenIconRow assets={r.topAssets} others={r.otherAssets ?? 0} /> : <Dash />}</td>
      <td data-label="1Y" className={`r${emptyIf(!(r.sparkline && r.sparkline.length > 1))}`}>{r.sparkline && r.sparkline.length > 1 ? <Sparkline data={r.sparkline} /> : <Dash />}</td>
      <td data-label="Trading $" className={`r mono${emptyIf(!r.tradingVolumeUsd)}`}>{r.tradingVolumeUsd ? F.usd(r.tradingVolumeUsd) : <Dash />}</td>
      {/* A partial total is a floor: the feed runs deeper than it could be
          counted, so it reads as "at least this" instead of as exact. */}
      <td data-label="Activity" className={`r${emptyIf(r.activityCount == null)}`}>{count(r.activityCount)}{r.activityCount != null && r.activityCountComplete === false ? '+' : ''}</td>
    </tr>
  )
}

export function AccountsTable({ rows, loading, pending, sort, onSort, emptyLabel = 'No accounts', skeletonRows = 12, footer, memberView }: {
  rows: TopAccountRow[]
  loading?: boolean
  pending?: boolean
  sort?: AccountSortKey
  onSort?: (key: AccountSortKey) => void
  emptyLabel?: string
  skeletonRows?: number
  // Member lists (tag pages): rows render and link as the accounts themselves.
  memberView?: boolean
  // Rendered inside the panel, under the table — where the directory's pager
  // has always sat, sharing the panel's own surface.
  footer?: ReactNode
}) {
  const th = (key: AccountSortKey, label: string) => onSort
    ? <button type="button" className={`th-sort${sort === key ? ' on' : ''}`} onClick={() => onSort(key)}>{label}{sort === key ? ' ▼' : ''}</button>
    : label
  return (
    <div className="panel">
      <table className="tbl accounts-tbl">
        <thead><tr>
          <th>{th('identity', 'Account')}</th>
          <th className="r">{th('value', 'Value')}</th><th>Holdings</th><th className="r">1Y</th>
          <th className="r">{th('volume', 'Trading $')}</th>
          <th className="r">{th('activity', 'Activity')}</th>
        </tr></thead>
        <tbody {...pendingRows(pending)}>
          {/* A phone card here drops the columns this account has nothing in and
              gives the 1Y chart a whole line of its own, so its height is not the
              column count. */}
          {loading && !rows.length ? <TableSkeleton cols={6} mobileCols={5} rows={skeletonRows} />
            : !rows.length ? <EmptyRow cols={6}>{emptyLabel}</EmptyRow>
              : rows.map((r, i) => <AccountRow key={accountRowKey(r, i)} r={r} memberView={memberView} />)}
        </tbody>
      </table>
      {footer}
    </div>
  )
}

// The sort control phones get, where the sortable column headers are hidden.
export function AccountsSortSelect({ id, sort, onSort }: { id: string; sort: AccountSortKey; onSort: (key: AccountSortKey) => void }) {
  return (
    <div className="mobile-sort">
      <label htmlFor={id}>Sort by</label>
      <select id={id} value={sort} onChange={e => onSort(e.target.value as AccountSortKey)}>
        <option value="value">Value</option>
        <option value="identity">Account</option>
        <option value="volume">Trading $</option>
        <option value="activity">Activity</option>
      </select>
    </div>
  )
}

