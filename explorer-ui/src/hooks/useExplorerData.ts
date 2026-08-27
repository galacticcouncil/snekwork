import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { api } from '../api/explorer'
import type { EventFilters, ExtrinsicFilters, ListCountQuery, ValueFilters } from '../api/explorer'
import { useHeadStream, BLOCK_STALE_MS, LIVE_MS } from '../live'
import { useHeldRows } from './useHeldRows'
import type { AccountSort } from '../types'

// List/feed hooks honour the global Live toggle. When live, they poll on LIVE_MS;
// when paused, no refetch. The API's single-flight cache keeps DB load O(1) in
// the number of connected clients regardless of poll rate.
//
// Every newest-first feed below wraps its page-0 result in useHeldRows, which
// applies a poll's new rows only while the reader is at the top of the page —
// see that hook for why. The query key doubles as the list's identity there, so
// paging, tabbing or filtering is adopted at once while the same list standing
// still is held. Ranked directories (useAccounts, useHolders) are excluded: they
// serve a fixed-size page whose rows are replaced in rank order rather than
// pushed down by an insertion.
const DETAIL_POLL_MS = 15_000
const SLOW_POLL_MS = 60_000

// `pushed` marks a query the SSE head channel already refreshes (a
// LIVE_PUSH_KEYS feed): while the stream is healthy its interval polling
// pauses entirely, so requests happen only when a block actually lands. On
// stream loss (older browser, proxy hiccup, mocked test API) the interval
// resumes as the fallback.
function useInterval(intervalMs = LIVE_MS, pushed = false): number | false {
  const streaming = useHeadStream()
  return pushed && streaming ? false : intervalMs
}

// Paged and tabbed lists carry `placeholderData: keepPreviousData` for the same
// reason the charts do: a tab switch, filter change or pager click changes the
// query key, and without it `data` drops to undefined mid-fetch, so the table
// empties to a skeleton and back — ~450ms of blank rows and a ~900px height jump
// under the reader's cursor. Consumers already distinguish "fetching" from "has
// no rows", so the outgoing page simply refreshes in place. Row-freshness
// highlighting is unaffected: useNewRows only flags additions when the new keys
// overlap the previous ones, which a page or filter change never does.

export function useStats(enabled = true) {
  const ri = useInterval(LIVE_MS, true)
  return useQuery({ queryKey: ['stats'], queryFn: ({ signal }) => api.stats(signal), enabled, refetchInterval: enabled ? ri : false, staleTime: 2000 })
}
export function useBlocks(limit = 25, offset = 0, enabled = true) {
  const ri = useInterval(LIVE_MS, true)
  const key = ['blocks', limit, offset]
  return useHeldRows(useQuery({ queryKey: key, queryFn: ({ signal }) => api.blocks(limit, offset, signal), enabled, refetchInterval: enabled && offset === 0 ? ri : false, staleTime: 5000, placeholderData: keepPreviousData }), key, offset === 0)
}
export function useExtrinsics(limit = 25, signedOnly = true, from?: string, to?: string, offset = 0, filters?: ExtrinsicFilters) {
  const ri = useInterval(LIVE_MS, true)
  const key = ['extrinsics', limit, signedOnly, from, to, offset, filters]
  return useHeldRows(useQuery({ queryKey: key, queryFn: ({ signal }) => api.extrinsics(limit, signedOnly, from, to, offset, filters, signal), refetchInterval: offset === 0 ? ri : false, staleTime: 2000, placeholderData: keepPreviousData }), key, offset === 0)
}
export function useEvents(limit = 25, from?: string, to?: string, offset = 0, filters?: EventFilters) {
  const ri = useInterval(LIVE_MS, true)
  const key = ['events', limit, from, to, offset, filters]
  return useHeldRows(useQuery({ queryKey: key, queryFn: ({ signal }) => api.events(limit, from, to, offset, filters, signal), refetchInterval: offset === 0 ? ri : false, staleTime: 2000, placeholderData: keepPreviousData }), key, offset === 0)
}
export function useActivity(limit = 30, from?: string, to?: string, offset = 0, type = 'all', filters?: ValueFilters, action?: string) {
  const ri = useInterval(LIVE_MS, true)
  const key = ['activity', limit, from, to, offset, type, filters, action]
  return useHeldRows(useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.activity(limit, from, to, offset, type, filters, action, signal),
    refetchInterval: offset === 0 ? ri : false, staleTime: 2000, placeholderData: keepPreviousData,
  }), key, offset === 0)
}
// The Activity pager's bounds. Only the categories the feed pages in SQL from one
// source carry a real total; every category carries the servable depth. Never polls
// — a total that moved under the reader would renumber pages mid-walk.
export function useActivityCount(type = 'all', from?: string, to?: string, filters?: ValueFilters, action?: string) {
  return useQuery({
    queryKey: ['activity-count', type, from, to, filters, action],
    queryFn: ({ signal }) => api.activityCount(type, from, to, filters, action, signal),
    staleTime: 120_000,
  })
}
export function useCounts() {
  return useQuery({ queryKey: ['counts'], queryFn: ({ signal }) => api.counts(signal), staleTime: 60_000 })
}
// While a detail response is still unfinalized (served from the api's pending
// layer), keep refetching briefly: the finalized row lands within ~40s carrying
// the corrected details (fee, author, decoded failure), and the refetch stops
// the moment the response stops saying `finalized: false`. Exported for tests.
export function pendingRefetchMs(data: unknown): number | false {
  return (data as { finalized?: boolean } | undefined)?.finalized === false ? 2_500 : false
}

