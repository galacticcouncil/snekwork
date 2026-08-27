import type {
  ExplorerStats, BlockSummary, BlockDetail, ExtrinsicSummary, ExtrinsicDetail,
  HoldersResponse, AddressDetail, SearchResult, Tag, AssetListItem, AssetFilterItem, FilterNames,
  AccountsPage, AccountSort, DailyPoint, IndexerStatus, EventRow, EventDetail, ActivityRow, VoteRow, VotesByReferendumPage, AssetDetail, TagDetail, GovernanceOverview, GovernanceReferendaPage, CollectiveMotionsPage, TreasuryTipsPage,
  AccountHistoryResponse, CloseAccountsResponse, TradeDetail,
  AssetLiquidity, PoolDetail, PoolLpsResponse,
  ValueEvent, ReferendumDetail, PoolsIndexResponse,
} from '../types'
// Live feeds stamp the pushed head onto their URLs (`h=`): the nginx
// micro-cache keys on the URI alone, so a push-triggered refetch would
// otherwise HIT the entry cached for the previous head — and with interval
// polling paused while streaming, that staleness would last until the NEXT
// block. Per-head URIs keep the shared cache (same head → same entry) while
// making a new head a guaranteed cache MISS. 0 (not streaming) omits the tag.
import { liveHeadTag } from '../live'

// A failed request carries the API's own explanation (Fastify puts it in
// `message`, hand-written rejections in `error`). Keeping it on the error lets a
// list surface actionable guidance — "narrow the filters" for a too-broad
// activity window — instead of a bare status.
export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, { signal })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string; message?: string } | null
    throw new ApiError(response.status, body?.message || body?.error || `${response.status} ${response.statusText}`)
  }
  return response.json() as Promise<T>
}

type QueryValue = string | number | boolean | null | undefined

function withQuery(path: string, values: Record<string, QueryValue>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value == null || value === '' || value === false) continue
    query.set(key, value === true ? '1' : String(value))
  }
  const encoded = query.toString()
  return encoded ? `${path}?${encoded}` : path
}

export interface ValueFilters { token?: string; min?: string; identity?: string }
export interface ExtrinsicFilters { call?: string; result?: string; origin?: string }
export interface EventFilters { event?: string }
// Which list on an account/tag detail page a total is being asked for, plus the
// filters that list is showing. The total must move with the filters, so every
// filter field a list can apply travels with the request.
export type ListTab = 'activity' | 'extrinsics' | 'events' | 'votes'
// Tab badges: the exact length of each list, unfiltered.
export interface TabCounts { extrinsics: number; extrinsicsOnBehalf?: number; events: number; votes: number }
export interface ListCountQuery extends ValueFilters, ExtrinsicFilters, EventFilters {
  tab: ListTab
  type?: string
  action?: string
  from?: string
  to?: string
}
// One list's length. `complete: false` = `total` counts only the newest rows of a
// list that runs deeper than one candidate window reaches, so the pages it numbers
// are real but are not all the list has.
export interface ListCount { total: number | null; complete: boolean }
// The chain-wide Activity feed's length under the filters shown, plus the deepest
// offset the API serves it at. `total: null` = this category is assembled from
// several sources and cannot be counted without classifying chain-wide history, so
// its pager walks by `maxOffset` instead of numbering pages.
export interface ActivityCount extends ListCount { maxOffset: number }
// Global list totals, plus the deepest offset those lists serve — the events feed
// is far longer than its servable depth, so its pager needs both numbers.
export interface ListCounts { blocks: number; extrinsics: number; events: number; transfers: number; maxOffset: number }

export const api = {
  stats: (signal?: AbortSignal) => getJson<ExplorerStats>(withQuery('/explorer/stats', { h: liveHeadTag() || undefined }), signal),
  indexer: (signal?: AbortSignal) => getJson<IndexerStatus>('/indexer', signal),
  blocks: (limit = 25, offset = 0, signal?: AbortSignal) => getJson<BlockSummary[]>(withQuery('/explorer/blocks', { limit, offset, h: liveHeadTag() || undefined }), signal),
  block: (height: number, signal?: AbortSignal) => getJson<BlockDetail>(`/explorer/block/${height}`, signal),
  blockActivity: (height: number, signal?: AbortSignal) => getJson<ActivityRow[]>(`/explorer/block/${height}/activity`, signal),
  extrinsics: (limit = 25, signedOnly = false, from?: string, to?: string, offset = 0, filters?: ExtrinsicFilters, signal?: AbortSignal) =>
    getJson<ExtrinsicSummary[]>(withQuery('/explorer/extrinsics', { limit, offset, signedOnly, from, to, ...filters, h: liveHeadTag() || undefined }), signal),
  extrinsic: (hash: string, signal?: AbortSignal) => getJson<ExtrinsicDetail>(`/explorer/extrinsic/${hash}`, signal),
  extrinsicAt: (height: number, index: number, signal?: AbortSignal) => getJson<ExtrinsicDetail>(`/explorer/extrinsic-at/${height}/${index}`, signal),
  extrinsicActivity: (hash: string, signal?: AbortSignal) => getJson<ActivityRow[]>(`/explorer/extrinsic/${hash}/activity`, signal),
  extrinsicAtActivity: (height: number, index: number, signal?: AbortSignal) => getJson<ActivityRow[]>(`/explorer/extrinsic-at/${height}/${index}/activity`, signal),
  extrinsicEncoded: (height: number, index: number, signal?: AbortSignal) =>
    getJson<{ encoded: string }>(`/explorer/extrinsic-at/${height}/${index}/encoded`, signal),
  referendum: (pallet: 'opengov' | 'democracy', index: number, signal?: AbortSignal, limit?: number) =>
    getJson<ReferendumDetail>(withQuery(`/explorer/referendum/${pallet}/${index}`, limit == null ? {} : { limit }), signal),
  trade: (height: number, index: number, signal?: AbortSignal) => getJson<TradeDetail>(`/explorer/trade/${height}/${index}`, signal),
  tradeEvent: (height: number, index: number, signal?: AbortSignal) => getJson<TradeDetail>(`/explorer/trade-event/${height}/${index}`, signal),
  events: (limit = 25, from?: string, to?: string, offset = 0, filters?: EventFilters, signal?: AbortSignal) => getJson<EventRow[]>(withQuery('/explorer/events', { limit, offset, from, to, ...filters, h: liveHeadTag() || undefined }), signal),
  eventAt: (height: number, index: number, signal?: AbortSignal) => getJson<EventDetail>(`/explorer/event/${height}/${index}`, signal),
  activity: (limit = 25, from?: string, to?: string, offset = 0, type = 'all', filters?: ValueFilters, action?: string, signal?: AbortSignal) => getJson<ActivityRow[]>(withQuery('/explorer/activity', { limit, offset, type, action, from, to, ...filters, h: liveHeadTag() || undefined }), signal),
  // What the Activity pager sizes itself against: the feed's length under exactly
  // these filters where it can be counted, and always the servable depth.
  activityCount: (type = 'all', from?: string, to?: string, filters?: ValueFilters, action?: string, signal?: AbortSignal) =>
    getJson<ActivityCount>(withQuery('/explorer/activity/count', { type, action, from, to, ...filters }), signal),
  counts: (signal?: AbortSignal) => getJson<ListCounts>('/explorer/counts', signal),
  asset: (assetId: number, signal?: AbortSignal) => getJson<AssetDetail>(`/explorer/asset/${assetId}`, signal),
  assetLiquidity: (assetId: number, signal?: AbortSignal) => getJson<AssetLiquidity>(`/explorer/asset/${assetId}/liquidity`, signal),
  poolDetail: (poolId: number, signal?: AbortSignal) => getJson<PoolDetail>(`/explorer/pool/${poolId}`, signal),
  // Same endpoint as the global activities feed, with the asset id pinned.
  assetActivity: (assetId: number, type = 'all', offset = 0, limit = 40, action?: string, from?: string, to?: string, min?: string, signal?: AbortSignal) =>
    getJson<ActivityRow[]>(withQuery('/explorer/activity', { asset: assetId, type, offset, limit, action, from, to, min }), signal),
  pools: (signal?: AbortSignal) => getJson<PoolsIndexResponse>('/explorer/pools', signal),
  // A pool's own activity: the swaps that happened IN it, merged with what its
  // share token did. The asset-pinned activity feed cannot answer this — a
  // routed swap's hops name the pool's members, not its share token.
  poolActivity: (poolId: number, limit = 25, signal?: AbortSignal) =>
    getJson<ActivityRow[]>(withQuery(`/explorer/pool/${poolId}/activity`, { limit }), signal),
  // A pool's liquidity providers (share-token holders, farm principal
  // attributed), paged server-side over the full ranking.
  poolLps: (poolId: number, offset = 0, limit = 10, signal?: AbortSignal) =>
    getJson<PoolLpsResponse>(withQuery(`/explorer/pool/${poolId}/lps`, { offset, limit }), signal),
  holders: (assetId: number, offset = 0, limit = 100, signal?: AbortSignal) => getJson<HoldersResponse>(withQuery(`/explorer/holders/${assetId}`, { offset, limit }), signal),
  address: (address: string, signal?: AbortSignal) => getJson<AddressDetail>(`/explorer/address/${encodeURIComponent(address)}`, signal),
  // Lightweight variant for the hover card: the API skips LP/proxy/multisig so
  // the preview loads fast (the card only shows name, value, holdings, volumes).
  addressSummary: (address: string, signal?: AbortSignal) => getJson<AddressDetail>(withQuery(`/explorer/address/${encodeURIComponent(address)}`, { summary: '1' }), signal),
  addressHistory: (address: string, signal?: AbortSignal) => getJson<AccountHistoryResponse>(`/explorer/address/${encodeURIComponent(address)}/history`, signal),
  // Value-chart variant: `series=1` leaves out the per-asset balance history, 98-99%
  // of the full payload and read only by the Balances treemap.
  addressHistorySeries: (address: string, signal?: AbortSignal) => getJson<AccountHistoryResponse>(withQuery(`/explorer/address/${encodeURIComponent(address)}/history`, { series: '1' }), signal),
  closeAccounts: (address: string, signal?: AbortSignal) => getJson<CloseAccountsResponse>(`/explorer/address/${encodeURIComponent(address)}/close-accounts`, signal),
  tagCloseAccounts: (tagId: string, signal?: AbortSignal) => getJson<CloseAccountsResponse>(`/explorer/tag/${encodeURIComponent(tagId)}/close-accounts`, signal),
  accountActivity: (address: string, type = 'all', offset = 0, limit = 25, action?: string, from?: string, to?: string, filters?: ValueFilters, signal?: AbortSignal) =>
    getJson<ActivityRow[]>(withQuery(`/explorer/address/${encodeURIComponent(address)}/activity`, { type, offset, limit, action, from, to, ...filters }), signal),
  accountExtrinsics: (address: string, offset = 0, limit = 25, from?: string, to?: string, filters?: ExtrinsicFilters, signal?: AbortSignal) =>
    getJson<ExtrinsicSummary[]>(withQuery(`/explorer/address/${encodeURIComponent(address)}/extrinsics`, { offset, limit, from, to, ...filters }), signal),
  accountEvents: (address: string, offset = 0, limit = 25, from?: string, to?: string, filters?: EventFilters, signal?: AbortSignal) =>
    getJson<EventRow[]>(withQuery(`/explorer/address/${encodeURIComponent(address)}/events`, { offset, limit, from, to, ...filters }), signal),
  // Governance votes cast by the account (OpenGov + Democracy + collectives).
  accountVotes: (address: string, offset = 0, limit = 25, from?: string, to?: string, signal?: AbortSignal) =>
    getJson<VoteRow[]>(withQuery(`/explorer/address/${encodeURIComponent(address)}/votes`, { offset, limit, from, to }), signal),
  accountActivityCounts: (address: string, signal?: AbortSignal) => getJson<TabCounts>(`/explorer/address/${encodeURIComponent(address)}/counts`, signal),
  // How many rows one list holds under exactly the filters it is showing. `total` is
  // exact for the rows it covers; `complete: false` = the list runs deeper than the
  // pages that total can number. `total: null` = no countable prefix at all.
  accountListCount: (address: string, query: ListCountQuery, signal?: AbortSignal) =>
    getJson<ListCount>(withQuery(`/explorer/address/${encodeURIComponent(address)}/list-count`, { ...query }), signal),
  // Largest value-changing events (big transfers and swaps) for the
  // value-history chart's markers; defaults to the account's full indexed range.
  accountValueEvents: (address: string, from?: string, to?: string, signal?: AbortSignal) =>
    getJson<ValueEvent[]>(withQuery(`/explorer/address/${encodeURIComponent(address)}/value-events`, { from, to }), signal),
  tagValueEvents: (tagId: string, from?: string, to?: string, signal?: AbortSignal) =>
    getJson<ValueEvent[]>(withQuery(`/explorer/tag/${encodeURIComponent(tagId)}/value-events`, { from, to }), signal),
  tag: (tagId: string, signal?: AbortSignal) => getJson<TagDetail>(`/explorer/tag/${encodeURIComponent(tagId)}`, signal),
  // The tag's members as directory rows — the same shape /explorer/accounts
  // returns, so a tag page renders the directory table rather than its own list.
  tagMembers: (tagId: string, signal?: AbortSignal) =>
    getJson<AccountsPage>(`/explorer/tag/${encodeURIComponent(tagId)}/members`, signal),
  // Lightweight variant for the hover card (skips the heavy portfolio-history walk).
  tagSummary: (tagId: string, signal?: AbortSignal) => getJson<TagDetail>(withQuery(`/explorer/tag/${encodeURIComponent(tagId)}`, { summary: '1' }), signal),
  tagActivity: (tagId: string, type = 'all', offset = 0, limit = 25, action?: string, from?: string, to?: string, filters?: ValueFilters, signal?: AbortSignal) =>
    getJson<ActivityRow[]>(withQuery(`/explorer/tag/${encodeURIComponent(tagId)}/activity`, { type, offset, limit, action, from, to, ...filters }), signal),
  tagExtrinsics: (tagId: string, offset = 0, limit = 25, from?: string, to?: string, filters?: ExtrinsicFilters, signal?: AbortSignal) =>
    getJson<ExtrinsicSummary[]>(withQuery(`/explorer/tag/${encodeURIComponent(tagId)}/extrinsics`, { offset, limit, from, to, ...filters }), signal),
  tagEvents: (tagId: string, offset = 0, limit = 25, from?: string, to?: string, filters?: EventFilters, signal?: AbortSignal) =>
    getJson<EventRow[]>(withQuery(`/explorer/tag/${encodeURIComponent(tagId)}/events`, { offset, limit, from, to, ...filters }), signal),
  tagVotes: (tagId: string, offset = 0, limit = 25, from?: string, to?: string, signal?: AbortSignal) =>
    getJson<VoteRow[]>(withQuery(`/explorer/tag/${encodeURIComponent(tagId)}/votes`, { offset, limit, from, to }), signal),
  governance: (signal?: AbortSignal) => getJson<GovernanceOverview>('/explorer/governance', signal),
  governanceReferenda: (pallet: 'opengov' | 'democracy', status?: string, track?: number, offset = 0, limit = 25, signal?: AbortSignal) =>
    getJson<GovernanceReferendaPage>(withQuery('/explorer/governance/referenda', { pallet, status, track, offset, limit }), signal),
  governanceMotions: (body: 'tc' | 'council', offset = 0, limit = 25, signal?: AbortSignal) =>
    getJson<CollectiveMotionsPage>(withQuery('/explorer/governance/motions', { body, offset, limit }), signal),
  governanceTips: (offset = 0, limit = 25, signal?: AbortSignal) =>
    getJson<TreasuryTipsPage>(withQuery('/explorer/governance/tips', { offset, limit }), signal),
  // Grouped mode of the votes tab: one row per referendum, members combined.
  tagVotesByReferendum: (tagId: string, offset = 0, limit = 25, signal?: AbortSignal) =>
    getJson<VotesByReferendumPage>(withQuery(`/explorer/tag/${encodeURIComponent(tagId)}/votes-by-referendum`, { offset, limit }), signal),
  tagActivityCounts: (tagId: string, signal?: AbortSignal) => getJson<TabCounts>(`/explorer/tag/${encodeURIComponent(tagId)}/counts`, signal),
  tagListCount: (tagId: string, query: ListCountQuery, signal?: AbortSignal) =>
    getJson<ListCount>(withQuery(`/explorer/tag/${encodeURIComponent(tagId)}/list-count`, { ...query }), signal),
  search: (query: string, signal?: AbortSignal) => getJson<SearchResult[]>(withQuery('/explorer/search', { q: query }), signal),
  assets: (signal?: AbortSignal) => getJson<AssetListItem[]>('/explorer/assets', signal),
  // Token-filter variant: the same ordered directory without prices, totals or
  // sparklines — 74 kB down to 5.8 kB, since the combo reads ids and symbols only.
  assetFilterOptions: (signal?: AbortSignal) => getJson<AssetFilterItem[]>(withQuery('/explorer/assets', { fields: 'filter' }), signal),
  // The call/event names the data actually holds, for the name filters. Cached
  // an hour on both ends — a name list moves only with a runtime upgrade.
  filterNames: (signal?: AbortSignal) => getJson<FilterNames>('/explorer/filter-names', signal),
  accounts: (offset = 0, limit = 50, sort: AccountSort = 'value', signal?: AbortSignal) => getJson<AccountsPage>(withQuery('/explorer/accounts', { offset, limit, sort }), signal),
  // The daily histogram can mirror the activity page's tab + filters.
  daily: (scope: string, params?: { type?: string; action?: string; token?: string }, signal?: AbortSignal) => getJson<DailyPoint[]>(withQuery(`/explorer/daily/${scope}`, { ...params }), signal),
  accountsDaily: (signal?: AbortSignal) => getJson<{ date: string; active: number; new: number }[]>('/explorer/accounts-daily', signal),
  tags: (signal?: AbortSignal) => getJson<Tag[]>('/explorer/tags', signal),
}