export function useBlock(height: number | null) {
  return useQuery({ queryKey: ['block', height], queryFn: ({ signal }) => api.block(height as number, signal), enabled: height != null, staleTime: 60_000, refetchInterval: q => pendingRefetchMs(q.state.data) })
}
export function useBlockActivity(height: number | null, enabled = true) {
  return useQuery({ queryKey: ['block-activity', height], queryFn: ({ signal }) => api.blockActivity(height as number, signal), enabled: height != null && enabled, staleTime: 60_000 })
}
export function useExtrinsic(id: string | null) {
  return useQuery({
    queryKey: ['extrinsic', id],
    queryFn: ({ signal }) => {
      const m = /^(\d+)-(\d+)$/.exec(id as string)
      return m ? api.extrinsicAt(Number(m[1]), Number(m[2]), signal) : api.extrinsic(id as string, signal)
    },
    enabled: !!id,
    staleTime: 60_000,
    refetchInterval: q => pendingRefetchMs(q.state.data),
  })
}
export function useExtrinsicActivity(id: string | null, enabled = true) {
  return useQuery({
    queryKey: ['extrinsic-activity', id],
    queryFn: ({ signal }) => {
      const m = /^(\d+)-(\d+)$/.exec(id as string)
      return m ? api.extrinsicAtActivity(Number(m[1]), Number(m[2]), signal) : api.extrinsicActivity(id as string, signal)
    },
    enabled: !!id && enabled,
    staleTime: 60_000,
  })
}
export function useTrade(id: string | null) {
  return useQuery({
    queryKey: ['trade', id],
    queryFn: ({ signal }) => {
      const event = /^(\d+)-e(\d+)$/.exec(id as string)
      if (event) return api.tradeEvent(Number(event[1]), Number(event[2]), signal)
      const m = /^(\d+)-(\d+)$/.exec(id as string)
      return api.trade(Number(m![1]), Number(m![2]), signal)
    },
    enabled: !!id && /^\d+-(?:e)?\d+$/.test(id),
    staleTime: 60_000,
  })
}
export function useEventAt(id: string | null) {
  return useQuery({
    queryKey: ['event', id],
    queryFn: ({ signal }) => {
      const m = /^(\d+)-(\d+)$/.exec(id as string)
      return api.eventAt(Number(m![1]), Number(m![2]), signal)
    },
    enabled: !!id && /^\d+-\d+$/.test(id),
    staleTime: 60_000,
  })
}
export function useAsset(assetId: number | null) {
  return useQuery({ queryKey: ['asset', assetId], queryFn: ({ signal }) => api.asset(assetId as number, signal), enabled: assetId != null, refetchInterval: useInterval(30_000), staleTime: 20_000 })
}
export function useHolders(assetId: number | null, offset: number, limit: number, enabled = true) {
  const ri = useInterval(30_000)
  return useQuery({
    queryKey: ['holders', assetId, offset, limit],
    queryFn: ({ signal }) => api.holders(assetId as number, offset, limit, signal),
    enabled: assetId != null && enabled, refetchInterval: offset === 0 ? ri : false, staleTime: 20_000, placeholderData: keepPreviousData,
  })
}
// A tag's members as directory rows — the same table /accounts renders, so a
// tag reads as the slice of the directory it is.
export function useTagMembers(tagId: string | null) {
  return useQuery({
    queryKey: ['tag-members', tagId],
    queryFn: ({ signal }) => api.tagMembers(tagId as string, signal),
    enabled: !!tagId,
    staleTime: 60_000,
  })
}

// Every pool, largest first. Snapshot-derived and cached server-side, so this
// follows the ordinary list cadence rather than the live feeds'.
export function usePools() {
  return useQuery({ queryKey: ['pools'], queryFn: ({ signal }) => api.pools(signal), staleTime: 60_000 })
}
// A pool page shows what happened in the POOL, which its share token's activity
// cannot answer (see the api's getPoolSwaps).
export function usePoolActivity(poolId: number | null, limit = 25) {
  const ri = useInterval()
  return useQuery({
    queryKey: ['pool-activity', poolId, limit],
    queryFn: ({ signal }) => api.poolActivity(poolId as number, limit, signal),
    enabled: poolId != null,
    staleTime: BLOCK_STALE_MS,
    refetchInterval: ri,
  })
}
export function useAssetActivity(assetId: number | null, type = 'all', offset = 0, action?: string, enabled = true, from?: string, to?: string, min?: string) {
  const ri = useInterval()
  const key = ['asset-activity', assetId, type, offset, action, from, to, min]
  return useHeldRows(useQuery({ queryKey: key, queryFn: ({ signal }) => api.assetActivity(assetId as number, type, offset, undefined, action, from, to, min, signal), enabled: assetId != null && enabled, refetchInterval: enabled && offset === 0 ? ri : false, staleTime: BLOCK_STALE_MS, placeholderData: keepPreviousData }), key, offset === 0)
}
export function useAddress(address: string | null) {
  return useQuery({ queryKey: ['address', address], queryFn: ({ signal }) => api.address(address as string, signal), enabled: !!address, refetchInterval: useInterval(DETAIL_POLL_MS), staleTime: BLOCK_STALE_MS })
}
// Hover-card variant: the API omits LP/proxy/multisig so the preview loads fast.
export function useAddressSummary(address: string | null) {
  return useQuery({ queryKey: ['address-summary', address], queryFn: ({ signal }) => api.addressSummary(address as string, signal), enabled: !!address, staleTime: 30_000 })
}
// `seriesOnly` asks for the value series without the per-asset balance history —
// 98-99% of the payload, and only the Balances treemap reads it. The two shapes get
// their own cache keys: sharing one would let an Overview-first visit hand the
// treemap a response whose `balanceHistory` is empty by design.
export function useAddressHistory(address: string | null, seriesOnly = false) {
  return useQuery({
    queryKey: ['address-history', address, seriesOnly ? 'series' : 'full'],
    queryFn: ({ signal }) => (seriesOnly ? api.addressHistorySeries(address as string, signal) : api.addressHistory(address as string, signal)),
    enabled: !!address,
    staleTime: 120_000,
  })
}
export function useCloseAccounts(address: string | null, enabled = false) {
  return useQuery({
    queryKey: ['close-accounts', address],
    queryFn: ({ signal }) => api.closeAccounts(address as string, signal),
    enabled: !!address && enabled,
    staleTime: 30 * 60_000,
    gcTime: 60 * 60_000,
    retry: false,
  })
}
export function useTagCloseAccounts(tagId: string | null, enabled = false) {
  return useQuery({
    queryKey: ['tag-close-accounts', tagId],
    queryFn: ({ signal }) => api.tagCloseAccounts(tagId as string, signal),
    enabled: !!tagId && enabled,
    staleTime: 30 * 60_000,
    gcTime: 60 * 60_000,
    retry: false,
  })
}
export function useAccountActivity(address: string | null, type = 'all', offset = 0, action?: string, from?: string, to?: string, filters?: ValueFilters) {
  const ri = useInterval()
  const key = ['account-activity', address, type, offset, action, from, to, filters]
  return useHeldRows(useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.accountActivity(address as string, type, offset, undefined, action, from, to, filters, signal),
    enabled: !!address, refetchInterval: offset === 0 ? ri : false, staleTime: BLOCK_STALE_MS, placeholderData: keepPreviousData,
  }), key, offset === 0)
}
export function useAccountExtrinsics(address: string | null, offset = 0, from?: string, to?: string, filters?: ExtrinsicFilters) {
  const ri = useInterval()
  const key = ['account-extrinsics', address, offset, from, to, filters]
  return useHeldRows(useQuery({ queryKey: key, queryFn: ({ signal }) => api.accountExtrinsics(address as string, offset, undefined, from, to, filters, signal), enabled: !!address, refetchInterval: offset === 0 ? ri : false, staleTime: BLOCK_STALE_MS, placeholderData: keepPreviousData }), key, offset === 0)
}
export function useAccountEvents(address: string | null, offset = 0, from?: string, to?: string, filters?: EventFilters) {
  const ri = useInterval()
  const key = ['account-events', address, offset, from, to, filters]
  return useHeldRows(useQuery({ queryKey: key, queryFn: ({ signal }) => api.accountEvents(address as string, offset, undefined, from, to, filters, signal), enabled: !!address, refetchInterval: offset === 0 ? ri : false, staleTime: BLOCK_STALE_MS, placeholderData: keepPreviousData }), key, offset === 0)
}
export function useAccountVotes(address: string | null, offset = 0, from?: string, to?: string) {
  const ri = useInterval()
  const key = ['account-votes', address, offset, from, to]
  return useHeldRows(useQuery({ queryKey: key, queryFn: ({ signal }) => api.accountVotes(address as string, offset, undefined, from, to, signal), enabled: !!address, refetchInterval: offset === 0 ? ri : false, staleTime: BLOCK_STALE_MS, placeholderData: keepPreviousData }), key, offset === 0)
}
// One referendum, polled while it is still running.
//
// A running referendum gains votes under the reader, and the whole page — tally,
// delegated residual, bubble map, votes table — is rebuilt from this one payload, so
// polling it is all any of them need. It stops at the conclusion rather than on a
// timer: a concluded referendum can never gain another vote, so there is nothing left
// to poll for. The API holds a running referendum for one block and a concluded one for
// a minute, so a poll here is not answered with the figures the last one already showed.
// The /governance page. The overview holds the live cards, so it polls at the
// feed cadence while mounted; the tables poll nothing — a motion or archive row
// changes rarely and a refresh is a click away.
export function useGovernanceOverview() {
  const ri = useInterval(LIVE_MS, true)
  return useQuery({ queryKey: ['governance'], queryFn: ({ signal }) => api.governance(signal), refetchInterval: ri, staleTime: 5_000 })
}
export function useGovernanceReferenda(pallet: 'opengov' | 'democracy', status?: string, track?: number, offset = 0, enabled = true) {
  return useQuery({
    queryKey: ['governance-referenda', pallet, status ?? '', track ?? -1, offset],
    queryFn: ({ signal }) => api.governanceReferenda(pallet, status, track, offset, 25, signal),
    enabled, staleTime: 30_000, placeholderData: keepPreviousData,
  })
}
export function useGovernanceMotions(body: 'tc' | 'council', offset = 0, enabled = true) {
  return useQuery({
    queryKey: ['governance-motions', body, offset],
    queryFn: ({ signal }) => api.governanceMotions(body, offset, 25, signal),
    enabled, staleTime: 30_000, placeholderData: keepPreviousData,
  })
}
export function useGovernanceTips(offset = 0, enabled = true) {
  return useQuery({
    queryKey: ['governance-tips', offset],
    queryFn: ({ signal }) => api.governanceTips(offset, 25, signal),
    enabled, staleTime: 60_000, placeholderData: keepPreviousData,
  })
}

export function useReferendum(pallet: 'opengov' | 'democracy', index: number) {
  return useQuery({
    queryKey: ['referendum', pallet, index],
    queryFn: ({ signal }) => api.referendum(pallet, index, signal),
    refetchInterval: query => (query.state.data?.concludedAt ? false : DETAIL_POLL_MS),
    staleTime: BLOCK_STALE_MS,
  })
}
// Lazy per-account / per-tag activity totals (extrinsic + event counts). The
// first hit can take a few seconds server-side, so no live polling and a long
// staleTime — badges simply appear once the count query resolves.
export function useAccountActivityCounts(address: string | null) {
  return useQuery({ queryKey: ['account-activity-counts', address], queryFn: ({ signal }) => api.accountActivityCounts(address as string, signal), enabled: !!address, staleTime: 600_000 })
}
// The exact length of one detail-page list under exactly the filters it shows —
// what its pager numbers pages from, and what the Activity tab badge reports.
// Walking a classified feed to its end is the expensive part of the page, so this
// never polls; the total appears (and the pager grows numbered pages) once it
// resolves. `total: null` means the list is too deep to count.
export function useAccountListCount(address: string | null, query: ListCountQuery | null) {
  return useQuery({
    queryKey: ['account-list-count', address, query],
    queryFn: ({ signal }) => api.accountListCount(address as string, query as ListCountQuery, signal),
    enabled: !!address && !!query,
    staleTime: 120_000,
  })
}
export function useTagListCount(tagId: string | null, query: ListCountQuery | null) {
  return useQuery({
    queryKey: ['tag-list-count', tagId, query],
    queryFn: ({ signal }) => api.tagListCount(tagId as string, query as ListCountQuery, signal),
    enabled: !!tagId && !!query,
    staleTime: 120_000,
  })
}
// Value-history chart markers: the account/tag's largest transfers and swaps.
// Server-cached top-N; no live polling — the set moves slowly.
export function useAddressValueEvents(address: string | null) {
  return useQuery({ queryKey: ['address-value-events', address], queryFn: ({ signal }) => api.accountValueEvents(address as string, undefined, undefined, signal), enabled: !!address, staleTime: 600_000 })
}
export function useTagValueEvents(tagId: string | null) {
  return useQuery({ queryKey: ['tag-value-events', tagId], queryFn: ({ signal }) => api.tagValueEvents(tagId as string, undefined, undefined, signal), enabled: !!tagId, staleTime: 600_000 })
}
export function useTagActivityCounts(tagId: string | null) {
  return useQuery({ queryKey: ['tag-activity-counts', tagId], queryFn: ({ signal }) => api.tagActivityCounts(tagId as string, signal), enabled: !!tagId, staleTime: 600_000 })
}
export function useTag(tagId: string | null) {
  return useQuery({ queryKey: ['tag', tagId], queryFn: ({ signal }) => api.tag(tagId as string, signal), enabled: !!tagId, refetchInterval: useInterval(DETAIL_POLL_MS), staleTime: BLOCK_STALE_MS })
}
// Hover-card variant: the API skips the heavy portfolio-history reconstruction.
export function useTagSummary(tagId: string | null) {
  return useQuery({ queryKey: ['tag-summary', tagId], queryFn: ({ signal }) => api.tagSummary(tagId as string, signal), enabled: !!tagId, staleTime: 30_000 })
}
export function useTagActivity(tagId: string | null, type = 'all', offset = 0, action?: string, from?: string, to?: string, filters?: ValueFilters) {
  const ri = useInterval()
  const key = ['tag-activity', tagId, type, offset, action, from, to, filters]
  return useHeldRows(useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.tagActivity(tagId as string, type, offset, undefined, action, from, to, filters, signal),
    enabled: !!tagId, refetchInterval: offset === 0 ? ri : false, staleTime: BLOCK_STALE_MS, placeholderData: keepPreviousData,
  }), key, offset === 0)
}
export function useTagExtrinsics(tagId: string | null, offset = 0, from?: string, to?: string, filters?: ExtrinsicFilters) {
  const ri = useInterval()
  const key = ['tag-extrinsics', tagId, offset, from, to, filters]
  return useHeldRows(useQuery({ queryKey: key, queryFn: ({ signal }) => api.tagExtrinsics(tagId as string, offset, undefined, from, to, filters, signal), enabled: !!tagId, refetchInterval: offset === 0 ? ri : false, staleTime: BLOCK_STALE_MS, placeholderData: keepPreviousData }), key, offset === 0)
}
export function useTagEvents(tagId: string | null, offset = 0, from?: string, to?: string, filters?: EventFilters) {
  const ri = useInterval()
  const key = ['tag-events', tagId, offset, from, to, filters]
  return useHeldRows(useQuery({ queryKey: key, queryFn: ({ signal }) => api.tagEvents(tagId as string, offset, undefined, from, to, filters, signal), enabled: !!tagId, refetchInterval: offset === 0 ? ri : false, staleTime: BLOCK_STALE_MS, placeholderData: keepPreviousData }), key, offset === 0)
}
export function useTagVotes(tagId: string | null, offset = 0, from?: string, to?: string) {
  const ri = useInterval()
  const key = ['tag-votes', tagId, offset, from, to]
  return useHeldRows(useQuery({ queryKey: key, queryFn: ({ signal }) => api.tagVotes(tagId as string, offset, undefined, from, to, signal), enabled: !!tagId, refetchInterval: offset === 0 ? ri : false, staleTime: BLOCK_STALE_MS, placeholderData: keepPreviousData }), key, offset === 0)
}
// Grouped mode of the tag votes tab (one row per referendum) — a ranked page
// whose rows are replaced in place, so no useHeldRows (same reasoning as
// useAccounts/useHolders above the poll constants).
export function useTagVotesByReferendum(tagId: string | null, offset = 0, enabled = true) {
  const ri = useInterval()
  return useQuery({
    queryKey: ['tag-votes-by-ref', tagId, offset],
    queryFn: ({ signal }) => api.tagVotesByReferendum(tagId as string, offset, undefined, signal),
    enabled: !!tagId && enabled, refetchInterval: offset === 0 ? ri : false, staleTime: BLOCK_STALE_MS, placeholderData: keepPreviousData,
  })
}
// The full asset directory is 74 kB (19 kB brotli), 57% of it sparklines. Only the
// Assets page renders those, and it wants them fresh.
export function useAssets() {
  return useQuery({ queryKey: ['assets'], queryFn: ({ signal }) => api.assets(signal), refetchInterval: useInterval(SLOW_POLL_MS), staleTime: 30_000 })
}
// What an activity token filter needs: ids, symbols and names, in the directory's own
// order. Own cache key, because the projected rows carry no prices or sparklines and
// would leave the Assets page's table empty if the two shapes shared one entry. The
// list arrives with the page so a `?token=<id>` deep link can name its chip
// immediately, and it never polls — symbols do not move.
export function useAssetFilterOptions() {
  return useQuery({ queryKey: ['assets-filter'], queryFn: ({ signal }) => api.assetFilterOptions(signal), staleTime: 30_000 })
}
// The call/event name catalogue behind the name filters. Cached an hour by the
// API and never polled: the list moves only when a runtime upgrade adds or
// removes a name.
export function useFilterNames() {
  return useQuery({ queryKey: ['filter-names'], queryFn: ({ signal }) => api.filterNames(signal), staleTime: 3_600_000 })
}
// Pool surfaces follow the dashboard shape: one query, no polling — pool
// history advances on a ~2h grid, so 120s staleness costs nothing.
export function useAssetLiquidity(assetId: number, enabled: boolean) {
  return useQuery({ queryKey: ['asset-liquidity', assetId], queryFn: ({ signal }) => api.assetLiquidity(assetId, signal), staleTime: 120_000, enabled })
}
export function usePoolDetail(poolId: number) {
  return useQuery({ queryKey: ['pool', poolId], queryFn: ({ signal }) => api.poolDetail(poolId, signal), staleTime: 120_000 })
}
export function usePoolLps(poolId: number, offset: number, limit: number) {
  // The LP rankings page server-side; the previous page is held on screen while
  // the next one answers (and marked pending), like every other paged table.
  return useQuery({
    queryKey: ['pool-lps', poolId, offset, limit],
    queryFn: ({ signal }) => api.poolLps(poolId, offset, limit, signal),
    staleTime: 120_000, placeholderData: keepPreviousData,
  })
}
// Ranked directory (fixed-size page, rows replaced in rank order): slow poll,
// held previous page.
export function useAccounts(offset = 0, limit = 50, sort: AccountSort = 'value') {
  return useQuery({
    queryKey: ['accounts', offset, limit, sort],
    queryFn: ({ signal }) => api.accounts(offset, limit, sort, signal),
    refetchInterval: useInterval(SLOW_POLL_MS),
    staleTime: 20_000,
    placeholderData: keepPreviousData,
  })
}
export function useDaily(scope: string, params?: { type?: string; action?: string; token?: string }) {
  // keepPreviousData: switching the active tab/action changes the query key; without
  // it `data` drops to undefined mid-fetch and the chart collapses to a skeleton
  // (and back), flickering. Holding the previous series lets DayBarChart update the
  // bars in place — same frame, same height — while the new tab loads.
  return useQuery({ queryKey: ['daily', scope, params ?? null], queryFn: ({ signal }) => api.daily(scope, params, signal), staleTime: 300_000, placeholderData: keepPreviousData })
}
export function useAccountsDaily() {
  return useQuery({ queryKey: ['accounts-daily'], queryFn: ({ signal }) => api.accountsDaily(signal), staleTime: 300_000 })
}
export function useTags() {
  return useQuery({ queryKey: ['tags'], queryFn: ({ signal }) => api.tags(signal), staleTime: 30_000 })
}
