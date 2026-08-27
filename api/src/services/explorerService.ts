import type { ClickHouseClient } from '../db/client.ts'
import { cached, cachedSwr, cacheExpiry, cacheRefresh, seedStale } from './cache.ts'
import { NOMINAL_BLOCKS_PER_HOUR, blocksPerHour, measuredParaBlockMs, paraBlockMs } from './blockTime.ts'
import { referendumTitleFor, referendumTitleKey } from './referendumTitleService.ts'
// Type-only: governanceService imports value exports back from this file (accountRef,
// ensurePrices, …), so a runtime import here would cycle. search() reaches getReferenda
// through a dynamic import instead, same as the tag branch does for tagService.
import type { ReferendumListRow, ReferendumPallet } from './governanceService.ts'
import { weightedFromLabels } from './convictionWeight.ts'
import { assetDescriptor, allExplorerAssets, isXykShareToken, type ExplorerAsset } from './explorerAssets.ts'
import { accountVolumeSource } from './accountTradeVolume.ts'
import { tagForAccount, ammPoolAccounts, getTag as getTagRecord, allTags } from './tagService.ts'
import { identityForAccount, searchIdentitiesByDisplay, type AccountIdentity } from './identityService.ts'
import { normalizeAddress, basiliskAddress, reservedH160AccountId } from './addressIdentity.ts'
import { accountIcon, emojisMatchingName, emojiNameFor, parseSuffixEmojiQuery, KUSAMA_SS58_PREFIX } from './omniwatchIdentity.ts'
import { encodeAddress } from '@polkadot/util-crypto'
import { hexToU8a } from '@polkadot/util'
import { proxyInfoFor, multisigCompositionFor, multisigMembershipsFor, pendingMultisigOps, threshold1OpsFor, type ProxyRelation, type PendingMultisigOp } from './proxyMultisigService.ts'
import {
  resolveProxyInner, buildMultisigOperations, enrichMultisigOperations, proxyChildAddress,
  type ExtrinsicCallRow, type ProxyInnerInfo, type MultisigLifecycleEvent, type MultisigCallInfo,
  type MultisigOperationState,
} from './onBehalfActivity.ts'
import { FEE_BALANCE_EVENTS, deriveFeePayment, hasSubstrateFee, type FeePaymentEvent } from './extrinsicFeePayment.ts'
import { queryLockBreakdowns, type AssetLockBreakdown, type BalanceLockComponent, type BalanceLockTranche, type BalanceUnlockSlice } from './lockBreakdownService.ts'
import { createHash } from 'node:crypto'
import { resolveModuleError } from './runtimeErrorNames.ts'

let client: ClickHouseClient
export function initExplorerService(c: ClickHouseClient): void { client = c }
/**
 * Whether this service already has its handle. Exists so a service that depends on
 * it transitively (poolService, whose every value is priced through `ensurePrices`)
 * can supply a handle for a process that has none WITHOUT repointing the one an
 * already-booted process is using — a long-op or scratch client silently replacing
 * the live price loader's would be invisible until prices went stale.
 */
export function hasExplorerClient(): boolean { return client != null }

// query shapes and the numbers that justify them
//
// Many comments below defend a query's shape with a measurement — rows read, bytes,
// CPU seconds, peak memory, a p50/p99 fan-out. Those numbers were measured on
// hydration-neckwork, against Hydration's data: a far larger chain, with pallets
// (Omnipool, Stableswap, money market) snekwork does not index at all. They are kept
// because the SHAPE they argue for is still the right one — a key-first read, a
// bounded ASOF right side, a chunk size below the client's result guard — and
// deleting the evidence would leave the shapes looking arbitrary.
//
// Treat every such figure as the reason for a decision, never as a current fact about
// this instance. Re-profile against live Basilisk before citing one, and update the
// number in place when you do.

// shared shapes
export type AssetRef = ExplorerAsset
export interface AccountRef {
  accountId: string
  address: string                                   // Basilisk SS58 (prefix 10041)
  emoji: string                                     // deterministic identity emoji, derived from the account's public key
  emojiName?: string                                // human-readable name for the custom emoji/icon (e.g. Discord emoji name)
  emojiUrl?: string                                 // custom image icon (e.g. a Discord avatar) — render in place of the emoji char
  tag: { id: string; name: string; color: string; icon: string; memberCount?: number } | null
  identity?: AccountIdentity | null   // on-chain Identity.IdentityOf display + judgement status
}

function asset(assetIdStr: string | number): AssetRef {
  const id = typeof assetIdStr === 'number' ? assetIdStr : parseInt(assetIdStr, 10)
  return assetDescriptor(Number.isFinite(id) ? id : 0)
}

// Resolve a tag's display icon for aggregate (SQL-grouped) rows: prefer the
// explicit icon from the DB row, else the icon the tagService derived (from the
// tag's first member's omniwatch emoji). Keeps grouped rows consistent with
// per-account tag display.
function tagIcon(tagId: string, dbIcon: string): string {
  if (dbIcon) return dbIcon
  return getTagRecord(tagId)?.icon || '🏷️'
}

export function accountRef(accountId: string): AccountRef {
  const resolved = accountId
  const t = tagForAccount(resolved)
  // Basilisk SS58 (prefix 10041) is the canonical display form for every account;
  // there are no EVM accounts to show an H160 for.
  const id = identityForAccount(resolved)
  const icon = accountIcon(resolved)
  return {
    accountId: resolved,
    address: basiliskAddress(resolved),
    emoji: icon.emoji,
    emojiName: icon.emojiName,
    emojiUrl: icon.emojiUrl,
    tag: t ? { id: t.tagId, name: t.name, color: t.color, icon: t.icon, memberCount: t.memberCount } : null,
    identity: id,
  }
}

const ACCOUNT_RE = /^0x[0-9a-f]{64}$/
function sqlAccountList(accounts: string[]): string {
  const safe = accounts.filter(a => ACCOUNT_RE.test(a))
  return safe.length ? safe.map(a => `'${a}'`).join(',') : "''"
}
function sqlUIntList(values: Array<string | number>): string {
  const safe = [...new Set(values.map(v => String(v)).filter(v => /^\d+$/.test(v)))]
  return safe.length ? safe.join(',') : ''
}

// Every XCM consumer collapses stable (block,event) identities while decoding.
// Avoid FINAL here: it disables primary-key pruning on this 55M-row replacing
// model and turns bounded block/asset lookups into multi-gigabyte partition
// merges during request handling.
//
// This one is keyed (event_name, asset_id, block_height, event_index): it serves
// the reads that name an event family and either a block set or an asset — global
// candidate walks, the outbound reads, the MessageQueue barrier reads, the global
// arm of the remote-pull withdrawal decode, and the asset surface. A barrier read
// reaches block_height through that key even though it names no asset: MessageQueue.
// Processed carries no currency at all, so it occupies a single asset_id = 0 range
// and the block set prunes inside it — 12.3k rows for a 1,000-block set. It is also
// the only read still needing args_json, whose success/id/origin are not columns.
function xcmEventActivityTable(alias = ''): string {
  return `price_data.xcm_event_activity${alias ? ` AS ${alias}` : ''}`
}
// The inbound walk's own rows, keyed (block_height, event_index). That walk needs a
// block's WHOLE contiguous run of deposit-family events below the barrier, so it can
// never be account-scoped — and naming eight event families with no asset leaves
// block_height third in the table above's key and unreachable, so the read scans
// every asset range of all eight. Replaying one cold count's 59 chunk reads: 45.5M
// rows / 2.71 GiB / 754 ms there against 13.4M rows / 964.6 MiB / 382 ms here, for
// byte-identical results (279,336 rows both). The projection holds only those eight
// families in hook context, 15.2M of the parent's 55.8M rows and 205.6 MiB of its
// 1.87 GiB. index_granularity is its siblings' 4096: candidate blocks arrive far
// denser than any granule's block span (a chunk's ~766 blocks spread over ~250k
// chain blocks, one per ~326, against ~3.5k chain blocks per granule), so 1024 skips
// no more of them worth having — 9.9M rows / 724.7 MiB but 452 ms, slower on the
// extra mark ranges.
//
// The same no-FINAL contract holds, for the same reason: the decoder folds these rows
// by their stable (block_height, event_index) identity while walking a block's run —
// each credit keyed on (who, currency, amount) — so an un-merged replacement
// duplicate cannot survive into a row, while FINAL would forfeit exactly the
// block-prefix pruning this table exists to provide.
function xcmInboundWalkTable(alias = ''): string {
  return `price_data.xcm_inbound_walk_events${alias ? ` AS ${alias}` : ''}`
}
// Same rows, keyed (who, block_height, event_index), for the reads that name
// accounts. `who` is absent from the sort key of the table above, so an
// account-scoped read of it prunes nothing. The heaviest cross-chain account's
// exact XCM count (62,060 rows) read 518M rows / 9.79 GiB out of that table and
// reads 50M rows / 2.02 GiB across the same query count once its account-scoped
// arms come from here — same answer, a tenth of the rows. Per candidate page:
// 12.8M rows / 820 MiB / 378 ms there against 2.3M rows / 143 MiB / 27 ms here.
//
// The same no-FINAL contract holds, for the same reason: every consumer folds
// these rows by their stable (block_height, event_index) identity while decoding
// — inbound credits key on (who, currency, amount) inside a block's deposit run,
// remote pulls on (block, barrier, who, currency, amount) — so an un-merged
// replacement duplicate cannot survive into a row, while FINAL would forfeit the
// account-prefix pruning that is this table's entire purpose.
function xcmEventActivityByAccountTable(alias = ''): string {
  return `price_data.xcm_event_activity_by_account${alias ? ` AS ${alias}` : ''}`
}

// One arm per account costs at least one granule per active part of
// account_activity_v3 (~130 parts × 8192 rows here), which the merged mark ranges
// of a single `account IN (…)` scan pay only once. Measured on a 25-row page: 10
// accounts read 1.0M rows merged vs 5.0M split, 16 accounts 14.8M merged vs 8.0M
// split, 729 accounts 37.5M merged vs 360M split. Keep the fan-out to a handful
// of accounts, where the split can never read more than a few million rows, and
// let larger member sets (tags) keep the merged scan.
const MAX_ACCOUNT_ACTIVITY_ARMS = 8

// Newest-first distinct (block_height, event_index) references for an account
// set, read out of the account-activity index.
//
// `account_activity_v3` is `ORDER BY (account, block_height, event_index)`, so a
// single `WHERE account IN (…) GROUP BY block_height, event_index` groups on a
// key that is NOT a sort-order prefix: ClickHouse has to hash every row of every
// listed account before `ORDER BY … LIMIT` can discard anything. The Omnipool
// pallet account alone holds 72.5M references behind a 66-byte `account` String
// — 5.3 GiB read and 4.07 GiB of aggregate state, i.e. a 500 on the query memory
// ceiling rather than a page.
//
// So give each account its own arm. With `account` pinned to a literal,
// (block_height, event_index) is exactly the remainder of the sort key, so an
// arm is a reverse primary-key read that stops after `limit` rows and the outer
// GROUP BY only ever sees `accounts × limit` of them.
//
// Taking the `offset + limit` newest per arm is exact for a merged
// `offset + limit`: arms and merge share one ordering, so a reference at merged
// rank r also sits at rank ≤ r inside its own account's stream — nothing older
// than an account's (offset + limit)-th newest reference can reach the merged
// head. The outer GROUP BY still owns every de-duplication the single scan did:
// the same event reached through several related accounts or tag members, and
// identical index rows in un-merged ReplacingMergeTree parts left by a replayed
// range (those collapse before they can shorten a page unless a single arm's
// window is mostly replay copies, which merges undo within minutes).
//
// Caller predicates belong INSIDE the arms. Filtering after the per-arm LIMIT
// would keep the newest references first and only then drop the non-matching
// ones, which is how a bounded feed silently loses older matches.
export function accountActivityRefsQuery(accounts: string[], eventCond: string, bound: string, limit: number, offset = 0): string {
  const pageLimit = Math.max(0, Math.trunc(limit))
  const pageOffset = Math.max(0, Math.trunc(offset))
  const armLimit = pageLimit + pageOffset
  const safe = accounts.filter(a => ACCOUNT_RE.test(a))
  const cond = eventCond ? ` AND ${eventCond}` : ''
  const body = safe.length > MAX_ACCOUNT_ACTIVITY_ARMS
    ? `SELECT block_height, event_index FROM price_data.account_activity_v3
    WHERE account IN (${sqlAccountList(safe)}) AND ${bound}${cond}`
    : `SELECT block_height, event_index FROM (${(safe.length ? safe : ['']).map(account => `
      SELECT block_height, event_index FROM price_data.account_activity_v3
      WHERE account = '${account}' AND ${bound}${cond}
      ORDER BY block_height DESC, event_index DESC
      LIMIT ${armLimit}`).join('\n      UNION ALL')}
    )`
  return `${body}
    GROUP BY block_height, event_index
    ORDER BY block_height DESC, event_index DESC
    LIMIT ${pageLimit}${pageOffset ? ` OFFSET ${pageOffset}` : ''}`
}

// The same references as an IN-prefilter. The surrounding query keeps its precise
// conditions — this only shrinks the scanned granule set, so a hit set that also
// passes the original WHERE is unchanged.
function accountActivityRefsSql(accounts: string[], eventCond: string, bound: string, limit: number): string {
  return `(block_height, event_index) IN (
    ${accountActivityRefsQuery(accounts, eventCond, bound, limit)})`
}

// Unfiltered recent-first feeds only need the newest slice of history: bound the
// scan by block_height (primary-key prunable) and fall back to the full range
// only when the window returns fewer rows than the SQL asked for (sparse
// filters, deep offsets, end of data). Worst case = one cheap extra query on
// top of exactly what ran before.
//
// The window is SEVEN DAYS of wall clock, resolved through the blocks table the
// same way cutoffHeightForWindow does, not a fixed block count: a block is ~6s
// today and 2s is planned, so a `head − 100 800` offset would silently shrink
// to ~2.3 days at the upgrade. ClickHouse folds the scalar sub-select to a
// constant before the scan, so the bound stays primary-key prunable.
//
// The sub-select reads `price_data.blocks`, not `raw_blocks` as the old
// head-offset form did. Both advance with ingestion and block heights are
// global, so the bound is the same window either way; `blocks` is used because
// it is the table cutoffWindowSql already resolves every other wall-clock
// window against, and it carries the timestamp partitioning that makes the
// lookup cheap. Both failure directions are safe: a `blocks` table that lags
// yields an OLDER cutoff (a wider window — more scanned, nothing missed), and
// an empty one yields min() = 0, i.e. the whole range.
const FEED_WINDOW_HOURS = 168
export function feedWindowBoundSql(): string {
  return `block_height > (${cutoffWindowSql(FEED_WINDOW_HOURS)})`
}
// A Basilisk block targets two seconds today. Keep hot feed results for a couple
// of blocks so staggered clients share one ClickHouse read.
const LIVE_CACHE_MS = 5_000
// The API client's own result-row guard (`max_result_rows` in db/client.ts). A read
// that would return more rows than this fails the whole request with a ClickHouse
// 500, so no single source read may ask for more — not even after a row multiplier
// is applied on top of a candidate count.
const MAX_QUERY_RESULT_ROWS = 100_000
// Keep candidate walks below the API client's 100k result-row guard. Sparse
// filters fail explicitly with 413 instead of leaking a ClickHouse 500 after a
// power-of-four widening step crosses the transport limit.
const MAX_ACTIVITY_SOURCE_ROWS = 90_000
function activityQueryTooBroad(): Error {
  return Object.assign(new Error('Requested activity page requires too many candidate rows; narrow the filters or date range'), {
    code: 'ACTIVITY_QUERY_TOO_BROAD',
    statusCode: 503,
  })
}
async function withFeedWindow<T>(tw: string | null, expectRows: number, depth: number, run: (bound: string) => Promise<T[]>): Promise<T[]> {
  if (tw) return run(tw)
  if (depth > 10_000) return run('1')
  const rows = await run(feedWindowBoundSql())
  return rows.length >= expectRows ? rows : run('1')
}

// Full-data guarantee for POST-filtered feeds: a filter must never see only a
// recency window ("an hour of chain"). Pages walk backward through the whole
// history by block cursor; each page fetches up to `pageSize` candidate rows
// (newest-first) and keeps the ones `matches` accepts, until `want` filtered
// rows exist or history is exhausted. Rows must expose blockHeight (ActivityRow
// shape) for the cursor. Callers cache results, so the rare deep walk for a
// narrow filter is paid once per TTL.
export async function fetchFilteredDeep<T>(
  tw: string | null,
  want: number,
  run: (bound: string, pageLimit: number) => Promise<T[]>,
  matches: (t: T) => boolean,
  blockOf: (t: T) => number,
  eventOf: (t: T) => number,
  keyOf: (t: T) => string,
  opts: {
    pageSize?: number
    pageState?: () => { scanned: number; cursor: { blockHeight: number; eventIndex: number } | null }
  } = {},
): Promise<T[]> {
  // Most callers already push token/value predicates into ClickHouse, so a
  // fixed 25k candidate page massively over-fetches for the usual 25-row UI
  // page (and makes every source in the merged activity scan deep history at
  // once).  Scale the first-class cursor page to the requested result count;
  // sparse post-filters still retain full-history semantics because the loop
  // keeps walking backwards until `want` matches have been collected.
  const initialPageSize = opts.pageSize ?? Math.min(Math.max(want * 2, 500), 25_000)
  // Grow sparse walks geometrically. Common filters stop after the cheap first
  // page; sparse filters continue until enough matches exist or history ends.
  const base = tw ?? '1'

  const out: T[] = []
  const seen = new Set<string>()
  let cursor: { blockHeight: number; eventIndex: number } | null = null
  for (let page = 0; ; page++) {
    // Walk the same descending (block,event) order used by every raw-event
    // source. A block-only inclusive cursor can repeat the first LIMIT rows
    // forever when one dense block straddles a page boundary.
    const bound = cursor == null
      ? base
      : `(${base}) AND (block_height < ${cursor.blockHeight} OR (block_height = ${cursor.blockHeight} AND event_index < ${cursor.eventIndex}))`
    const pageSize = Math.min(initialPageSize * 2 ** Math.min(page, 16), 25_000)
    const rows = await run(bound, pageSize)
    for (const r of rows) {
      const k = keyOf(r)
      if (seen.has(k)) continue
      seen.add(k)
      if (matches(r)) out.push(r)
    }
    const pageState = opts.pageState?.()
    if (out.length >= want || (pageState?.scanned ?? rows.length) < pageSize) break
    let next = pageState?.cursor ?? null
    if (!pageState) {
      for (const row of rows) {
        const candidate = { blockHeight: blockOf(row), eventIndex: eventOf(row) }
        if (!Number.isSafeInteger(candidate.blockHeight) || !Number.isSafeInteger(candidate.eventIndex)) continue
        if (next == null || candidate.blockHeight < next.blockHeight ||
          (candidate.blockHeight === next.blockHeight && candidate.eventIndex < next.eventIndex)) next = candidate
      }
    }
    if (next == null || (cursor != null &&
      (next.blockHeight > cursor.blockHeight ||
        (next.blockHeight === cursor.blockHeight && next.eventIndex >= cursor.eventIndex)))) break
    cursor = next
  }
  return out
}

export function activitySourceCoversCutoff(
  sourceSize: number,
  fetchSize: number,
  oldest: { blockHeight: number; eventIndex: number } | null,
  cutoff: { blockHeight: number; eventIndex?: number | null } | null,
): boolean {
  if (sourceSize < fetchSize) return true
  if (!oldest || !cutoff) return false
  return oldest.blockHeight < cutoff.blockHeight ||
    (oldest.blockHeight === cutoff.blockHeight && oldest.eventIndex <= (cutoff.eventIndex ?? -1))
}

export function activitySourcesNeedingMore<T extends {
  rawSize: number
  fetchSize: number
  oldest: { blockHeight: number; eventIndex: number } | null
  valueIrrelevant?: boolean
}>(
  sources: T[],
  cutoff: { blockHeight: number; eventIndex?: number | null } | null,
  skipValueIrrelevant: boolean,
): T[] {
  return sources.filter(source => {
    if (skipValueIrrelevant && source.valueIrrelevant) return false
    return cutoff
      ? !activitySourceCoversCutoff(source.rawSize, source.fetchSize, source.oldest, cutoff)
      : source.rawSize >= source.fetchSize
  })
}

export function completeActivityPageCutoff<T extends { blockHeight: number; eventIndex?: number | null }>(
  visibleRows: T[],
  want: number,
): T | null {
  return visibleRows.length >= want ? visibleRows[want - 1] ?? null : null
}

// Once one independently complete activity family supplies a merged-page
// cutoff, every other family only needs to prove coverage back to that point.
// Source readers accept day bounds rather than timestamps, so include the
// cutoff's entire UTC day (rows earlier on that day are harmless and make the
// boundary proof conservative). Preserve a caller's later explicit bound.
export function activityCutoffFromDate<T extends { timestamp: string }>(
  requestedFrom: string | undefined,
  cutoffRows: T[],
  want: number,
): string | undefined {
  if (cutoffRows.length < want) return requestedFrom
  const cutoffDay = cutoffRows[want - 1]?.timestamp.slice(0, 10)
  if (!cutoffDay || !/^\d{4}-\d{2}-\d{2}$/.test(cutoffDay)) return requestedFrom
  return requestedFrom && requestedFrom > cutoffDay ? requestedFrom : cutoffDay
}

// Adjacent UI pages should reuse the same source-prefix cache whenever that
// prefix already proves the deeper merged cutoff. Power-of-two buckets keep
// page 1/2 (16 rows per family), page 3/4 (32), etc. on identical source keys.
export function activitySourceSeedSize(want: number): number {
  const target = Math.max(10, Math.ceil(want / 4))
  let bucket = 16
  while (bucket < target && bucket < MAX_ACTIVITY_SOURCE_ROWS) bucket *= 2
  return Math.min(bucket, MAX_ACTIVITY_SOURCE_ROWS)
}

// How deep a shared classified window has to prove itself, quantised so the pages
// that walk one feed land on one key instead of assembling the same ordering per
// click: the next power of two at or above the depth the page needs. A feed's
// windows are then 32, 64, 128 … rows — logarithmically many in its depth — and
// pages collapse onto one key faster the deeper they go, which is where paging
// costs the most. Every offset from 1,025 to 2,048 shares one window.
//
// Every request quantises, including the first page, and that is deliberate in
// both directions:
//
//   - Rounding up is not free. It is one more widening round for each source that
//     has not yet crossed the deeper cutoff, and how much that costs depends on
//     how sparse the filter is. On the global feed at min=95000, proving 64 rows
//     instead of 25 cost nothing measurable (585 -> 525 queries, 29.4 -> 28.3 s);
//     at min=2000000 it cost 246 s -> 653 s. Hence a power of two rather than the
//     source-seed bucket (4 x activitySourceSeedSize), which would have rounded a
//     25-row page to 64 instead of 32.
//   - Quantising ALL of them is what keeps the feed's published ordering a
//     function of the bucket alone, so any two requests needing the same depth
//     read the same window. It is also worth more than it looks: the builder's
//     ordering is not perfectly depth-independent — measured on the frozen
//     min=95000 feed (no inserts in range), windows of depth 25, 32, 50, 64, 100
//     and 128 all agree on their common prefix, but a window of depth 75 diverges
//     from every one of them at index 59. Fewer distinct depths means fewer
//     chances for two pages of one feed to be slices of two different orderings.
export function activityWindowDepth(want: number): number {
  let depth = 1
  while (depth < want) depth *= 2
  return depth
}

// Whether a prefiltered transfer read has to be taken again without its prefilter: it
// came back short of its limit AND the account holds a transfer reference past the
// prefilter's cap, so the cap — not the end of history — is what ended the read.
//
// Kept as a pure function because the alternative reading of a short read is the one
// that silently omits history: treating "few rows" as "no more rows" publishes a
// complete feed that stops wherever the cap fell.
export function transferReadNeedsWholeBound(rawRows: number, rawLimit: number, refPastCap: boolean): boolean {
  return rawRows < rawLimit && refPastCap
}

// Build a block_timestamp WHERE fragment for a day-range filter (YYYY-MM-DD).
// Returns null when no valid dates are given (callers then use the recent window).
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
function timeWindow(from?: string, to?: string): string | null {
  const parts: string[] = []
  if (from && DATE_RE.test(from)) parts.push(`block_timestamp >= '${from} 00:00:00'`)
  if (to && DATE_RE.test(to)) parts.push(`block_timestamp < '${to} 00:00:00' + INTERVAL 1 DAY`)
  return parts.length ? parts.join(' AND ') : null
}

export interface ExtrinsicListFilters { call?: string; result?: 'success' | 'failed'; origin?: 'signed' | 'proxy' | 'multisig' }
export interface EventListFilters { event?: string }
export interface ValueListFilters {
  token?: string
  min?: number
  unit?: 'usd' | 'token'
  identity?: 'named' | 'unnamed'
  // Accounts THIS viewer has tagged, in their own lists or ones they subscribe
  // to (userListService.viewerTaggedAccounts). Supplied only by the
  // authenticated routes; anonymous requests judge on public names alone, so a
  // shared cache entry can never carry one viewer's tags to another — the set
  // is part of the cache key through filterKey.
  viewerTagged?: Set<string>
}
export interface VoteListFilters { referendum?: string; conviction?: string }

function textNameMatchSql(field: string, paramPrefix: string): string {
  return `(
    ${field} = {${paramPrefix}:String}
    OR positionCaseInsensitive(${field}, {${paramPrefix}:String}) > 0
    OR positionCaseInsensitive(replaceAll(${field}, '.', ' '), {${paramPrefix}Visible:String}) > 0
    OR position(replaceRegexpAll(lowerUTF8(${field}), '[^0-9a-z]', ''), {${paramPrefix}Compact:String}) > 0
  )`
}
function textNameFilter(field: string, paramPrefix: string): string {
  return `AND ${textNameMatchSql(field, paramPrefix)}`
}
function textNameParams(paramPrefix: string, value?: string): Record<string, string> {
  const raw = value?.trim() ?? ''
  return {
    [paramPrefix]: raw,
    [`${paramPrefix}Visible`]: raw.replace(/\s*\.\s*/g, ' ').trim(),
    [`${paramPrefix}Compact`]: raw.toLowerCase().replace(/[^0-9a-z]+/g, ''),
  }
}

function filterKey(filters?: object): string {
  if (!filters) return ''
  return Object.entries(filters)
    .filter(([, v]) => v != null && v !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    // A Set stringifies to "[object Set]", so every viewer's tag set would key
    // the SAME entry and one viewer's filtered page would be served to another.
    // Sorted membership makes the key the thing it stands for; two viewers who
    // tagged the same accounts genuinely share a page and should share a key.
    .map(([k, v]) => `${k}=${v instanceof Set ? [...v].sort().join('+') : String(v)}`)
    .join('&')
}

// TS-side replica of textNameFilter's four match rules, for filtering rows
// that are assembled in application code (on-behalf extrinsic candidates)
// rather than selected straight out of ClickHouse. `String.includes('')` is
// true for every haystack, matching ClickHouse's `position(x, '') > 0`, so an
// empty derived needle (e.g. a filter with no alnum characters) still behaves
// like the SQL version.
function matchesCallFilter(name: string, filter: string): boolean {
  const raw = filter.trim()
  if (name === raw) return true
  if (name.toLowerCase().includes(raw.toLowerCase())) return true
  const visible = raw.replace(/\s*\.\s*/g, ' ').trim()
  if (name.replace(/\./g, ' ').toLowerCase().includes(visible.toLowerCase())) return true
  const compact = raw.toLowerCase().replace(/[^0-9a-z]+/g, '')
  return name.toLowerCase().replace(/[^0-9a-z]+/g, '').includes(compact)
}

function assetIdsForToken(token?: string): number[] | undefined {
  const t = token?.trim()
  if (!t) return undefined
  const n = Number.parseInt(t, 10)
  const ids = allExplorerAssets()
    .filter(a => a.symbol.toLowerCase() === t.toLowerCase() || (Number.isInteger(n) && a.assetId === n))
    .map(a => a.assetId)
  return [...new Set(ids)]
}

function assetIdFilterSql(assetExpr: string, ids?: number[]): string {
  if (ids == null) return ''
  if (!ids.length) return 'AND 0'
  return `AND toUInt32(${assetExpr}) IN (${ids.join(',')})`
}
function eventAssetRefsFilterSql(ids: number[] | undefined, eventNamesSql: string, bound = '1'): string {
  if (ids == null) return ''
  if (!ids.length) return 'AND 0'
  return `AND (block_height, event_index) IN (
    SELECT block_height, event_index
    FROM price_data.event_asset_refs
    WHERE ${bound} AND asset_id IN (${ids.join(',')}) AND event_name IN (${eventNamesSql})
  )`
}
function currencyIdSql(args = 'args_json'): string {
  return `multiIf(
    JSONHas(${args}, 'currencyId'), JSONExtractInt(${args}, 'currencyId'),
    JSONHas(${args}, 'currency_id'), JSONExtractInt(${args}, 'currency_id'),
    JSONHas(${args}, 'assetId'), JSONExtractInt(${args}, 'assetId'),
    JSONHas(${args}, 'asset_id'), JSONExtractInt(${args}, 'asset_id'),
    0
  )`
}
// Module pots whose transfer legs are pure swap/fee plumbing on an ACCOUNT
// page (the trade/dca rows already represent the action): router hops, pool
// legs, fee sweeps. Other pallet pots — treasury (donations/funding), vesting
// payouts, LM reward claims — are the account's real value movements and stay
// visible. The GLOBAL transfer feed keeps its blanket module exclusion.
const NOISY_TRANSFER_POTS = [
  '0x6d6f646c726f7574657265780000000000000000000000000000000000000000', // routerex (swap hops)
  '0x6d6f646c66656570726f632f0000000000000000000000000000000000000000', // feeproc/ (fee sweeps)
]
const noisyPotList = () => NOISY_TRANSFER_POTS.map(a => `'${a}'`).join(',')

// The treasury pot receives every extrinsic's transaction fee — and deposits such
// as a referral-code registration — as a Balances/Currencies transfer. Those are
// fees/deposits, not user transfers: a routed swap's fee leg is already dropped as
// trade noise, but non-swap fees/deposits (Referrals.register_code, XCM inherents
// like ParachainSystem.set_validation_data, plain batches) are not. So on a normal
// account's transfer feed a transfer *to* the treasury is surfaced only when its
// originating extrinsic is itself a token-transfer call (a genuine donation);
// payouts *from* the treasury stay visible.
const TREASURY_POT = '0x6d6f646c70792f74727372790000000000000000000000000000000000000000'
const TRANSFER_CALL_NAMES = new Set([
  'Balances.transfer', 'Balances.transfer_keep_alive', 'Balances.transfer_all', 'Balances.transfer_allow_death',
  'Tokens.transfer', 'Tokens.transfer_all', 'Tokens.transfer_keep_alive',
  'Currencies.transfer', 'Currencies.transfer_native_currency',
  'XTokens.transfer', 'XTokens.transfer_multiasset', 'XTokens.transfer_multicurrencies',
  'XTokens.transfer_multiassets', 'XTokens.transfer_with_fee', 'XTokens.transfer_multiasset_with_fee',
])

// XCM sovereign / system accounts — sibling-parachain (`sibl`), sovereign
// parachain (`para`) and relay (`Parent`) — are bridge plumbing, never a user's
// own transfer. Distinct from the `modl` pallet pots, which include genuine
// payout sources such as the treasury.
const XCM_SOVEREIGN_PREFIXES = ['7369626c', '70617261', '506172656e74']

// Non-plumbing transfer-leg filter shared by user-facing surfaces: keep a leg
// only when NEITHER side is a pure-plumbing account — a noisy swap/fee pot
// (router/omnipool/feeproc), an XCM sovereign/system account, or an AMM pool /
// money-market reserve (`plumbingList`). Unlike the GLOBAL feed's blanket
// `0x6d6f646c…` module exclusion, this keeps genuine pallet-pot payouts
// (treasury funding, vesting, LM rewards) — the account's real value movements.
// Block activity, the superset that re-derives every /transfer detail link, must
// classify with this so a treasury payout shown on an account page also resolves
// on its own detail page.
export function nonPlumbingTransferLegSql(fromExpr: string, toExpr: string, plumbingList: string): string {
  const xcm = XCM_SOVEREIGN_PREFIXES.join('|')
  return `AND ${fromExpr} NOT IN (${noisyPotList()})
                AND ${toExpr} NOT IN (${noisyPotList()})
                AND NOT match(${fromExpr}, '^0x(${xcm})')
                AND NOT match(${toExpr}, '^0x(${xcm})')
                AND ${fromExpr} NOT IN (${plumbingList})
                AND ${toExpr} NOT IN (${plumbingList})`
}

// XYK.PoolCreated seeds a brand-new pool — a liquidity action in its own
// right ('Create'), not a pair of raw transfers to an unknown account.
export function liqActionFor(eventName: string): 'Add' | 'Remove' | 'Create' | 'Claim' | 'Destroy' {
  if (eventName.endsWith('RewardClaimed')) return 'Claim'   // LM reward claims
  if (eventName.endsWith('PoolDestroyed')) return 'Destroy' // lifecycle marker, no value
  return eventName.endsWith('PoolCreated') ? 'Create' : eventName.endsWith('Removed') ? 'Remove' : 'Add'
}
// Which liquidity events yield rows the action filter keeps. Derived by APPLYING
// liqActionFor to the event list rather than restating its rule backwards, so the
// selection and the label a row carries cannot drift apart — a hand-written inverse
// is exactly how an action filter starts counting rows it does not render. An action
// no event produces selects nothing, which is the honest answer for it.
export function liquidityActionEventNames(action?: string): string[] {
  return action ? LIQUIDITY_EVENTS.filter(name => liqActionFor(name) === action) : LIQUIDITY_EVENTS
}

// Which event arg holds the amount a liquidity row displays AGAINST ITS asset_id,
// decided per event name because the denominations don't line up. A generic
// presence chain (claimed → amount → shares) silently mixes them: no XYK liquidity
// event is denominated in the asset its row displays — XYK.LiquidityRemoved carries
// `shares` next to assetA, and reading it renders LP-share units at assetA's price.
// '' means the event has no field in the displayed denomination at all; those rows
// stay empty on purpose and fillMissingLiquidityAmounts recovers the real amount
// from the paired pool↔who transfer leg in the same dispatch scope. Mirrored by the
// `amount` expressions of liquidity_activity_mv and account_activity_v3_mv (see
// liquidityAmountPairing).
export const LIQUIDITY_AMOUNT_ARG: Record<string, string> = {
  'XYK.LiquidityAdded': '',                                // amountA/amountB vs assetA
  'XYK.LiquidityRemoved': '',                              // shares vs assetA
  'XYK.PoolCreated': '',                                   // initialSharesAmount vs assetA
  'XYK.PoolDestroyed': '',                                 // no amount field; see AMOUNTLESS_LIQUIDITY_EVENTS
  // Seeding and draining an LBP: both carry amountA/amountB against assetA/assetB,
  // exactly like XYK.LiquidityAdded, so both stay empty for the same reason —
  // amountA is assetA's leg, not the row's displayed denomination. Basilisk's LBPs
  // are real history (first pool block 1,972,469), and neither this map nor
  // liquidity_activity_mv carried them before: the codebase this forked from never
  // plumbed LBP liquidity at all, so this is new admission, not a restored trim.
  'LBP.LiquidityAdded': '',                                // amountA/amountB vs assetA
  'LBP.LiquidityRemoved': '',                              // amountA/amountB vs assetA
  'XYKLiquidityMining.RewardClaimed': 'claimed',           // claimed + rewardCurrency
}

// Events whose empty amount is the ANSWER, not a gap to be recovered.
// fillMissingLiquidityAmounts pairs an amountless row with the pool↔who transfer
// leg in the same dispatch scope. XYK.PoolDestroyed is emitted in the same
// extrinsic as XYK.LiquidityRemoved, with the same `who` and the same assetA, so
// that pairing WOULD match — and would render the removal's value a second time,
// inflating every feed the row appears in and admitting it to value filters.
// 728 of 728 destructions carry that sibling, so this is unconditional.
export const AMOUNTLESS_LIQUIDITY_EVENTS: ReadonlySet<string> = new Set(['XYK.PoolDestroyed'])
export function isAmountlessLiquidityEvent(eventName: string): boolean {
  return AMOUNTLESS_LIQUIDITY_EVENTS.has(eventName)
}

// The only two events a pool account itself is a party to — creation and
// destruction — named explicitly rather than derived from a string suffix, so the
// list cannot silently grow if a future event name happens to match a pattern.
// `pool_account` (JSONExtractString(args_json,'pool') in the MV) is empty on every
// OTHER liquidity_activity row today — Add/Remove/Claim carry no `pool` arg — but
// that is a fact about today's runtime args, not a schema guarantee. Every read
// that admits a viewed account through `pool_account` rather than `who` (see
// liquidityWhoOrPoolSql) confines that arm to this set, so a future runtime that
// starts stamping a `pool` field on XYK.LiquidityAdded/Removed cannot silently
// attribute an ordinary LP's add/remove to the pool account's own feed. This is
// also the intended product boundary: a pool account's page shows its own
// lifecycle markers (Create/Destroy), never every LP's traffic on it.
export const POOL_LIFECYCLE_EVENTS: ReadonlySet<string> = new Set(['XYK.PoolCreated', 'XYK.PoolDestroyed'])

export function liquidityAmountFromArgs(eventName: string, args: Record<string, unknown>): string {
  const arg = LIQUIDITY_AMOUNT_ARG[eventName]
  return arg ? argStr(args, arg) : ''
}

// The who/asset/amount a liquidity candidate displays, decided from the event args
// alone. Shared by the in-memory builders (extrinsic page, block hook section) and
// mirrored by liquidity_activity_mv's expressions, so the two layers cannot extract
// a row differently. A liquidity event names its account `who` (or `owner`) plus
// one of rewardCurrency/assetId/poolId/assetA (or the legacy snake_case
// `asset_id`, which the MV carries too).
export function liquidityCandidateArgs(eventName: string, args: Record<string, unknown>): {
  who: string; asset_id: number; asset_b: number; pool_acc: string; amount: string
} {
  return {
    who: argStr(args, 'who') || argStr(args, 'owner'),
    asset_id: Number(args.rewardCurrency ?? args.assetId ?? args.poolId ?? args.assetA ?? args.asset ?? args.asset_id ?? 0),
    asset_b: Number(args.assetB ?? 0),
    pool_acc: argStr(args, 'pool'),
    amount: liquidityAmountFromArgs(eventName, args),
  }
}

// Enrich Create-pool activity rows with BOTH seed legs (the same-extrinsic
// transfers into the new pool account), so feeds show "A x + B y" like the
// extrinsic page — not just the first asset. Rows whose legs can't be found
// keep their single-leg display.
async function enrichPoolCreations(cands: { row: ActivityRow; pool: string; assetB: number }[]): Promise<void> {
  const usable = cands.filter(c => c.row.extrinsicIndex != null && c.pool && c.assetB >= 0)   // assetB 0 = BSX
  if (!usable.length) return
  const tuples = [...new Set(usable.map(c => `(${c.row.blockHeight},${c.row.extrinsicIndex})`))].join(',')
  const res = await client.query({
    query: `SELECT block_height, extrinsic_index,
              if(event_name = 'Balances.Transfer', 0, JSONExtractInt(args_json,'currencyId')) AS asset_id,
              JSONExtractString(args_json,'to') AS to_acc,
              JSONExtractString(args_json,'amount') AS amount
            FROM price_data.raw_events
            WHERE (block_height, extrinsic_index) IN (${tuples})
              AND event_name IN ('Balances.Transfer','Tokens.Transfer','Currencies.Transferred')`,
    format: 'JSONEachRow',
  })
  const legByKey = new Map<string, string>()
  for (const t of await res.json<{ block_height: number; extrinsic_index: number; asset_id: number; to_acc: string; amount: string }>()) {
    if (t.amount) legByKey.set(`${t.block_height}:${t.extrinsic_index}:${t.asset_id}:${t.to_acc.toLowerCase()}`, t.amount)
  }
  // Combined value at block time. Pool creation is a two-leg action, so an
  // incomplete leg or price leaves the value unknown instead of showing a
  // plausible-looking partial/current value.
  for (const c of cands) c.row.valueUsd = null
  const closes = await historicalCloses(usable.flatMap(c => c.row.asset
    ? [{ assetId: c.row.asset.assetId, ts: c.row.timestamp }, { assetId: c.assetB, ts: c.row.timestamp }]
    : []))
  for (const c of usable) {
    const a = c.row.asset
    if (!a) continue
    const aB = asset(c.assetB)
    const key = (assetId: number) => `${c.row.blockHeight}:${c.row.extrinsicIndex}:${assetId}:${c.pool.toLowerCase()}`
    const amountA = legByKey.get(key(a.assetId)) ?? c.row.amount
    const amountB = legByKey.get(key(c.assetB))
    c.row.assetIn = a
    c.row.assetOut = aB
    c.row.amountIn = amountA
    c.row.amountOut = amountB ?? null
    c.row.amount = amountA
    const closeA = closes.get(historicalPriceKey(a.assetId, c.row.timestamp))
    const closeB = closes.get(historicalPriceKey(aB.assetId, c.row.timestamp))
    const legs = [
      exactUsdLeg(amountA, a.decimals, closeA),
      exactUsdLeg(amountB, aB.decimals, closeB),
    ]
    if (legs.every((leg): leg is ExactUsdLeg => leg != null)) {
      exactHistoricalValues.set(c.row, legs)
      c.row.valueUsd = legs.reduce((sum, leg) => sum + Number(leg.raw) / 10 ** leg.decimals * Number(leg.closeRaw), 0)
    }
  }
}

function transferAssetIdSql(args = 'args_json'): string {
  return `if(event_name = 'Balances.Transfer', 0, ${currencyIdSql(args)})`
}
// Liquidity events reference assets in several shapes: Omnipool `assetId`, XYK
// `assetA`+`assetB`, Stableswap `poolId` + a nested `assets:[{assetId,…}]` array.
// Match the selected ids against ALL of them — a single-field check misses XYK's
// second leg and every Stableswap underlying (e.g. HOLLAR sits in that array).
function liquidityAssetMatchExpr(idsCsv: string, args = 'args_json'): string {
  return `(JSONExtractInt(${args},'assetId') IN (${idsCsv})
    OR JSONExtractInt(${args},'assetA') IN (${idsCsv})
    OR JSONExtractInt(${args},'assetB') IN (${idsCsv})
    OR JSONExtractInt(${args},'poolId') IN (${idsCsv})
    OR hasAny(arrayMap(e -> JSONExtractInt(e,'assetId'), JSONExtractArrayRaw(${args},'assets')), [${idsCsv}]))`
}
const UINT256_MAX = (1n << 256n) - 1n

function decimalFraction(value: string | number): { numerator: bigint; denominator: bigint } {
  const input = String(value).trim()
  const match = /^\+?(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(input)
  if (!match) throw new Error(`Invalid non-negative decimal: ${input}`)
  const fraction = match[2] ?? ''
  const exponent = Number(match[3] ?? 0)
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 400) throw new Error(`Decimal exponent out of range: ${input}`)
  let numerator = BigInt(`${match[1]}${fraction}`)
  const scale = fraction.length - exponent
  if (scale <= 0) {
    numerator *= 10n ** BigInt(-scale)
    return { numerator, denominator: 1n }
  }
  return { numerator, denominator: 10n ** BigInt(scale) }
}

/** Smallest raw-unit integer whose value is at least the requested threshold. */
export function minimumRawAmountForValue(minValue: string | number, unitValue: string | number, decimals: number): bigint | null {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new RangeError('decimals must be an integer from 0 to 255')
  const min = decimalFraction(minValue)
  const unit = decimalFraction(unitValue)
  if (unit.numerator === 0n) return null
  if (min.numerator === 0n) return 0n
  const numerator = min.numerator * unit.denominator * 10n ** BigInt(decimals)
  const denominator = min.denominator * unit.numerator
  return (numerator + denominator - 1n) / denominator
}

export interface RawValueThreshold { assetId: number; amount: string }

function valueThresholds(prices: Map<number, PriceInfo>, minValue: number, unit: 'usd' | 'token'): RawValueThreshold[] {
  const thresholds: RawValueThreshold[] = []
  for (const a of allExplorerAssets()) {
    const price = prices.get(a.assetId)
    const unitValue = unit === 'token' ? '1' : price?.priceRaw ?? (price && price.price > 0 ? String(price.price) : '0')
    const amount = minimumRawAmountForValue(minValue, unitValue, a.decimals)
    if (amount != null && amount <= UINT256_MAX) thresholds.push({ assetId: a.assetId, amount: amount.toString() })
  }
  return thresholds
}

export function exactValuePredicateSql(
  assetExpr: string,
  rawAmountExpr: string,
  thresholds: RawValueThreshold[],
  options: { amountIsUInt256?: boolean; hasAmountExpr?: string } = {},
): string {
  if (!thresholds.length) return '0'
  const ids = thresholds.map(t => t.assetId).join(',')
  const amounts = thresholds.map(t => `'${t.amount}'`).join(',')
  const asset = `toUInt32(${assetExpr})`
  const amount = options.amountIsUInt256 ? `toUInt256(${rawAmountExpr})` : `toUInt256OrZero(${rawAmountExpr})`
  const hasAmount = options.hasAmountExpr ?? `notEmpty(toString(${rawAmountExpr}))`
  return `(${hasAmount} AND ${asset} IN (${ids}) AND ${amount} >= toUInt256(transform(${asset}, [${ids}], [${amounts}], '0')))`
}

const HISTORICAL_PRICE_SCALE = 1_000_000_000_000n

interface HistoricalRawValueThreshold { assetId: number; numerator: string }

function historicalValueThresholds(minValue: number): { thresholds: HistoricalRawValueThreshold[]; denominator: string } {
  const min = decimalFraction(minValue)
  const thresholds: HistoricalRawValueThreshold[] = []
  for (const a of allExplorerAssets()) {
    const numerator = min.numerator * HISTORICAL_PRICE_SCALE * 10n ** BigInt(a.decimals)
    if (numerator <= UINT256_MAX) thresholds.push({ assetId: a.assetId, numerator: numerator.toString() })
  }
  return { thresholds, denominator: min.denominator.toString() }
}

/** Exact UInt256 comparison against a row's Decimal128(12) historical close. */
export function exactHistoricalValuePredicateSql(
  assetExpr: string,
  rawAmountExpr: string,
  closeExpr: string,
  thresholds: HistoricalRawValueThreshold[],
  minDenominator: string,
  options: { amountIsUInt256?: boolean; hasAmountExpr?: string } = {},
): string {
  if (!thresholds.length) return '0'
  const ids = thresholds.map(t => t.assetId).join(',')
  const denominatorValue = BigInt(minDenominator)
  const calculable = thresholds.filter(t => denominatorValue <= BigInt(t.numerator))
  const oneRawUnit = thresholds.filter(t => BigInt(t.numerator) > 0n && denominatorValue > BigInt(t.numerator))
  const zeroThreshold = thresholds.filter(t => BigInt(t.numerator) === 0n)
  const asset = `toUInt32(${assetExpr})`
  const amount = options.amountIsUInt256 ? `toUInt256(${rawAmountExpr})` : `toUInt256OrZero(${rawAmountExpr})`
  const hasAmount = options.hasAmountExpr ?? `notEmpty(toString(${rawAmountExpr}))`
  const priceAtoms = `toUInt256(${closeExpr} * toDecimal128('1000000000000', 0))`
  const branches: string[] = []
  if (zeroThreshold.length) branches.push(`(${asset} IN (${zeroThreshold.map(t => t.assetId).join(',')}) AND ${amount} >= toUInt256(0))`)
  if (oneRawUnit.length) branches.push(`(${asset} IN (${oneRawUnit.map(t => t.assetId).join(',')}) AND ${amount} >= toUInt256(1))`)
  if (calculable.length) {
    const calcIds = calculable.map(t => t.assetId).join(',')
    const numerators = calculable.map(t => `'${t.numerator}'`).join(',')
    const numerator = `toUInt256(transform(${asset}, [${calcIds}], [${numerators}], '0'))`
    const denominator = `toUInt256('${minDenominator}')`
    const quotient = `intDivOrZero(${numerator}, ${denominator})`
    const remainder = `moduloOrZero(${numerator}, ${denominator})`
    const threshold = `(intDivOrZero(${quotient}, ${priceAtoms}) + toUInt256(${remainder} != 0 OR moduloOrZero(${quotient}, ${priceAtoms}) != 0))`
    branches.push(`(${asset} IN (${calcIds}) AND ${amount} >= ${threshold})`)
  }
  return `(${hasAmount} AND ${asset} IN (${ids}) AND ${closeExpr} > 0 AND ${priceAtoms} > 0 AND (${branches.join(' OR ') || '0'}))`
}

function historicalClosesRelationSql(): string {
  const priceIds = [...new Set(allExplorerAssets().map(a => a.assetId))].join(',')
  // Hash ASOF requires a left/right equi-key even when the valued asset is a
  // constant (BSX votes and referral claims). The timestamp-derived key below
  // is 1 for every non-null event timestamp and leaves the price match unchanged.
  return `(SELECT asset_id, interval_start + INTERVAL 1 HOUR AS price_time, argMaxMerge(close_state) AS close,
                  toUInt8(1) AS asof_join_key
           FROM price_data.ohlc_1h
           WHERE asset_id IN (${priceIds || '0'})
           GROUP BY asset_id, interval_start)`
}

export interface EventValueFilterSql { joinSql: string; predicateSql: string }

export function eventValueFilterSql(
  assetExpr: string,
  rawAmountExpr: string,
  timestampExpr: string,
  filters: ValueListFilters | undefined,
  prices: Map<number, PriceInfo>,
  alias: string,
  options: { amountIsUInt256?: boolean; hasAmountExpr?: string } = {},
): EventValueFilterSql {
  if (filters?.min == null) return { joinSql: '', predicateSql: '' }
  if (filters.unit === 'token') {
    const thresholds = valueThresholds(prices, filters.min, 'token')
    return { joinSql: '', predicateSql: `AND ${exactValuePredicateSql(assetExpr, rawAmountExpr, thresholds, options)}` }
  }
  const { thresholds, denominator } = historicalValueThresholds(filters.min)
  return {
    joinSql: `ASOF LEFT JOIN ${historicalClosesRelationSql()} ${alias}
              ON ${alias}.asof_join_key = toUInt8(isNotNull(${timestampExpr}))
             AND ${alias}.asset_id = toUInt32(${assetExpr})
             AND ${alias}.price_time <= ${timestampExpr}`,
    predicateSql: `AND ${exactHistoricalValuePredicateSql(assetExpr, rawAmountExpr, `${alias}.close`, thresholds, denominator, options)}`,
  }
}

// USD price map
// Latest + 24h-ago USD price per asset from the bounded recent window (avoids a
// full scan of the 485M-row prices table). Cached 30s in memory.

// The assets that carry a USD price at all. Mirrors the indexer's write
// whitelist (`config.PRICED_ASSET_IDS` in src/config.ts): KSM (1) is anchored to
// the off-chain KSM/USD reference and BSX (0) is derived from it through the
// BSX/KSM XYK pool, and nothing else is priced anywhere. `price_data.prices`
// therefore holds rows for these two ids only — the list exists so the read path
// stops asking about a coverage that does not exist, not as a second filter.
const PRICED_ASSET_IDS = [0, 1]

export interface PriceInfo { price: number; change24h: number; priceRaw?: string }
let priceMap = new Map<number, PriceInfo>()
let priceLoadedAt = 0
let priceRefreshInflight: Promise<Map<number, PriceInfo>> | null = null
// Account directory/detail values share one pinned price generation. It advances
// atomically with the five-minute MM account-value generation, preventing two
// adjacent page requests from straddling the general 30-second price refresh.
let accountValuePriceMap = new Map<number, PriceInfo>()
let accountValueGenerationEpoch = 0

// `prices` contains one row per asset per block, so asking it for max(block_height)
// scans the entire table. The much smaller `blocks` table advances atomically with
// the price rows and provides the same head for bounded price reads.
async function latestPriceBlock(): Promise<number> {
  return cached('explorer:price-head', 5_000, async () => {
    const res = await client.query({
      query: `SELECT max(block_height) AS head FROM price_data.blocks`,
      format: 'JSONEachRow',
    })
    return Number((await res.json<{ head: number | null }>())[0]?.head ?? 0)
  })
}

// The newest FULLY ingested raw block: the live pipeline's checkpoint, which is
// written only after every table of a block has flushed (raw_blocks lands
// first, so max(raw_blocks) would race the block's own events). This is the
// freshness generation for every live feed cache — cached briefly so detecting
// a new block costs one trivial read per ~1.5s across all feeds combined.
//
// The SSE broadcaster publishes each head it is about to push as a floor, so a
// refetch racing the push can never build against this probe's older cached
// value — the pushed head is servable before any client hears about it.
let pushedRawHead = 0
export function publishIndexedRawHead(head: number): void {
  if (head > pushedRawHead) pushedRawHead = head
}
async function indexedRawHead(): Promise<number> {
  const probed = await cached('explorer:raw-head', 1_500, async () => {
    const res = await client.query({
      query: `SELECT max(last_block) AS head FROM price_data.raw_ingestion_state`,
      format: 'JSONEachRow',
    })
    return Number((await res.json<{ head: number | null }>())[0]?.head ?? 0)
  })
  return Math.max(probed, pushedRawHead)
}

// Cache-key tag for a feed page: live pages carry the ingested head, so a page
// is reused only until the next block lands — freshness by construction, with
// executions bounded at one per (variant, block). Time-windowed pages don't
// shift with the head and keep a stable tag.
export function headCacheTag(head: number | null): string {
  return head == null ? 'tw' : `h${head}`
}
// A dated window earns the head-less tag only once it can no longer gain rows.
// `to` naming a day that has already ended is the whole condition: a window that
// reaches today keeps growing as blocks arrive, so under a constant tag its page
// freezes for the cache's full TTL and every row that lands meanwhile is
// invisible. Readers that only move forward — the notification evaluator's
// per-kind cursor — step past those rows and never look again, which is a silent
// permanent loss rather than a stale render. Dates are compared as UTC day
// strings, matching `timeWindow`'s literals and ClickHouse's own timezone.
const utcToday = (): string => new Date().toISOString().slice(0, 10)
export function datedWindowIsClosed(to?: string, today: string = utcToday()): boolean {
  return !!to && DATE_RE.test(to) && to < today
}
async function liveHeadTag(timeWindowed = false, closed = false): Promise<string> {
  return headCacheTag(timeWindowed && closed ? null : await indexedRawHead())
}
// "24h"/"7d"-style windows were historically fixed block-count offsets that
// assumed a constant block time (12s, later 6s), so `head - 7200` was taken to
// mean "24h ago". A Basilisk block is 2s today and has been each of those other
// two, so those offsets cover far LESS wall-clock than their names imply and
// would shift again at the next change. These helpers
// resolve a cutoff HEIGHT from a wall-clock window via the blocks table,
// keeping the reading queries height-predicated — so the
// (asset_id, block_height) / block_height sort keys still prune the scan —
// while the window means an actual span of time.

// SQL returning the lowest block_height produced within the last `hours`
// (NULL / 0 rows when the table is empty). Kept pure so a unit test can assert
// the INTERVAL literal without a live ClickHouse.
export function cutoffWindowSql(hours: number): string {
  return `SELECT min(block_height) AS h FROM price_data.blocks WHERE block_timestamp >= now() - INTERVAL ${Math.max(1, Math.round(hours))} HOUR`
}

// Fallback cutoff when the blocks table can't answer (empty/error). Callers
// pass the MEASURED blocks per hour when they have one, so the estimate tracks
// real production through the 2s migration; the default is the nominal 600/hour
// (6s blocks), which reproduces the exact pre-fix constant (24h → head − 14400,
// 7d → head − 100800) and remains the final fallback when nothing can be
// measured either.
export function fallbackCutoffHeight(head: number, hours: number, perHour: number = NOMINAL_BLOCKS_PER_HOUR): number {
  // A non-positive rate is a broken measurement, not "zero blocks an hour": fall
  // back to the nominal so the window keeps its meaning instead of collapsing to
  // the head (which would silently return an empty 24h).
  const rate = Number.isFinite(perHour) && perHour > 0 ? perHour : NOMINAL_BLOCKS_PER_HOUR
  return Math.max(0, head - Math.round(hours * rate))
}

// Resolve the block height that was the chain head `hours` ago. Cached briefly:
// it advances slowly relative to a 24h/7d window and is read on hot paths, and a
// timer-driven refresher should resolve it once per pass rather than per asset.
export async function cutoffHeightForWindow(hours: number, head: number): Promise<number> {
  return cached(`explorer:cutoff:${hours}`, 30_000, async () => {
    try {
      const res = await client.query({ query: cutoffWindowSql(hours), format: 'JSONEachRow' })
      const h = Number((await res.json<{ h: number | null }>())[0]?.h ?? 0)
      if (h > 0) return h
    } catch { /* fall through to the measured-pace estimate */ }
    // measuredParaBlockMs swallows its own failures and returns the nominal, so
    // this degrades to 600 blocks/hour rather than throwing on a dead database.
    return fallbackCutoffHeight(head, hours, blocksPerHour(await measuredParaBlockMs(client)))
  })
}

export async function ensurePrices(): Promise<Map<number, PriceInfo>> {
  if (priceMap.size && Date.now() - priceLoadedAt < 30_000) return priceMap
  // Single-flight: ensurePrices is on the hot path of nearly every endpoint, so
  // when the TTL lapses under load, concurrent requests share one in-flight
  // refresh rather than each firing its own and stampeding ClickHouse. The
  // stale map is served meanwhile (only a cold start ever waits).
  priceRefreshInflight ??= refreshPrices().finally(() => { priceRefreshInflight = null })
  return priceMap.size ? priceMap : priceRefreshInflight
}

async function loadFreshPrices(): Promise<Map<number, PriceInfo>> {
  priceRefreshInflight ??= refreshPrices().finally(() => { priceRefreshInflight = null })
  return priceRefreshInflight
}

async function ensureAccountValuePrices(): Promise<Map<number, PriceInfo>> {
  if (!accountValuePriceMap.size) accountValuePriceMap = new Map(await loadFreshPrices())
  return accountValuePriceMap
}
async function refreshPrices(): Promise<Map<number, PriceInfo>> {
  try {
    const head = await latestPriceBlock()
    if (!head) return priceMap
    // Timestamp-derived cutoffs so "24h"/"7d" track wall-clock as block time
    // moves (~6s today, 2s planned; measured where it matters). Resolved once
    // per refresh, not per asset.
    const [dayStart, weekStart, cut72] = await Promise.all([
      cutoffHeightForWindow(24, head),
      cutoffHeightForWindow(168, head),
      cutoffHeightForWindow(72, head),
    ])
    // The fallback "price then" window is a block SPAN relative to each asset's
    // own latest tick (the ~24h→72h band before it), so express both edges as
    // the real block count spanning those windows at the current rate.
    const span24h = Math.max(1, head - dayStart)
    const span72h = Math.max(1, head - cut72)
    const res = await client.query({
      query: `
        SELECT asset_id,
          toString(argMax(usd_price, block_height)) AS price_raw,
          toString(argMin(usd_price, block_height)) AS price_then_raw
        FROM price_data.prices
        WHERE block_height > {dayStart:UInt32} AND usd_price > 0
        GROUP BY asset_id`,
      query_params: { dayStart },
      format: 'JSONEachRow',
    })
    const rows = await res.json<{ asset_id: number; price_raw: string; price_then_raw: string }>()
    const m = new Map<number, PriceInfo>()
    for (const r of rows) {
      const price = Number(r.price_raw)
      const priceThen = Number(r.price_then_raw)
      const change = priceThen > 0 ? (price - priceThen) / priceThen : 0
      if (Number.isFinite(price) && price > 0) m.set(r.asset_id, { price, priceRaw: r.price_raw, change24h: change })
    }
    // A priced asset's latest tick can sit outside the narrow live-price window
    // above — BSX only ticks when the BSX/KSM pool moves or the daily KSM anchor
    // steps, so a quiet stretch leaves the 24h window empty. Fill those from a
    // bounded 7d window, computing the change against roughly 24h before that
    // asset's own latest tick.
    //
    // Bounded by the priced ids rather than the whole registry: every other asset
    // is unpriced by design, so asking for its price feed would query for rows
    // that cannot exist on every refresh.
    const missing = PRICED_ASSET_IDS.filter(id => !m.has(id))
    if (missing.length) {
      // Both scan legs are bounded by (asset_id IN …, block_height > head − 7d),
      // allowing the (asset_id, block_height) primary key to prune the scan.
      const fbRes = await client.query({
        query: `
          WITH latest AS (
            SELECT asset_id, max(block_height) AS latest_block,
              argMax(usd_price, block_height) AS price
            FROM price_data.prices
            WHERE block_height > {weekStart:UInt32}
              AND usd_price > 0 AND asset_id IN ({ids:Array(UInt32)})
            GROUP BY asset_id
          )
          SELECT p.asset_id AS asset_id, any(l.latest_block) AS latest_block,
            toString(any(l.price)) AS price_raw,
            toString(argMaxIf(p.usd_price, p.block_height,
              p.block_height <= l.latest_block - {span24h:UInt32} AND p.block_height > l.latest_block - {span72h:UInt32})) AS price_then_raw
          FROM price_data.prices p
          INNER JOIN latest l ON l.asset_id = p.asset_id
          WHERE p.asset_id IN ({ids:Array(UInt32)}) AND p.block_height > {weekStart:UInt32} AND p.usd_price > 0
          GROUP BY p.asset_id`,
        query_params: { ids: missing, weekStart, span24h, span72h }, format: 'JSONEachRow',
      })
      for (const r of await fbRes.json<{ asset_id: number; price_raw: string; price_then_raw: string }>()) {
        const price = Number(r.price_raw)
        const priceThen = Number(r.price_then_raw)
        const change = priceThen > 0 ? (price - priceThen) / priceThen : 0
        if (Number.isFinite(price) && price > 0) m.set(r.asset_id, { price, priceRaw: r.price_raw, change24h: change })
      }
    }
    priceMap = m
    priceLoadedAt = Date.now()
  } catch { /* serve stale on error */ }
  return priceMap
}
export function usdValue(prices: Map<number, PriceInfo>, assetId: number, raw: string, decimals: number): number | null {
  const p = prices.get(assetId)
  if (!p) return null
  const amt = Number(raw) / 10 ** decimals
  return Number.isFinite(amt) ? amt * p.price : null
}
// A liquidity row's amount/value must not survive on the wire as '' / 0 for an event
// that is amountless BY CONSTRUCTION (see AMOUNTLESS_LIQUIDITY_EVENTS): Number('') is
// 0, so usdValue(prices, assetId, '', decimals) returns 0 * price — not null — the
// moment a price for the asset exists. Other liquidity events legitimately carry ''
// only until fillMissingLiquidityAmounts/enrichPoolCreations backfills it, so this
// guard belongs at each row's construction, not inside usdValue itself.
export function liquidityRowAmount(eventName: string, prices: Map<number, PriceInfo>, assetId: number, raw: string, decimals: number): { amount: string | null; valueUsd: number | null } {
  if (isAmountlessLiquidityEvent(eventName)) return { amount: null, valueUsd: null }
  return { amount: raw, valueUsd: usdValue(prices, assetId, raw, decimals) }
}
function priceTransformArrays(prices: Map<number, PriceInfo>): { idsSql: string; unitsSql: string } {
  const ids: string[] = []
  const units: string[] = []
  for (const a of allExplorerAssets()) {
    const p = prices.get(a.assetId)
    if (p && p.price > 0) {
      ids.push(`'${a.assetId}'`)
      units.push((p.price / 10 ** a.decimals).toExponential())
    }
  }
  return {
    idsSql: ids.length ? '[' + ids.join(',') + ']' : "['']",
    unitsSql: units.length ? '[' + units.join(',') + ']' : '[0.]',
  }
}

// historical (block-time) valuation
// A flow (trade, transfer, liquidation) is worth what it was worth WHEN it
// happened, so we value its raw amount at the latest completed hourly close,
// never the current price or a close later in the event's hour. The per-block
// price table (price_data.prices)
// would be exact, but an ASOF join against it loads every price tick in the
// events' block span — and majors tick every block, so a whale trading across
// the whole chain would pull tens of millions of rows. The pre-aggregated
// hourly close is one row per asset/hour, so the joined side stays bounded.

// Every asset values through its own feed, on both the current and the historical
// path: Basilisk registers no receipt or wrapper token that borrows another asset's
// price (see explorerAssets). The ASOF match below therefore keys straight on the
// leg's own asset id, and the pushed-down min-value predicate and the TypeScript row
// value read the same feed by construction.

function rawAmountNormalizationSql(expr: string, targetDecimals: number): string {
  const assets = allExplorerAssets().filter(a => a.decimals <= targetDecimals)
  const ids = assets.map(a => a.assetId)
  const factors = assets.map(a => `'${10n ** BigInt(targetDecimals - a.decimals)}'`)
  const fallback = 10n ** BigInt(targetDecimals - 12)
  return `toDecimal256(transform(toUInt32(${expr}), [${ids.join(',') || '0'}], [${factors.join(',') || "'1'"}], '${fallback}'), 0)`
}

// SQL fragment valuing a CTE of event legs at their block-time price, emitted as
// the CTE `${outName}` (account_id, volume_usd). `legsCte` must expose
// (account_id, asset_id, block_time, amount) rows — block_time is the event's
// wall-clock time, ASOF-matched to the last completed hourly close.
//
// The ASOF right side is bounded twice. The static priced-asset universe is the
// outer bound; inside it, only the price feeds the legs actually reference can
// ever match `p.asset_id = <alias(l.asset_id)>`, so the feed set is narrowed to
// the legs' own distinct price ids. `ohlc_1h` holds ~76 feeds interleaved inside
// every granule, so this prunes no marks — it stops `argMaxMerge` from merging
// ~1.0M aggregate states down to the ~0.2M the legs can match, which is where
// the CPU and the join's peak memory went (measured on the unfiltered
// `sort=liquidation` directory shape: 1.26 → 0.36 CPU-s, 245 → 89 MiB peak).
//
// It costs a second reference to `legsCte`, so the caller's legs relation must
// be cheap to read twice (the liquidation legs are a bounded account-first
// projection read).
export function historicalVolumeSql(legsCte: string, outName: string): string {
  const priceIds = [...new Set(allExplorerAssets().map(a => a.assetId))].join(',')
  const maxDecimals = Math.max(12, ...allExplorerAssets().map(a => a.decimals))
  if (maxDecimals > 65) throw new Error(`Historical volume does not support asset decimals above 65 (found ${maxDecimals})`)
  // Decimal256 is ClickHouse's widest overflow-checking fixed-point type. An
  // unrepresentable leg fails the query explicitly; it must never wrap or be
  // coerced to zero in an account ranking.
  const normalizedAmount = `multiplyDecimal(toDecimal256(l.amount, 0), ${rawAmountNormalizationSql('l.asset_id', maxDecimals)}, 0)`
  const exactValue = `multiplyDecimal(${normalizedAmount}, toDecimal256(p.close, 12), 12)`
  return `
            ${outName} AS (
              SELECT l.account_id AS account_id,
                     toFloat64(sum(${exactValue})) / 1e${maxDecimals} AS volume_usd
              FROM ${legsCte} l
              ASOF LEFT JOIN (
                SELECT asset_id, interval_start + INTERVAL 1 HOUR AS price_time, argMaxMerge(close_state) AS close
                FROM price_data.ohlc_1h
                WHERE asset_id IN (${priceIds || '0'})
                  AND asset_id IN (SELECT DISTINCT toUInt32(n.asset_id) FROM ${legsCte} n)
                GROUP BY asset_id, interval_start
              ) p ON p.asset_id = toUInt32(l.asset_id) AND p.price_time <= l.block_time
              WHERE match(l.account_id, '^0x[0-9a-f]{64}$')
                AND NOT match(l.account_id, '^0x(6d6f646c|7369626c|70617261)')
              GROUP BY account_id
            )`
}

// A displayed flow (a past trade/transfer/liquidation amount shown with its USD
// value) should carry the value it had WHEN it happened, not now. Given a list
// of rows that each expose an event timestamp + an asset + a raw amount, this
// batch-fetches the last completed hourly close and rewrites its valueUsd. One
// extra query is issued per page. Rows without a valid historical price get
// null rather than a current-price substitute.
function normalizeTs(ts: string): string {
  return ts.replace('T', ' ').replace('Z', '').replace(/\.\d+$/, '').trim()
}
export function historicalPriceHour(ts: string): string {
  const normalized = normalizeTs(ts)
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(normalized)
    ? `${normalized.slice(0, 13)}:00:00`
    : normalized
}
function historicalPriceKey(assetId: number, ts: string): string {
  return `${assetId}|${normalizeTs(ts)}`
}

// Completed hourly closes are immutable. Candidate walkers repeatedly value
// different events from the same asset/hour; retaining a bounded process cache
// avoids reopening the full aggregate price table for those identical lookups.
const HISTORICAL_CLOSE_CACHE_LIMIT = 50_000
const historicalCloseByHour = new Map<string, string | null>()
function cacheHistoricalClose(key: string, close: string | null): void {
  if (historicalCloseByHour.has(key)) historicalCloseByHour.delete(key)
  historicalCloseByHour.set(key, close)
  while (historicalCloseByHour.size > HISTORICAL_CLOSE_CACHE_LIMIT) {
    const oldest = historicalCloseByHour.keys().next().value as string | undefined
    if (oldest == null) break
    historicalCloseByHour.delete(oldest)
  }
}

async function historicalCloses(pairs: { assetId: number; ts: string }[]): Promise<Map<string, string>> {
  const requested = new Map<string, { priceId: number; hour: string; hourKey: string }>()
  const missingHours = new Map<string, { priceId: number; ts: string }>()
  for (const p of pairs) {
    const priceId = p.assetId
    const ts = normalizeTs(p.ts)
    const hour = historicalPriceHour(ts)
    const hourKey = `${priceId}|${hour}`
    requested.set(`${priceId}|${ts}`, { priceId, hour, hourKey })
    if (!historicalCloseByHour.has(hourKey)) missingHours.set(hourKey, { priceId, ts: hour })
  }
  if (!requested.size) return new Map()
  const out = new Map<string, string>()
  const values = [...missingHours.values()]
  // Candidate widening can value several thousand rows at once. Keep tuple SQL
  // comfortably below ClickHouse's max_query_size. Events in one asset/hour
  // share the same completed close, so the tuple list is hour-deduplicated.
  const closeChunks = await mapChunksConcurrently(values, 2_000, CHUNK_QUERY_CONCURRENCY, async batch => {
    const priceIds = [...new Set(batch.map(p => p.priceId))]
    const tuples = batch.map(p => `(${p.priceId},'${p.ts}')`).join(',')
    const res = await client.query({
      query: `
        SELECT ev.asset_id AS asset_id, ev.ts AS ts, toString(p.close) AS close
        FROM (
          SELECT toUInt32(tupleElement(pr, 1)) AS asset_id, tupleElement(pr, 2) AS ts
          FROM (SELECT arrayJoin([${tuples}]) AS pr)
        ) ev
        ASOF LEFT JOIN (
          SELECT asset_id, interval_start + INTERVAL 1 HOUR AS price_time, argMaxMerge(close_state) AS close
          FROM price_data.ohlc_1h
          WHERE asset_id IN (${priceIds.join(',')})
          GROUP BY asset_id, interval_start
        ) p ON p.asset_id = ev.asset_id AND p.price_time <= toDateTime(ev.ts)`,
      format: 'JSONEachRow',
    })
    return res.json<{ asset_id: number; ts: string; close: string }>()
  })
  // In chunk order: the close cache evicts by insertion order, so which chunk's
  // query finished first must not decide what it keeps.
  for (const rows of closeChunks) {
    for (const r of rows) {
      const key = `${r.asset_id}|${r.ts}`
      cacheHistoricalClose(key, Number(r.close) > 0 ? r.close : null)
    }
  }
  for (const [key, request] of requested) {
    const close = historicalCloseByHour.get(request.hourKey)
    if (close) out.set(key, close)
  }
  return out
}

interface ExactUsdLeg { raw: bigint; decimals: number; priceAtoms: bigint; closeRaw: string }
const exactHistoricalValues = new WeakMap<object, ExactUsdLeg[]>()

function exactUsdLeg(raw: string | null | undefined, decimals: number, closeRaw: string | undefined): ExactUsdLeg | null {
  if (!raw || !/^\d+$/.test(raw) || !closeRaw) return null
  const close = decimalFraction(closeRaw)
  const scaled = close.numerator * HISTORICAL_PRICE_SCALE
  if (scaled % close.denominator !== 0n) return null
  const priceAtoms = scaled / close.denominator
  if (priceAtoms <= 0n) return null
  return { raw: BigInt(raw), decimals, priceAtoms, closeRaw }
}

function exactUsdMeetsMinimum(legs: ExactUsdLeg[], minimum: number): boolean {
  if (!legs.length) return false
  const maxDecimals = Math.max(...legs.map(leg => leg.decimals))
  const valueNumerator = legs.reduce(
    (sum, leg) => sum + leg.raw * leg.priceAtoms * 10n ** BigInt(maxDecimals - leg.decimals),
    0n,
  )
  const valueDenominator = HISTORICAL_PRICE_SCALE * 10n ** BigInt(maxDecimals)
  const threshold = decimalFraction(minimum)
  return valueNumerator * threshold.denominator >= threshold.numerator * valueDenominator
}
// valueUsd basis pickers per row shape: a trade/activity is valued on its OUT leg
// (the asset received), a transfer/liquidity/mm flow on the moved asset.
type HistPick = { assetId: number; decimals: number; raw: string; ts: string } | null
function activityHistPick(r: ActivityRow): HistPick {
  // Create rows already carry their combined BLOCK-TIME value (both seed legs, see
  // enrichPoolCreations); Destroy rows carry no value at all by construction.
  if (r.type === 'liquidity' && (r.liqAction === 'Create' || r.liqAction === 'Destroy')) return null
  if (r.assetOut && r.amountOut != null) return { assetId: r.assetOut.assetId, decimals: r.assetOut.decimals, raw: r.amountOut, ts: r.timestamp }
  if (r.asset && r.amount != null) return { assetId: r.asset.assetId, decimals: r.asset.decimals, raw: r.amount, ts: r.timestamp }
  return null
}
function tradeHistPick(r: TradeRow): HistPick {
  return { assetId: r.assetOut.assetId, decimals: r.assetOut.decimals, raw: r.amountOut, ts: r.timestamp }
}
function transferHistPick(r: TransferRow): HistPick {
  return { assetId: r.asset.assetId, decimals: r.asset.decimals, raw: r.amount, ts: r.timestamp }
}
// Rewrite each row's valueUsd to its block-time value. `pick` returns the asset
// + raw amount that valueUsd represents (the OUT leg of a trade, the moved asset
// of a transfer, …) and the row's timestamp, or null to leave the row untouched.
async function applyHistoricalUsd<T>(rows: T[], pick: (r: T) => { assetId: number; decimals: number; raw: string; ts: string } | null): Promise<void> {
  const picks = rows.map(pick)
  const pairs = picks.filter((p): p is NonNullable<typeof p> => p != null).map(p => ({ assetId: p.assetId, ts: p.ts }))
  if (!pairs.length) return
  const closes = await historicalCloses(pairs)
  rows.forEach((r, i) => {
    const p = picks[i]
    if (!p) return
    const close = closes.get(historicalPriceKey(p.assetId, p.ts))
    const leg = exactUsdLeg(p.raw, p.decimals, close)
    if (typeof r === 'object' && r != null) {
      if (leg) exactHistoricalValues.set(r, [leg])
      else exactHistoricalValues.delete(r)
    }
    const amt = Number(p.raw) / 10 ** p.decimals
    ;(r as { valueUsd: number | null }).valueUsd = leg != null && Number.isFinite(amt) ? amt * Number(leg.closeRaw) : null
  })
}

function rowMeetsExactUsdMinimum(row: object & { valueUsd: number | null }, minimum: number): boolean {
  const exact = exactHistoricalValues.get(row)
  if (exact) return exactUsdMeetsMinimum(exact, minimum)
  return row.valueUsd != null && Number.isFinite(row.valueUsd) && row.valueUsd >= minimum
}

// overview
export interface ExplorerStats {
  headBlock: number
  finalizedBlock: number
  headTime: string
  // The chain's MEASURED pace, for "how fast is it going" and for extrapolating
  // a live block delta into a countdown.
  avgBlockSec: number
  // The runtime's NOMINAL slot time (blockTime.ts: read from runtime metadata,
  // inferred from indexed blocks only when the node is unreachable): 6 today, 2
  // after the planned upgrade. Every runtime block-count constant is derived
  // from it, so this — never avgBlockSec — is what turns one of those counts
  // into a duration.
  //
  // The two are sampled independently and cached on different clocks (a
  // 100-block average per request-ish, a slot time per 5 minutes), so they are
  // NOT two views of one reading and will not agree exactly. That is the point:
  // avgBlockSec is meant to move and nominalBlockSec is meant not to.
  nominalBlockSec: number
  transfers24h: number
  extrinsics24h: number
  activeAccounts24h: number
}

interface ExplorerStatsCounts {
  transfers24h: number
  extrinsics24h: number
  activeAccounts24h: number
}

// These are 24-hour summary numbers, not the live head. Recomputing all three
// uniqExact scans on every head made total work scale with BOTH rows per window
// and blocks per day: 3x throughput became ~9x query load. A 30-second shared
// hold is <0.04% of the window it summarizes while reducing the heavy read to a
// fixed 2,880/day at any block cadence. The head/average/countdowns below remain
// head-keyed and update every block.
export const STATS_COUNTS_CACHE_MS = 30_000
export const STATS_COUNTS_SQL = `
  SELECT
    toUInt64((SELECT uniqExact((block_height, event_index)) FROM price_data.raw_events
      WHERE block_height > {cutoff24h:UInt32} AND event_name IN ('Balances.Transfer','Tokens.Transfer'))) AS transfers_24h,
    toUInt64((SELECT uniqExact((block_height, extrinsic_index)) FROM price_data.raw_extrinsics
      WHERE block_height > {cutoff24h:UInt32} AND coalesce(signer, effective_signer) IS NOT NULL)) AS extrinsics_24h,
    toUInt64((SELECT uniqExact(account_id) FROM price_data.raw_balance_observations
      WHERE block_height > {cutoff24h:UInt32})) AS active_accounts_24h`

async function getStatsCounts(cutoff24h: number): Promise<ExplorerStatsCounts> {
  return cached('explorer:stats:counts-24h', STATS_COUNTS_CACHE_MS, async () => {
    const res = await client.query({
      query: STATS_COUNTS_SQL,
      query_params: { cutoff24h },
      format: 'JSONEachRow',
    })
    const row = (await res.json<{ transfers_24h: string; extrinsics_24h: string; active_accounts_24h: string }>())[0]
    return {
      transfers24h: Number(row?.transfers_24h ?? 0),
      extrinsics24h: Number(row?.extrinsics_24h ?? 0),
      activeAccounts24h: Number(row?.active_accounts_24h ?? 0),
    }
  })
}

export async function getStats(): Promise<ExplorerStats> {
  // Head-keyed: a new entry exists per ingested block, so the first poll after
  // a block landed refreshes the cheap head sample and every other poll hits the
  // cache — the head shown is never a TTL behind the data. The three 24h counts
  // have their own 30s hold above, so a faster chain cannot multiply their scan
  // frequency. This TTL is garbage collection, not head freshness.
  return cached(`explorer:stats:${await liveHeadTag()}`, 30_000, async () => {
    // Wall-clock 24h cutoff height, measured from the blocks table — a fixed
    // head−7200 offset assumed 12s blocks and covers ~11h at today's ~6s (and
    // would cover ~4h at the planned 2s). The counts read replayable
    // ReplacingMergeTree raw tables, so they dedup by row identity: a replay
    // before the next merge would otherwise double-count events/extrinsics.
    const cutoff24h = await cutoffHeightForWindow(24, await latestPriceBlock())
    const [mainRes, nominalBlockMs, counts] = await Promise.all([
      client.query({
        query: `
          WITH (SELECT max(block_height) FROM price_data.raw_blocks) AS head
          SELECT
            toUInt64(head) AS head_block,
            (SELECT toString(max(block_timestamp)) FROM price_data.raw_blocks WHERE block_height = head) AS head_time,
            -- The displayed average block time. Same measurement as
            -- blockTime.ts's avgBlockMsSql (in seconds, not ms) but folded into
            -- this query so the Live header costs one read rather than two; the
            -- helper is the one behaviour depends on, this one is only shown.
            (SELECT toFloat64(dateDiff('second', min(block_timestamp), max(block_timestamp)) / greatest(count() - 1, 1))
               FROM (SELECT block_timestamp FROM price_data.blocks ORDER BY block_height DESC LIMIT 100)) AS avg_block
        `,
        format: 'JSONEachRow',
      }),
      // The runtime's slot time beside the measured pace. A UI turning a
      // runtime block-count constant (a fuse period, a lock duration — all
      // derived from MILLISECS_PER_BLOCK) into a duration needs THIS number,
      // not the elastic-scaling pace: at 5.7s measured, the pallet's 14 400-block
      // day would otherwise read 22.8h. Snapped to the ladder and cached 5min,
      // so it is a step function that moves once, at the runtime upgrade.
      paraBlockMs(client),
      getStatsCounts(cutoff24h),
    ])
    const row = (await mainRes.json<{ head_block: string; head_time: string; avg_block: number }>())[0]
    const head = Number(row?.head_block ?? 0)
    return {
      headBlock: head,
      finalizedBlock: head,
      headTime: row?.head_time ?? '',
      avgBlockSec: Number(row?.avg_block ?? 0),
      nominalBlockSec: nominalBlockMs / 1000,
      transfers24h: counts.transfers24h,
      extrinsics24h: counts.extrinsics24h,
      activeAccounts24h: counts.activeAccounts24h,
    }
  })
}

// recent blocks
export interface BlockSummary {
  height: number
  timestamp: string
  hash: string
  author: AccountRef | null
  specVersion: number
  extrinsicCount: number
  eventCount: number
}

export async function getRecentBlocks(limit: number, offset = 0): Promise<BlockSummary[]> {
  return cached(`explorer:blocks:${await liveHeadTag()}:${limit}:${offset}`, LIVE_CACHE_MS, async () => {
    const blocksRes = await client.query({
      query: `
        SELECT block_height, toString(block_timestamp) AS ts, block_hash, author, spec_version
        FROM price_data.raw_blocks FINAL
        ORDER BY block_height DESC
        LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
      query_params: { limit, offset },
      format: 'JSONEachRow',
    })
    const blocks = await blocksRes.json<{ block_height: number; ts: string; block_hash: string; author: string | null; spec_version: number }>()
    if (!blocks.length) return []
    const heights = blocks.map(b => b.block_height)
    const minH = Math.min(...heights)
    const maxH = Math.max(...heights)
    const [extRes, evRes] = await Promise.all([
      client.query({
        // Count identities, not rows: a re-indexed range holds the same extrinsic
        // twice until its parts merge, which would double every count on the page.
        query: `SELECT block_height, uniqExact(extrinsic_index) AS c FROM price_data.raw_extrinsics
                WHERE block_height >= {min:UInt32} AND block_height <= {max:UInt32} GROUP BY block_height`,
        query_params: { min: minH, max: maxH }, format: 'JSONEachRow',
      }),
      client.query({
        query: `SELECT block_height, uniqExact(event_index) AS c FROM price_data.raw_events
                WHERE block_height >= {min:UInt32} AND block_height <= {max:UInt32} GROUP BY block_height`,
        query_params: { min: minH, max: maxH }, format: 'JSONEachRow',
      }),
    ])
    const extCounts = new Map<number, number>()
    for (const r of await extRes.json<{ block_height: number; c: string }>()) extCounts.set(r.block_height, Number(r.c))
    const evCounts = new Map<number, number>()
    for (const r of await evRes.json<{ block_height: number; c: string }>()) evCounts.set(r.block_height, Number(r.c))
    const rows: BlockSummary[] = blocks.map(b => ({
      height: b.block_height,
      timestamp: b.ts,
      hash: b.block_hash,
      author: b.author ? accountRef(b.author) : null,
      specVersion: b.spec_version,
      extrinsicCount: extCounts.get(b.block_height) ?? 0,
      eventCount: evCounts.get(b.block_height) ?? 0,
    }))
    return rows
  })
}

// single block
export interface ExtrinsicOrigin {
  kind: 'proxy' | 'multisig'
  state?: 'pending' | 'executed' | 'cancelled'
  threshold?: number
  signatories?: number
  approvals?: number
  callHash?: string
  initiator?: AccountRef
  timeline?: { account: AccountRef; action: 'initiated' | 'approved' | 'executed' | 'cancelled'; timestamp: string; extrinsicId: string }[]
}
export interface ExtrinsicSummary {
  blockHeight: number
  index: number
  hash: string
  timestamp: string
  signer: AccountRef | null
  success: boolean
  callName: string
  fee: string | null
  origin?: ExtrinsicOrigin
  // Optional here (list rows omit it on success); ExtrinsicDetail narrows this
  // to `FailureReason | null` always-present, hence the `| null` so the
  // override stays assignable to the base property type.
  errorReason?: FailureReason | null
}
interface ExtrinsicSummaryRow {
  block_height: number
  extrinsic_index: number
  extrinsic_hash: string
  ts: string
  signer: string | null
  success: number
  call_name: string
  fee: string | null
  display_call_name?: string
  display_success?: number | null
  origin_kind?: string
  ms_state?: string
  ms_threshold?: number
  ms_signatories?: number
  ms_approvals?: number
  ms_call_hash?: string
  ms_initiator?: string
  ms_timeline_actors?: string[]
  ms_timeline_actions?: string[]
  ms_timeline_ts?: string[]
  ms_timeline_blocks?: number[]
  ms_timeline_extrinsics?: number[]
  error_json?: string | null
  spec_version?: number
}

// Format a unix-seconds timestamp the same way ClickHouse's toString(DateTime)
// does on this (UTC-configured) server, for on-behalf timeline entries built
// in application code rather than read straight out of a DateTime column.
// server.ts asserts `SELECT timezone() = 'UTC'` at startup and exits if not, so
// this UTC assumption holds by construction rather than by convention.
function chTimestampString(ts: number): string {
  const d = new Date(ts * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

function extrinsicSummary(row: ExtrinsicSummaryRow): ExtrinsicSummary {
  const summary: ExtrinsicSummary = {
    blockHeight: row.block_height,
    index: row.extrinsic_index,
    hash: row.extrinsic_hash,
    timestamp: row.ts,
    signer: row.signer ? accountRef(row.signer) : null,
    success: row.display_success != null ? row.display_success === 1 : row.success === 1,
    callName: row.display_call_name || row.call_name,
    fee: row.fee,
    errorReason: (row.display_success != null ? row.display_success === 0 : row.success === 0)
      ? (dispatchErrorReason(row.error_json ?? null, row.spec_version ?? 0, resolveModuleError) ?? undefined)
      : undefined,
  }
  if (row.origin_kind === 'proxy') {
    summary.origin = { kind: 'proxy' }
  } else if (row.origin_kind === 'multisig') {
    summary.origin = {
      kind: 'multisig',
      state: (row.ms_state as ExtrinsicOrigin['state']) ?? 'executed',
      threshold: row.ms_threshold || undefined,
      signatories: row.ms_signatories || undefined,
      approvals: row.ms_approvals || undefined,
      callHash: row.ms_call_hash || undefined,
      initiator: row.ms_initiator ? accountRef(row.ms_initiator) : undefined,
      timeline: row.ms_timeline_actors?.length
        ? row.ms_timeline_actors.map((account, i) => ({
          account: accountRef(account),
          action: (row.ms_timeline_actions?.[i] ?? 'approved') as 'initiated' | 'approved' | 'executed' | 'cancelled',
          timestamp: row.ms_timeline_ts?.[i] ?? '',
          extrinsicId: `${row.ms_timeline_blocks?.[i] ?? 0}-${row.ms_timeline_extrinsics?.[i] ?? 0}`,
        }))
        : undefined,
    }
  }
  return summary
}

function uniqueExtrinsicSummaries(rows: ExtrinsicSummaryRow[]): ExtrinsicSummary[] {
  const seen = new Set<string>()
  return rows.flatMap(row => {
    const key = `${row.block_height}:${row.extrinsic_index}`
    if (seen.has(key)) return []
    seen.add(key)
    return [extrinsicSummary(row)]
  })
}
export interface BlockEvent { eventIndex: number; extrinsicIndex: number | null; name: string; args: unknown }
export interface BlockDetail extends BlockSummary {
  parentHash: string
  stateRoot: string | null
  extrinsicsRoot: string | null
  extrinsics: ExtrinsicSummary[]
  events: BlockEvent[]
  // How many of the block's events `events` carries. Below eventCount on busy
  // blocks, where the list is a prefix rather than the whole block.
  eventsShown: number
}

// A block's event list is rendered in full, so the payload carries at most this
// many. Busy blocks hold thousands; the response says how many it carries so the UI
// can point at the filtered event list instead of silently showing a prefix.
const BLOCK_EVENT_PAGE = 400

export async function getBlock(height: number): Promise<BlockDetail | null> {
  return cached(`explorer:block:${height}`, 10000, async () => {
    const [blockRes, extRes, evRes, evListRes] = await Promise.all([
      client.query({
        query: `SELECT block_height, toString(block_timestamp) AS ts, block_hash, parent_hash, state_root, extrinsics_root, author, spec_version
                FROM price_data.raw_blocks WHERE block_height = {h:UInt32} LIMIT 1`,
        query_params: { h: height }, format: 'JSONEachRow',
      }),
      client.query({
        query: `SELECT extrinsic_index, extrinsic_hash, toString(block_timestamp) AS ts, coalesce(signer, effective_signer) AS signer, success, call_name, fee
                FROM price_data.raw_extrinsics WHERE block_height = {h:UInt32} ORDER BY extrinsic_index`,
        query_params: { h: height }, format: 'JSONEachRow',
      }),
      client.query({
        query: `SELECT uniqExact(event_index) AS c FROM price_data.raw_events WHERE block_height = {h:UInt32}`,
        query_params: { h: height }, format: 'JSONEachRow',
      }),
      client.query({
        query: `SELECT event_index, extrinsic_index, event_name, args_json
                FROM price_data.raw_events WHERE block_height = {h:UInt32} ORDER BY event_index LIMIT {evLimit:UInt32}`,
        query_params: { h: height, evLimit: BLOCK_EVENT_PAGE }, format: 'JSONEachRow',
      }),
    ])
    const block = (await blockRes.json<{ block_height: number; ts: string; block_hash: string; parent_hash: string; state_root: string | null; extrinsics_root: string | null; author: string | null; spec_version: number }>())[0]
    if (!block) return null
    const exts = await extRes.json<{ extrinsic_index: number; extrinsic_hash: string; ts: string; signer: string | null; success: number; call_name: string; fee: string | null }>()
    const eventCount = Number((await evRes.json<{ c: string }>())[0]?.c ?? 0)
    const evSeen = new Set<number>()
    const events: BlockEvent[] = (await evListRes.json<{ event_index: number; extrinsic_index: number | null; event_name: string; args_json: string }>())
      .filter(r => (evSeen.has(r.event_index) ? false : (evSeen.add(r.event_index), true)))
      .map(r => ({ eventIndex: r.event_index, extrinsicIndex: r.extrinsic_index, name: r.event_name, args: safeJson(r.args_json) }))
    // De-dup replay rows by extrinsic_index.
    const seen = new Set<number>()
    const extrinsics: ExtrinsicSummary[] = []
    for (const e of exts) {
      if (seen.has(e.extrinsic_index)) continue
      seen.add(e.extrinsic_index)
      extrinsics.push({
        blockHeight: block.block_height,
        index: e.extrinsic_index,
        hash: e.extrinsic_hash,
        timestamp: e.ts,
        signer: e.signer ? accountRef(e.signer) : null,
        success: e.success === 1,
        callName: e.call_name,
        fee: e.fee,
      })
    }
    return {
      height: block.block_height,
      timestamp: block.ts,
      hash: block.block_hash,
      parentHash: block.parent_hash,
      stateRoot: block.state_root,
      extrinsicsRoot: block.extrinsics_root,
      author: block.author ? accountRef(block.author) : null,
      specVersion: block.spec_version,
      extrinsicCount: extrinsics.length,
      eventCount,
      extrinsics,
      events,
      eventsShown: events.length,
    }
  })
}

// recent extrinsics
export async function getRecentExtrinsics(limit: number, signedOnly: boolean, from?: string, to?: string, offset = 0, filters: ExtrinsicListFilters = {}): Promise<ExtrinsicSummary[]> {
  const tw = timeWindow(from, to)
  return cached(`explorer:extrinsics:${await liveHeadTag(Boolean(tw), datedWindowIsClosed(to))}:${limit}:${offset}:${signedOnly}:${from ?? ''}:${to ?? ''}:${filterKey(filters)}`, tw ? 30000 : LIVE_CACHE_MS, async () => {
    const callFilter = filters.call?.trim() ? textNameFilter('call_name', 'callName') : ''
    const resultFilter = filters.result === 'success' ? 'AND success = 1' : filters.result === 'failed' ? 'AND success = 0' : ''
    const rows = await withFeedWindow(tw, limit, offset + limit, async (bound) => {
      const res = await client.query({
        // The extrinsics-only select below keeps `bound`/filters unqualified and
        // ambiguity-free (single table in scope); the spec_version join happens
        // one level up, against the already-paginated page, since `bound` may
        // reference `block_height`/`block_timestamp` which also exist on
        // price_data.blocks and would otherwise resolve ambiguously.
        query: `
          SELECT ext.block_height AS block_height, ext.extrinsic_index AS extrinsic_index, ext.extrinsic_hash AS extrinsic_hash,
                 ext.ts AS ts, ext.signer AS signer, ext.success AS success, ext.call_name AS call_name, ext.fee AS fee,
                 ext.error_json AS error_json, b.spec_version AS spec_version
          FROM (
            SELECT block_height, extrinsic_index, extrinsic_hash, toString(block_timestamp) AS ts, coalesce(signer, effective_signer) AS signer, success, call_name, fee, error_json
            FROM price_data.raw_extrinsics
            WHERE ${bound}
              ${signedOnly ? 'AND coalesce(signer, effective_signer) IS NOT NULL' : ''}
              ${callFilter}
              ${resultFilter}
            ORDER BY block_height DESC, extrinsic_index DESC
            LIMIT {limit:UInt32} OFFSET {offset:UInt32}
          ) AS ext
          LEFT JOIN price_data.blocks b ON b.block_height = ext.block_height
          ORDER BY ext.block_height DESC, ext.extrinsic_index DESC`,
        query_params: { limit, offset, ...textNameParams('callName', filters.call) }, format: 'JSONEachRow',
      })
      return res.json<ExtrinsicSummaryRow & { error_json: string | null; spec_version: number }>()
    })
    return uniqueExtrinsicSummaries(rows)
  })
}

// single extrinsic
// What the fee actually cost the payer, when that is not the native figure `fee`
// states. Present only when the extrinsic settled its fee in a non-native asset,
// or when there is no native figure to state at all (see extrinsicFeePayment.ts).
// Absent for an ordinary BSX-paying extrinsic, so a
// reader that has it should show it INSTEAD of `fee`/`tip`.
export interface FeePayment {
  asset: AssetRef
  amount: string
  tipAmount: string | null
}

export interface ExtrinsicDetail extends ExtrinsicSummary {
  version: number
  tip: string | null
  feePayment?: FeePayment
  callArgs: unknown
  error: unknown
  errorReason: FailureReason | null
  events: { eventIndex: number; name: string; args: unknown }[]
}

interface ExtrinsicDetailRow {
  block_height: number
  extrinsic_index: number
  extrinsic_hash: string
  ts: string
  version: number
  signer: string | null
  success: number
  call_name: string
  fee: string | null
  tip: string | null
  call_args_json: string
  error_json: string | null
  spec_version: number
}

// Resolve the fee's real asset for a surface that already holds the extrinsic's
// events. Withheld only for a plain BSX substrate fee: `fee`/`tip` already state
// that exactly, down to the tip split the runtime performed itself, so
// re-deriving it from the treasury deposit could only lose precision. A zero
// substrate fee is NOT that case — an `EVM.call` dispatched `Pays::No` reports
// `actualFee: 0` and charges real gas, so a BSX-paying one still needs this.
function feePaymentOf(
  events: readonly FeePaymentEvent[],
  payer: string | null,
  fee: string | null,
  tip: string | null,
): FeePayment | undefined {
  const derived = deriveFeePayment(events, payer, fee, tip)
  if (!derived || (derived.assetId === 0 && hasSubstrateFee(fee, tip))) return undefined
  return { asset: asset(derived.assetId), amount: derived.amount, tipAmount: derived.tipAmount }
}

async function hydrateExtrinsicDetail(row: ExtrinsicDetailRow): Promise<ExtrinsicDetail> {
  const eventResult = await client.query({
    query: `SELECT event_index, event_name, args_json FROM price_data.raw_events
            WHERE block_height = {height:UInt32} AND extrinsic_index = {index:UInt32} ORDER BY event_index`,
    query_params: { height: row.block_height, index: row.extrinsic_index },
    format: 'JSONEachRow',
  })
  const eventRows = await eventResult.json<{ event_index: number; event_name: string; args_json: string }>()
  const seen = new Set<number>()
  const events: ExtrinsicDetail['events'] = []
  for (const event of eventRows) {
    if (seen.has(event.event_index)) continue
    seen.add(event.event_index)
    events.push({ eventIndex: event.event_index, name: event.event_name, args: safeJson(event.args_json) })
  }
  const callArgs = safeJson(row.call_args_json)
  const feePayment = feePaymentOf(events, row.signer, row.fee, row.tip)

  return {
    blockHeight: row.block_height,
    index: row.extrinsic_index,
    hash: row.extrinsic_hash,
    timestamp: row.ts,
    signer: row.signer ? accountRef(row.signer) : null,
    success: row.success === 1,
    callName: row.call_name,
    fee: row.fee,
    version: row.version,
    tip: row.tip,
    callArgs,
    error: row.error_json ? safeJson(row.error_json) : null,
    errorReason: row.success === 1 ? null : dispatchErrorReason(row.error_json, row.spec_version, resolveModuleError),
    events,
    ...(feePayment ? { feePayment } : {}),
  }
}

// A 64-hex extrinsic id, resolved as a substrate extrinsic hash first and an
// Ethereum transaction hash second. The two hash spaces are 32-byte digests over
// different preimages, so a collision is cryptographically negligible; the order
// states which meaning `/extrinsic/<hash>` takes as primary rather than resolving
// a real ambiguity. An EVM hit answers through getExtrinsicAt, so a transaction
// hash and its canonical height-index id return the same object from the same
// code and can never disagree.
// Thrown by the hash lookup's cache builder so a miss propagates as an error
// (which cached() does not store) rather than as a cached null.
class ExtrinsicNotFound extends Error {}
export async function getExtrinsic(hash: string): Promise<ExtrinsicDetail | null> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return null
  // A miss is NOT cached: a hash asked for while its block is still being
  // ingested would otherwise 404 for the whole TTL, long after the extrinsic
  // became readable. Misses are cheap and rare; a hit caches normally.
  const found = await cached(`explorer:extrinsic:${hash.toLowerCase()}`, 10000, async () => {
    const res = await client.query({
      query: `SELECT e.block_height AS block_height, e.extrinsic_index AS extrinsic_index, e.extrinsic_hash AS extrinsic_hash,
                     toString(e.block_timestamp) AS ts, e.version AS version,
                     coalesce(e.signer, e.effective_signer) AS signer, e.success AS success, e.call_name AS call_name,
                     e.fee AS fee, e.tip AS tip, e.call_args_json AS call_args_json, e.error_json AS error_json,
                     b.spec_version AS spec_version
              FROM price_data.raw_extrinsics e
              LEFT JOIN price_data.blocks b ON b.block_height = e.block_height
              WHERE e.extrinsic_hash = {hash:String} ORDER BY e.block_height DESC LIMIT 1`,
      query_params: { hash: hash.toLowerCase() }, format: 'JSONEachRow',
    })
    const row = (await res.json<ExtrinsicDetailRow>())[0]
    if (!row) throw new ExtrinsicNotFound()
    return hydrateExtrinsicDetail(row)
  }).catch(error => {
    if (error instanceof ExtrinsicNotFound) return null
    throw error
  })
  return found
}

// recent transfers
export interface TransferRow {
  blockHeight: number
  timestamp: string
  eventIndex: number
  extrinsicIndex: number | null
  from: AccountRef
  to: AccountRef
  amount: string
  asset: AssetRef
  valueUsd: number | null
}

interface RawTransferEventRow {
  block_height: number
  ts: string
  event_index: number
  extrinsic_index: number | null
  event_name: string
  from_acc: string
  to_acc: string
  amount: string
  asset_id: number
}

function transferEventPriority(name: string): number {
  if (name === 'Currencies.Transferred') return 3
  if (name === 'Tokens.Transfer') return 2
  return 1
}

function dedupeTransferEvents<T extends RawTransferEventRow>(rows: T[]): T[] {
  const maxPriority = new Map<string, number>()
  for (const r of rows) {
    const key = `${r.block_height}|${r.extrinsic_index ?? -1}|${r.asset_id}|${r.from_acc.toLowerCase()}|${r.to_acc.toLowerCase()}|${r.amount}`
    const p = transferEventPriority(r.event_name)
    if (p > (maxPriority.get(key) ?? 0)) maxPriority.set(key, p)
  }
  return rows.filter(r => {
    const key = `${r.block_height}|${r.extrinsic_index ?? -1}|${r.asset_id}|${r.from_acc.toLowerCase()}|${r.to_acc.toLowerCase()}|${r.amount}`
    return transferEventPriority(r.event_name) === maxPriority.get(key)
  })
}

async function getRecentTransfers(limit: number, from?: string, to?: string, offset = 0, userOnly = false, filters: ValueListFilters = {}): Promise<TransferRow[]> {
  const tw = timeWindow(from, to)
  return cached(`explorer:transfers:${await liveHeadTag(Boolean(tw), datedWindowIsClosed(to))}:${limit}:${offset}:${from ?? ''}:${to ?? ''}:${userOnly}:${filterKey(filters)}`, tw ? 30000 : LIVE_CACHE_MS, async () => {
    const prices = await ensurePrices()
    const tokenIds = assetIdsForToken(filters.token)
    const useAssetTransferReadModel = tokenIds != null
    const useTimeTransferReadModel = tokenIds == null
    const useTransferReadModel = useAssetTransferReadModel || useTimeTransferReadModel
    const transferTable = useAssetTransferReadModel ? 'transfer_activity' : 'transfer_activity_by_time'
    const assetExpr = useTransferReadModel ? 'asset_id' : transferAssetIdSql()
    const amountExpr = useTransferReadModel ? 'amount' : `JSONExtractString(args_json, 'amount')`
    const tokenFilter = assetIdFilterSql(assetExpr, tokenIds)
    const tokenRefsFilter = useTransferReadModel ? '' : eventAssetRefsFilterSql(tokenIds, `'Balances.Transfer','Tokens.Transfer','Currencies.Transferred'`)
    const postUsdFilter = filters.min != null && filters.unit !== 'token'
    const amountFilter = eventValueFilterSql(assetExpr, amountExpr, 'block_timestamp',
      postUsdFilter ? { ...filters, min: undefined, unit: undefined } : filters, prices, 'transfer_price')
    const nttExclusion = ''
    // userOnly drops pallet/pool/fee legs (module accounts 0x6d6f646c…) so the
    // Activity's "Transfers" tab shows genuine user↔user transfers, not swap noise.
    const plumbing = [...ammPoolAccounts()]
    const plumbingList = plumbing.length ? plumbing.map(a => `'${a}'`).join(',') : "''"
    const userFilter = userOnly && useTransferReadModel
      ? `AND NOT match(from_account, '^0x(6d6f646c|7369626c|70617261|506172656e74)')
         AND NOT match(to_account, '^0x(6d6f646c|7369626c|70617261|506172656e74)')
         AND from_account NOT IN (${plumbingList})
         AND to_account NOT IN (${plumbingList})`
      : userOnly
      ? `AND NOT match(JSONExtractString(args_json,'from'), '^0x(6d6f646c|7369626c|70617261|506172656e74)')
         AND NOT match(JSONExtractString(args_json,'to'), '^0x(6d6f646c|7369626c|70617261|506172656e74)')
         AND JSONExtractString(args_json,'from') NOT IN (${plumbingList})
         AND JSONExtractString(args_json,'to') NOT IN (${plumbingList})`
      : ''
    const scanLimit = limit
    const scanOffset = offset
    const buildTransferRows = async (rawRows: RawTransferEventRow[]): Promise<TransferRow[]> => {
      const raw = dedupeTransferEvents(rawRows)
      const seen = new Set<string>()
      const out: TransferRow[] = []
      for (const r of raw) {
        const key = `${r.block_height}:${r.event_index}`
        if (seen.has(key)) continue
        seen.add(key)
        const a = asset(r.asset_id)
        out.push({
          blockHeight: r.block_height, timestamp: r.ts, eventIndex: r.event_index, extrinsicIndex: r.extrinsic_index,
          from: accountRef(r.from_acc), to: accountRef(r.to_acc), amount: r.amount, asset: a,
          valueUsd: usdValue(prices, a.assetId, r.amount, a.decimals),
        })
      }
      await applyHistoricalUsd(out, transferHistPick)
      return out
    }
    const fetchPage = async (bound: string, pageLimit: number, pageOffset: number): Promise<TransferRow[]> => {
      const res = await client.query({
        query: `
          SELECT block_height, ts, event_index, extrinsic_index,
            event_name,
            from_acc, to_acc, amount, asset_id
          FROM
          (
            SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index,
              event_name,
              ${useTransferReadModel ? 'from_account' : "JSONExtractString(args_json, 'from')"} AS from_acc,
              ${useTransferReadModel ? 'to_account' : "JSONExtractString(args_json, 'to')"} AS to_acc,
              ${amountExpr} AS amount,
              ${assetExpr} AS asset_id,
              multiIf(event_name = 'Currencies.Transferred', 3, event_name = 'Tokens.Transfer', 2, 1) AS priority
            FROM price_data.${useTransferReadModel ? transferTable : 'raw_events'}
            ${amountFilter.joinSql}
            WHERE ${bound}
              ${useTransferReadModel ? '' : "AND event_name IN ('Balances.Transfer','Tokens.Transfer','Currencies.Transferred')"}
              ${userFilter}
              ${nttExclusion}
              ${tokenRefsFilter}
              ${tokenFilter}
              ${amountFilter.predicateSql}
            ORDER BY block_height DESC, priority DESC, event_index DESC
            LIMIT 1 BY block_height, extrinsic_index, asset_id, lower(from_acc), lower(to_acc), amount
          )
          ORDER BY block_height DESC, event_index DESC
          LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
        query_params: { limit: pageLimit, offset: pageOffset }, format: 'JSONEachRow',
      })
      return buildTransferRows(await res.json<RawTransferEventRow>())
    }
    if (postUsdFilter) {
      let pageState: { scanned: number; cursor: { blockHeight: number; eventIndex: number } | null } = { scanned: 0, cursor: null }
      const fetchValuePage = async (bound: string, pageLimit: number): Promise<TransferRow[]> => {
        const runRaw = async (rawBound: string, rawLimit: number): Promise<RawTransferEventRow[]> => {
          const res = await client.query({
            query: `SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name,
                      ${useTransferReadModel ? 'from_account' : "JSONExtractString(args_json, 'from')"} AS from_acc,
                      ${useTransferReadModel ? 'to_account' : "JSONExtractString(args_json, 'to')"} AS to_acc,
                      ${amountExpr} AS amount, ${assetExpr} AS asset_id
                    FROM price_data.${useTransferReadModel ? transferTable : 'raw_events'}
                    ${amountFilter.joinSql}
                    WHERE ${rawBound}
                      ${useTransferReadModel ? '' : "AND event_name IN ('Balances.Transfer','Tokens.Transfer','Currencies.Transferred')"}
                      ${userFilter} ${nttExclusion} ${tokenRefsFilter} ${tokenFilter} ${amountFilter.predicateSql}
                    ORDER BY block_height DESC, event_index DESC
                    LIMIT {limit:UInt32}`,
            query_params: { limit: rawLimit }, format: 'JSONEachRow',
          })
          return res.json<RawTransferEventRow>()
        }
        let raw = await runRaw(bound, pageLimit)
        pageState = {
          scanned: raw.length,
          cursor: raw.length ? { blockHeight: raw.at(-1)!.block_height, eventIndex: raw.at(-1)!.event_index } : null,
        }
        // Complete the boundary block before collapsing pallet mirror events;
        // otherwise a LIMIT split could keep a lower-priority mirror on one
        // page and its canonical Currencies.Transferred sibling on the next.
        if (raw.length >= pageLimit) {
          const boundary = raw.at(-1)!.block_height
          const boundaryRows = await runRaw(`(${tw ?? '1'}) AND block_height = ${boundary}`, 25_000)
          const byEvent = new Map(raw.map(row => [`${row.block_height}:${row.event_index}`, row]))
          for (const row of boundaryRows) byEvent.set(`${row.block_height}:${row.event_index}`, row)
          raw = [...byEvent.values()].sort((left, right) =>
            right.block_height - left.block_height || right.event_index - left.event_index)
          pageState.cursor = { blockHeight: boundary, eventIndex: 0 }
        }
        return buildTransferRows(raw)
      }
      const deep = await fetchFilteredDeep(tw, offset + limit,
        fetchValuePage,
        row => rowMeetsExactUsdMinimum(row, filters.min!),
        row => row.blockHeight, row => row.eventIndex,
        row => `${row.blockHeight}:${row.eventIndex}`,
        { pageSize: 25_000, pageState: () => pageState })
      return deep.slice(offset, offset + limit)
    }
    return withFeedWindow(tw, scanLimit, scanOffset + scanLimit,
      bound => fetchPage(bound, scanLimit, scanOffset))
  })
}

// holders (grouped by label)
export interface HolderRow {
  rank: number
  account: AccountRef | null                 // null when this is a multi-account tag group
  // `userTagId`/`listId` are additive, same convention as TopAccountRow: set only
  // when this group folded under the REQUESTING viewer's own tag (served from
  // /user/holders) rather than a system one. `memberCount` counts members
  // HOLDING this asset, like every system tag row on this surface.
  tag: { tagId: string; name: string; color: string; icon: string; memberCount: number; userTagId?: string; listId?: string } | null
  balance: string
  lastBlock: number
  valueUsd?: number | null
  share?: number                             // fraction of the asset's total held USD
}

export interface HoldersPage { asset: AssetRef; holders: HolderRow[]; total: number; totalUsd: number }

// Paginated holder list. `limit`/`offset` page the full set (no hard cap), and
// `total`/`totalUsd` describe the whole holder base regardless of the page so the
// UI can show the true count, per-holder share, and a pager.
export async function getHolders(assetId: number, limit: number, offset = 0): Promise<HoldersPage> {
  const a = asset(assetId)
  const pageKey = `explorer:holders:${assetId}:${limit}:${offset}`
  return cached(pageKey, 30000, async () => {
    const prices = await ensurePrices()
    const groupKeySql = `if(t.label_id = '', latest.account_id, t.label_id)`
    const labelIdSql = `t.label_id`
    const res = await client.query({
      query: `
        WITH
          tags AS (
            SELECT account_id, any(label_id) AS label_id, any(label_name) AS label_name, any(color) AS color, any(icon) AS icon
            FROM price_data.account_tags FINAL WHERE deleted = 0 GROUP BY account_id
          ),
          latest_raw AS (
            SELECT
              account_id,
              toUInt256OrZero(argMaxMerge(total_state)) AS latest_bal,
              maxMerge(last_block_state) AS latest_block
            FROM price_data.account_asset_latest_balances
            WHERE asset_id = {asset:String}
            GROUP BY account_id
          ),
          latest AS (
            -- Holder pages must reflect current state. The latest-balance aggregate
            -- is refreshed by full RPC balance snapshots; falling back to an older
            -- non-zero observation resurrects accounts that now hold zero.
            SELECT
              l.account_id AS account_id,
              sum(l.bal) AS bal, max(l.last_block) AS last_block FROM (
              SELECT latest_raw.account_id AS account_id, latest_raw.latest_bal AS bal, latest_raw.latest_block AS last_block
              FROM latest_raw
            ) l
            GROUP BY account_id
          ),
          grouped AS (
            SELECT
              ${groupKeySql} AS group_key,
              ${labelIdSql} AS label_id,
              any(t.label_name) AS label_name,
              any(t.color) AS color,
              any(t.icon) AS icon,
              count() AS member_count,
              sum(latest.bal) AS gbal,
              max(latest.last_block) AS last_block,
              any(latest.account_id) AS sample_account
            FROM latest
            LEFT JOIN tags t ON t.account_id = latest.account_id
            GROUP BY group_key, label_id
            HAVING gbal > 0
          )
        SELECT group_key, label_id, label_name, color, icon, member_count,
               toString(gbal) AS balance, last_block, sample_account,
               count() OVER () AS total, toString(sum(gbal) OVER ()) AS total_bal
        FROM grouped
        ORDER BY gbal DESC
        LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
      query_params: { asset: String(assetId), limit, offset }, format: 'JSONEachRow',
    })
    const rows = await res.json<{ group_key: string; label_id: string; label_name: string; color: string; icon: string; member_count: string; balance: string; last_block: number; sample_account: string; total: string; total_bal: string }>()
    const total = rows.length ? Number(rows[0].total) : 0
    const totalUsd = rows.length ? (usdValue(prices, assetId, rows[0].total_bal, a.decimals) ?? 0) : 0
    const holders: HolderRow[] = rows.map((r, i) => {
      const isTag = r.label_id !== ''
      const valueUsd = usdValue(prices, assetId, r.balance, a.decimals)
      return {
        rank: offset + i + 1,
        account: isTag ? null : accountRef(r.sample_account),
        tag: isTag ? { tagId: r.label_id, name: r.label_name, color: r.color, icon: tagIcon(r.label_id, r.icon), memberCount: Number(r.member_count) } : null,
        balance: r.balance,
        lastBlock: r.last_block,
        valueUsd,
        share: totalUsd > 0 ? (valueUsd ?? 0) / totalUsd : 0,
      }
    })
    return { asset: a, holders, total, totalUsd }
  })
}

// address detail
// `frozen` is the non-transferable part of `free` (per-account max lock, summed
// across the account set); `breakdown` lists the lock/reserve/hold/deposit
// components and `timeline` the binding unlock schedule (when how much of the
// frozen balance actually unlocks, and which lock causes it) — both from the
// background lock snapshot (see lockBreakdownService).
export interface AddressBalance { asset: AssetRef; total: string; free: string; reserved: string; frozen?: string; breakdown?: BalanceLockComponent[]; timeline?: BalanceUnlockSlice[]; lastBlock: number; valueUsd: number | null }
interface AggregatedBalanceRow { asset_id: string; total: string; free: string; reserved: string; last_block: number }

async function queryAggregatedBalances(accountListSql: string): Promise<AggregatedBalanceRow[]> {
  const result = await client.query({
    query: `
      SELECT asset_id, toString(sum(t)) AS total, toString(sum(f)) AS free, toString(sum(rsv)) AS reserved, max(lb) AS last_block FROM (
        SELECT account_id, asset_id,
          toUInt256OrZero(argMaxMerge(total_state)) AS t,
          toUInt256OrZero(argMaxMerge(free_state)) AS f,
          toUInt256OrZero(argMaxMerge(reserved_state)) AS rsv,
          maxMerge(last_block_state) AS lb
        FROM price_data.account_asset_latest_balances
        WHERE account_id IN (${accountListSql})
        GROUP BY account_id, asset_id
      ) GROUP BY asset_id HAVING sum(t) > 0 ORDER BY asset_id`,
    format: 'JSONEachRow',
  })
  return result.json<AggregatedBalanceRow>()
}

function valueAccountBalances(rows: AggregatedBalanceRow[], prices: Map<number, PriceInfo>): AddressBalance[] {
  return rows
    .map(row => {
      const balanceAsset = asset(row.asset_id)
      return {
        asset: balanceAsset,
        total: row.total,
        free: row.free,
        reserved: row.reserved,
        lastBlock: row.last_block,
        valueUsd: usdValue(prices, balanceAsset.assetId, row.total, balanceAsset.decimals),
      }
    })
    .sort((left, right) => (right.valueUsd ?? 0) - (left.valueUsd ?? 0))
}

// The largest holdings (up to 4), highest first, keeping only those worth > $10
// AND at least 10% of the account's total held value. Fed the same valued +
// folded balances the detail pages build (wallet + MM-collateral aTokens +
// ERC-20), so the accounts-list icons and the hover card always agree.
export const HELD_TOKEN_MIN_USD = 10
export function topHeldTokens(balances: AddressBalance[]): { asset: AssetRef; valueUsd: number }[] {
  const total = balances.reduce((sum, b) => sum + Math.max(0, b.valueUsd ?? 0), 0)
  return balances
    .filter(b => (b.valueUsd ?? 0) > HELD_TOKEN_MIN_USD && (b.valueUsd ?? 0) >= 0.10 * total)
    .sort((left, right) => (right.valueUsd ?? 0) - (left.valueUsd ?? 0))
    .slice(0, 4)
    .map(b => ({ asset: b.asset, valueUsd: b.valueUsd as number }))
}


// Attach the background lock-snapshot components to the final displayed balance
// rows. Components are keyed by on-chain asset id — the same id the balance row
// carries, since nothing folds one asset's holdings into another's — and several
// components of one kind+source on the same asset merge additively.
export function attachLockBreakdowns(balances: AddressBalance[], breakdowns: Map<number, AssetLockBreakdown>): AddressBalance[] {
  if (!breakdowns.size) return balances
  interface ComponentAgg { kind: BalanceLockComponent['kind']; source: string; amount: bigint; claimable: bigint; tranches?: BalanceLockTranche[]; mixed: boolean }
  const byAsset = new Map<number, { frozen: bigint; components: Map<string, ComponentAgg>; timeline?: BalanceUnlockSlice[] }>()
  for (const [assetId, b] of breakdowns) {
    const num = (v: string) => BigInt(v || '0')
    const agg = byAsset.get(assetId) ?? { frozen: 0n, components: new Map<string, ComponentAgg>() }
    agg.frozen += num(b.frozen)
    if (b.timeline?.length && !agg.timeline) agg.timeline = b.timeline.map(s => ({ ...s, amount: num(s.amount).toString() }))
    for (const c of b.components) {
      const key = `${c.kind}|${c.source}`
      const cur = agg.components.get(key)
      const tranches = c.tranches?.map(t => ({ ...t, amount: num(t.amount).toString() }))
      if (cur) {
        // Two components of one kind+source: amounts add, but the tranche
        // timelines would interleave misleadingly — drop them.
        cur.amount += num(c.amount)
        cur.claimable += num(c.claimable ?? '0')
        cur.mixed = true
      } else {
        agg.components.set(key, { kind: c.kind, source: c.source, amount: num(c.amount), claimable: num(c.claimable ?? '0'), tranches, mixed: false })
      }
    }
    byAsset.set(assetId, agg)
  }
  return balances.map(b => {
    const agg = byAsset.get(b.asset.assetId)
    if (!agg?.components.size) return b
    const breakdown = [...agg.components.values()]
      .sort((x, y) => (y.amount > x.amount ? 1 : y.amount < x.amount ? -1 : 0))
      .map(c => ({
        kind: c.kind, source: c.source, amount: c.amount.toString(),
        ...(c.claimable > 0n ? { claimable: c.claimable.toString() } : {}),
        ...(c.tranches?.length && !c.mixed ? { tranches: c.tranches } : {}),
      }))
    return { ...b, frozen: agg.frozen.toString(), breakdown, ...(agg.timeline?.length ? { timeline: agg.timeline } : {}) }
  })
}

async function queryLockBreakdownsSafe(accountListSql: string): Promise<Map<number, AssetLockBreakdown>> {
  try {
    return await queryLockBreakdowns(client, accountListSql)
  } catch (err) {
    // Balances render without the breakdown rather than failing the page.
    console.error('[locks] breakdown read failed', err)
    return new Map()
  }
}

// Proxy & multisig relations resolved to displayable account refs.
export interface ProxyRelationDisplay { account: AccountRef; proxyType: string; delay: number }
export interface AccountProxyDisplay {
  isPure: { creator: AccountRef; proxyType: string; blockHeight: number; extrinsicIndex: number | null; timestamp: string } | null
  delegates: ProxyRelationDisplay[]    // accounts that can act for this one
  delegatorOf: ProxyRelationDisplay[]  // accounts this one can act for
}
export interface MultisigDisplay {
  threshold: number
  signatories: AccountRef[]
  pending: { callHash: string; depositor: AccountRef; approvals: AccountRef[]; sinceBlock: number }[]
}
export interface MultisigMembershipDisplay { account: AccountRef; threshold: number; signatories: number }

export interface AddressDetail {
  input: string
  kind: string
  accountId: string
  emoji: string
  emojiName?: string
  emojiUrl?: string
  ss58: string
  ss58Kusama: string
  tag: { id: string; name: string; color: string; icon: string } | null
  identity: AccountIdentity | null
  relatedAccountIds: string[]
  balances: AddressBalance[]
  // Up to 4 largest holdings (> $10 and ≥ 10% of held value) — the shared icon set
  // for the accounts list and the hover card. Derived from `balances` above.
  topAssets: { asset: AssetRef; valueUsd: number }[]
  portfolioUsd: number
  tradingVolumeUsd: number
  liquidityPositions?: LpPosition[]
  proxy: AccountProxyDisplay | null
  multisig: MultisigDisplay | null
  multisigMemberships: MultisigMembershipDisplay[]
}

// Resolve an address input to its canonical AccountId32 + the account_ids that
// scope its reads. Shared by getAddress and the per-account
// activity/extrinsics/events endpoints so they all scope to the same set.
// Returns null when the input isn't a valid address.
interface RelatedAccounts {
  norm: NonNullable<ReturnType<typeof normalizeAddress>>
  related: string[]
}

export async function resolveRelatedAccounts(addressInput: string): Promise<RelatedAccounts | null> {
  const norm = normalizeAddress(addressInput)
  if (!norm || !norm.accountId) return null
  // Basilisk has no EVM and no bridge aliasing, so there is no cross-account alias
  // graph to fold: an account is exactly itself. The set stays a set because every
  // caller scopes its reads through it, and a future alias family (a rebound
  // identity, a migrated account) would join here rather than at each call site.
  return { norm, related: [norm.accountId] }
}

export async function getAddress(addressInput: string, opts: { summary?: boolean } = {}): Promise<AddressDetail | null> {
  const resolved = await resolveRelatedAccounts(addressInput)
  if (!resolved) return null
  const { norm } = resolved
  // The hover card shows only name + value + top holdings + volumes. `summary` skips
  // the expensive extras it never renders (proxy/multisig live reads) so the
  // preview loads fast; the detail page still requests the full object.
  const summary = opts.summary === true
  return cached(`explorer:address:${accountValueGenerationEpoch}:${norm.accountId}${summary ? ':summary' : ''}`, 8000, async () => {
    // 1. Aliases — discover all account_ids belonging to the same entity.
    const related = new Set<string>(resolved.related)
    const list = sqlAccountList([...related])

    const [balanceRows, lockBreakdowns, prices] = await Promise.all([
      queryAggregatedBalances(list),
      summary ? Promise.resolve(new Map<number, AssetLockBreakdown>()) : queryLockBreakdownsSafe(list),
      ensureAccountValuePrices(),
    ])

    let balances: AddressBalance[] = valueAccountBalances(balanceRows, prices)

    // Attach the lock/reserve components once the display rows are final.
    balances = attachLockBreakdowns(balances, lockBreakdowns)
    const portfolioUsd = balances.reduce((s, b) => s + (b.valueUsd ?? 0), 0)
    const tradingVolumeUsd = await tradingVolumeByAccount([...related]).then(m => [...m.values()].reduce((s, v) => s + v, 0))

    const tag = tagForAccount(norm.accountId)
    const onchainId = identityForAccount(norm.accountId)
    const addrIcon = accountIcon(norm.accountId)
    // LP positions stay even in summary — they count toward the displayed value, so
    // dropping them would make the hover's value disagree with the detail page. Only
    // proxy/multisig (below), which the card never shows, are skipped.
    const lpPositions0 = await getXykPositions([...related], balances)
    // Proxy & multisig relations (in-memory indexes refreshed by the
    // proxyMultisigService; pending ops come from indexed events).
    const toProxyRel = (r: ProxyRelation): ProxyRelationDisplay => ({ account: accountRef(r.accountId), proxyType: r.proxyType, delay: r.delay })
    const proxyRaw = summary ? null : proxyInfoFor([...related])
    const proxy: AccountProxyDisplay | null = proxyRaw ? {
      isPure: proxyRaw.isPure ? { creator: accountRef(proxyRaw.isPure.creator), proxyType: proxyRaw.isPure.proxyType, blockHeight: proxyRaw.isPure.blockHeight, extrinsicIndex: proxyRaw.isPure.extrinsicIndex, timestamp: proxyRaw.isPure.timestamp } : null,
      delegates: proxyRaw.delegates.map(toProxyRel),
      delegatorOf: proxyRaw.delegatorOf.map(toProxyRel),
    } : null
    const msigComp = summary ? null : multisigCompositionFor([...related])
    const msigPending: PendingMultisigOp[] = msigComp ? await pendingMultisigOps(norm.accountId) : []
    const multisig: MultisigDisplay | null = msigComp ? {
      threshold: msigComp.threshold,
      signatories: msigComp.signatories.map(s => accountRef(s)),
      pending: msigPending.map(p => ({ callHash: p.callHash, depositor: accountRef(p.depositor), approvals: p.approvals.map(a => accountRef(a)), sinceBlock: p.sinceBlock })),
    } : null
    const multisigMemberships: MultisigMembershipDisplay[] = multisigMembershipsFor([...related])
      .map(m => ({ account: accountRef(m.accountId), threshold: m.threshold, signatories: m.signatories }))
    const lpPositions = [...lpPositions0].sort((x, y) => (y.valueUsd ?? 0) - (x.valueUsd ?? 0))
    const lpUsd = lpPositions.reduce((s, p) => s + (p.valueUsd ?? 0), 0)
    return {
      input: addressInput,
      kind: norm.kind,
      accountId: norm.accountId,
      emoji: addrIcon.emoji,
      emojiName: addrIcon.emojiName,
      emojiUrl: addrIcon.emojiUrl,
      ss58: norm.ss58 ?? basiliskAddress(norm.accountId),
      ss58Kusama: norm.ss58Kusama ?? '',
      tag: tag ? { id: tag.tagId, name: tag.name, color: tag.color, icon: tag.icon } : null,
      identity: onchainId,
      relatedAccountIds: [...related],
      balances,
      topAssets: topHeldTokens(balances),
      portfolioUsd: portfolioUsd + lpUsd,
      tradingVolumeUsd,
      liquidityPositions: lpPositions,
      proxy,
      multisig,
      multisigMemberships,
      portfolioSeries: [],
      portfolioDates: [],
      balanceHistory: [],
    }
  })
}

// `seriesOnly` drops the per-asset balance history, which is 98-99% of this
// payload on a real account (603 kB of 609 kB on a 33-asset account) and is read
// only by the Balances treemap — the value chart needs the two series alone. Both
// halves come out of one cached walk, so this trims transfer and parse bytes, not
// query work.
export async function getAddressHistory(addressInput: string, opts: { seriesOnly?: boolean } = {}): Promise<{ portfolioSeries: number[]; portfolioDates: string[]; balanceHistory: AssetBalanceHistory[] } | null> {
  const detail = await getAddress(addressInput)
  if (!detail) return null
  // The reconstruction is cached under the same scope key the value-event jump
  // detection uses, so chart and markers share one heavy walk. Only the trivial
  // final-point pin is recomputed per request.
  const history = await getAccountHistoryShared(detail.relatedAccountIds, `addr:${detail.accountId}`)
  const portfolioSeries = history.portfolioSeries.slice()
  if (portfolioSeries.length) portfolioSeries[portfolioSeries.length - 1] = +detail.portfolioUsd.toFixed(2)
  return {
    portfolioSeries,
    portfolioDates: history.portfolioDates,
    balanceHistory: opts.seriesOnly ? [] : history.balanceHistory,
  }
}

// Two price maps are the same account-value generation only if every asset
// carries the same price and 24h change: the pinned map values the whole
// directory, so a moved price is a changed generation even when no claim did.
export function samePriceGeneration(a: Map<number, PriceInfo>, b: Map<number, PriceInfo>): boolean {
  if (a.size !== b.size) return false
  for (const [assetId, price] of a) {
    const other = b.get(assetId)
    if (!other || other.price !== price.price || other.priceRaw !== price.priceRaw || other.change24h !== price.change24h) return false
  }
  return true
}

// An account's LP position, valued at pool NAV. Basilisk's only liquidity venue is
// XYK, whose positions are fungible share tokens (held directly or staked in a farm)
// rather than position NFTs — `venue` distinguishes the two holdings of one pool.
export interface LpPosition { positionId: string; asset: AssetRef; amount: string; shares: string; valueUsd: number | null; venue: string }

// XYK LP redeemable reserve legs for `shares` of a pool with raw reserves `reserveA/B` and
// `totalShares` outstanding — amountX = floor(reserveX * shares / totalShares). Integer/
// bigint throughout (values exceed 2^53); callers convert to USD only after this. Shared by
// direct wallet LP balances and farm-deposit principal (Phase 2, XYK).
export function xykShareLegs(shares: bigint, reserveA: bigint, reserveB: bigint, totalShares: bigint): { amountA: bigint; amountB: bigint } {
  if (totalShares <= 0n || shares <= 0n) return { amountA: 0n, amountB: 0n }
  return { amountA: (reserveA * shares) / totalShares, amountB: (reserveB * shares) / totalShares }
}

// Current XYK pool state (reserves from the latest snapshot, total supply from the latest
// reconstructed step point) for the given LP tokens, to value XYK LP at current NAV. Mirrors
// loadOmnipoolState but for the fungible XYK share tokens.
interface XykCurrentPool { assetA: number; assetB: number; reserveA: bigint; reserveB: bigint; totalShares: bigint }
async function loadXykCurrentState(lpAssetIds: number[]): Promise<Map<number, XykCurrentPool>> {
  const out = new Map<number, XykCurrentPool>()
  if (!lpAssetIds.length) return out
  const regRes = await client.query({ query: `SELECT lp_asset_id, pool_account, asset_a, asset_b FROM price_data.xyk_pool_registry FINAL WHERE lp_asset_id IN {lps:Array(Int32)}`, query_params: { lps: lpAssetIds }, format: 'JSONEachRow' })
  const reg = await regRes.json<{ lp_asset_id: number; pool_account: string; asset_a: number; asset_b: number }>()
  if (!reg.length) return out
  const pools = [...new Set(reg.map(r => r.pool_account))]
  const resvRes = await client.query({
    query: `SELECT JSONExtractString(p,'pool_account') AS pool,
              toInt32(JSONExtractInt(p,'asset_a')) AS aa, toInt32(JSONExtractInt(p,'asset_b')) AS ab,
              JSONExtractString(p,'reserve_a') AS ra, JSONExtractString(p,'reserve_b') AS rb
            FROM price_data.raw_block_snapshots
            ARRAY JOIN JSONExtractArrayRaw(JSONExtractRaw(payload_json,'xyk'),'pools') AS p
            WHERE block_height = (SELECT max(block_height) FROM price_data.raw_block_snapshots) AND JSONExtractString(p,'pool_account') IN {pools:Array(String)}`,
    query_params: { pools }, format: 'JSONEachRow',
  })
  const reserveByPool = new Map<string, { aa: number; ab: number; ra: bigint; rb: bigint }>()
  for (const r of await resvRes.json<{ pool: string; aa: number; ab: number; ra: string; rb: string }>()) reserveByPool.set(r.pool, { aa: r.aa, ab: r.ab, ra: BigInt(r.ra || '0'), rb: BigInt(r.rb || '0') })
  const tsRes = await client.query({ query: `SELECT lp_asset_id, argMax(total_shares_raw, block_height) AS total FROM price_data.xyk_lp_total_shares_history WHERE lp_asset_id IN {lps:Array(Int32)} GROUP BY lp_asset_id`, query_params: { lps: lpAssetIds }, format: 'JSONEachRow' })
  const totalByLp = new Map<number, bigint>()
  for (const r of await tsRes.json<{ lp_asset_id: number; total: string }>()) totalByLp.set(r.lp_asset_id, BigInt(r.total || '0'))
  for (const r of reg) {
    const rv = reserveByPool.get(r.pool_account); const ts = totalByLp.get(r.lp_asset_id)
    if (rv && ts && ts > 0n) {
      // Pair reserves with the snapshot's own asset order, which can differ from the
      // registry's PoolCreated order (see loadXykPrincipalHistory); registry fallback for
      // legacy snapshot rows without asset ids.
      const [assetA, assetB] = rv.aa > 0 && rv.ab > 0 ? [rv.aa, rv.ab] : [r.asset_a, r.asset_b]
      out.set(r.lp_asset_id, { assetA, assetB, reserveA: rv.ra, reserveB: rv.rb, totalShares: ts })
    }
  }
  return out
}

// Current XYK LP positions (direct wallet shareToken balances + open farm
// deposits) valued at pool NAV, so the account's headline value and the history's pinned
// final point include XYK. Direct LP token balances contribute NAV here, not their (null)
// token price in `balances` — no double count.
async function getXykPositions(accounts: string[], balances: AddressBalance[]): Promise<LpPosition[]> {
  const accs = [...new Set(accounts.map(a => a.toLowerCase()))].filter(a => /^0x[0-9a-f]{64}$/.test(a))
  if (!accs.length) return []
  const farmedByLp = new Map<number, bigint>()
  const fRes = await client.query({ query: `SELECT lp_asset_id, toString(sum(toInt256(principal_shares_raw))) AS shares FROM price_data.xyk_farm_principal_intervals FINAL WHERE account_id IN {accs:Array(String)} AND valid_to_block = 0 GROUP BY lp_asset_id`, query_params: { accs }, format: 'JSONEachRow' })
  for (const r of await fRes.json<{ lp_asset_id: number; shares: string }>()) farmedByLp.set(r.lp_asset_id, BigInt(r.shares || '0'))
  const directByLp = new Map<number, bigint>()
  for (const b of balances) directByLp.set(b.asset.assetId, (directByLp.get(b.asset.assetId) ?? 0n) + BigInt(b.total || '0'))
  const candidates = [...new Set([...directByLp.keys(), ...farmedByLp.keys()])]
  const [state, prices] = await Promise.all([loadXykCurrentState(candidates), ensureAccountValuePrices()])
  const out: LpPosition[] = []
  for (const [lp, st] of state) {
    for (const [shares, venue] of [[directByLp.get(lp) ?? 0n, 'XYK'], [farmedByLp.get(lp) ?? 0n, 'XYK Farm']] as const) {
      if (shares <= 0n) continue
      const { amountA, amountB } = xykShareLegs(shares, st.reserveA, st.reserveB, st.totalShares)
      const usdA = usdValue(prices, st.assetA, amountA.toString(), asset(st.assetA).decimals)
      const usdB = usdValue(prices, st.assetB, amountB.toString(), asset(st.assetB).decimals)
      const valueUsd = usdA == null || usdB == null ? null : usdA + usdB
      out.push({ positionId: `xyk:${lp}:${venue === 'XYK Farm' ? 'farm' : 'direct'}`, asset: asset(lp), amount: amountA.toString(), shares: shares.toString(), valueUsd, venue })
    }
  }
  return out.sort((x, y) => (y.valueUsd ?? 0) - (x.valueUsd ?? 0))
}

// Historical XYK principal for the value-history chart (Phase 2). For the account's LP holdings
// — direct wallet shareToken balances AND farm-deposit principal — this loads
// the per-bucket pool state needed to value each at NAV (reserves × shares / total supply).
// Total supply is the reconstructed step function; reserves are the sampled snapshot. All
// account/pool/asset-bounded. Callers combine direct + farmed shares and apply xykShareLegs.
export interface XykBucketState { assetA: number; assetB: number; reserveA: bigint; reserveB: bigint; totalShares: bigint }
export interface XykPrincipalHistory {
  lpAssetIds: Set<number>
  underlyingAssetIds: number[]
  stateByLp: Map<number, (XykBucketState | undefined)[]>
  farmSharesByLp: Map<number, bigint[]>
}
export async function loadXykPrincipalHistory(accounts: string[], candidateAssetIds: number[], minb: number, bucket: number, n: number): Promise<XykPrincipalHistory> {
  const empty: XykPrincipalHistory = { lpAssetIds: new Set(), underlyingAssetIds: [], stateByLp: new Map(), farmSharesByLp: new Map() }
  const accs = [...new Set(accounts.map(a => a.toLowerCase()))].filter(a => /^0x[0-9a-f]{64}$/.test(a))
  const maxb = minb + bucket * n
  const bucketEndBlock = (b: number) => Math.min(maxb, minb + (b + 1) * bucket - 1)

  // 1) Farm principal intervals → per (lp, bucket) summed active principal.
  const farmSharesByLp = new Map<number, bigint[]>()
  const farmedLps = new Set<number>()
  if (accs.length) {
    const fRes = await client.query({
      query: `SELECT lp_asset_id, principal_shares_raw, valid_from_block, valid_to_block
              FROM price_data.xyk_farm_principal_intervals FINAL
              WHERE account_id IN {accs:Array(String)} AND valid_from_block <= ${maxb} AND (valid_to_block = 0 OR valid_to_block >= ${minb})`,
      query_params: { accs }, format: 'JSONEachRow',
    })
    for (const r of await fRes.json<{ lp_asset_id: number; principal_shares_raw: string; valid_from_block: number; valid_to_block: number }>()) {
      farmedLps.add(r.lp_asset_id)
      if (!farmSharesByLp.has(r.lp_asset_id)) farmSharesByLp.set(r.lp_asset_id, new Array(n + 1).fill(0n))
      const arr = farmSharesByLp.get(r.lp_asset_id)!
      const principal = BigInt(r.principal_shares_raw || '0')
      for (let b = 0; b <= n; b++) { const be = bucketEndBlock(b); if (r.valid_from_block <= be && (r.valid_to_block === 0 || r.valid_to_block > be)) arr[b] += principal }
    }
  }

  // 2) Which candidate assets (+ farmed lps) are XYK LP tokens? → registry mapping.
  const lpCandidates = [...new Set([...candidateAssetIds, ...farmedLps])]
  if (!lpCandidates.length) return empty
  const rRes = await client.query({
    query: `SELECT lp_asset_id, pool_account, asset_a, asset_b FROM price_data.xyk_pool_registry FINAL WHERE lp_asset_id IN {lps:Array(Int32)}`,
    query_params: { lps: lpCandidates }, format: 'JSONEachRow',
  })
  const regRows = await rRes.json<{ lp_asset_id: number; pool_account: string; asset_a: number; asset_b: number }>()
  if (!regRows.length) return empty
  const lpAssetIds = new Set(regRows.map(r => r.lp_asset_id))
  const poolByLp = new Map(regRows.map(r => [r.lp_asset_id, r]))
  const pools = [...new Set(regRows.map(r => r.pool_account))]

  // 3) Reserves per (pool, bucket) — sampled, forward-filled (b=-1 carry-in). Carry the
  // snapshot's own asset order (aa/ab), taken from the SAME latest row as the reserves
  // (all argMax by block_height): it can differ from — and even flips across blocks
  // within — the registry's PoolCreated order, so reserves must be paired by it (step 5).
  const reserveByPoolBucket = new Map<string, ({ aa: number; ab: number; ra: bigint; rb: bigint } | undefined)[]>()
  {
    const resvRes = await client.query({
      query: `SELECT pool_account,
                toInt32(greatest(-1, least(${n}, intDiv(toInt64(block_height) - ${minb}, ${bucket})))) AS b,
                argMax(asset_a, block_height) AS aa, argMax(asset_b, block_height) AS ab,
                argMax(reserve_a_raw, block_height) AS ra, argMax(reserve_b_raw, block_height) AS rb
              FROM price_data.xyk_pool_reserve_history WHERE pool_account IN {pools:Array(String)} AND block_height <= ${maxb}
              GROUP BY pool_account, b ORDER BY pool_account, b`,
      query_params: { pools }, format: 'JSONEachRow',
    })
    const byPool = new Map<string, Map<number, { aa: number; ab: number; ra: bigint; rb: bigint }>>()
    for (const r of await resvRes.json<{ pool_account: string; b: number; aa: number; ab: number; ra: string; rb: string }>()) {
      if (!byPool.has(r.pool_account)) byPool.set(r.pool_account, new Map())
      byPool.get(r.pool_account)!.set(r.b, { aa: r.aa, ab: r.ab, ra: BigInt(r.ra || '0'), rb: BigInt(r.rb || '0') })
    }
    for (const pool of pools) {
      const per = byPool.get(pool) ?? new Map<number, { aa: number; ab: number; ra: bigint; rb: bigint }>()
      const arr: ({ aa: number; ab: number; ra: bigint; rb: bigint } | undefined)[] = new Array(n + 1).fill(undefined)
      let last = per.get(-1)
      for (let b = 0; b <= n; b++) { if (per.has(b)) last = per.get(b); arr[b] = last }
      reserveByPoolBucket.set(pool, arr)
    }
  }

  // 4) Total shares per (lp, bucket) — reconstructed step function, forward-filled.
  const totalByLpBucket = new Map<number, (bigint | undefined)[]>()
  {
    const tRes = await client.query({
      query: `SELECT lp_asset_id,
                toInt32(greatest(-1, least(${n}, intDiv(toInt64(block_height) - ${minb}, ${bucket})))) AS b,
                argMax(total_shares_raw, block_height) AS total
              FROM price_data.xyk_lp_total_shares_history WHERE lp_asset_id IN {lps:Array(Int32)} AND block_height <= ${maxb}
              GROUP BY lp_asset_id, b ORDER BY lp_asset_id, b`,
      query_params: { lps: [...lpAssetIds] }, format: 'JSONEachRow',
    })
    const byLp = new Map<number, Map<number, bigint>>()
    for (const r of await tRes.json<{ lp_asset_id: number; b: number; total: string }>()) {
      if (!byLp.has(r.lp_asset_id)) byLp.set(r.lp_asset_id, new Map())
      byLp.get(r.lp_asset_id)!.set(r.b, BigInt(r.total || '0'))
    }
    for (const lp of lpAssetIds) {
      const per = byLp.get(lp) ?? new Map<number, bigint>()
      const arr: (bigint | undefined)[] = new Array(n + 1).fill(undefined)
      let last = per.get(-1)
      for (let b = 0; b <= n; b++) { if (per.has(b)) last = per.get(b); arr[b] = last }
      totalByLpBucket.set(lp, arr)
    }
  }

  // 5) Assemble per-lp per-bucket state (only where reserves + positive total supply exist).
  const stateByLp = new Map<number, (XykBucketState | undefined)[]>()
  for (const lp of lpAssetIds) {
    const reg = poolByLp.get(lp)!
    const reserves = reserveByPoolBucket.get(reg.pool_account)
    const totals = totalByLpBucket.get(lp)
    const arr: (XykBucketState | undefined)[] = new Array(n + 1).fill(undefined)
    for (let b = 0; b <= n; b++) {
      const rv = reserves?.[b]; const ts = totals?.[b]
      if (rv && ts && ts > 0n) {
        // Pair each reserve with the asset it belongs to via the snapshot's own
        // (asset_a↔reserve_a) order; fall back to the registry order only for legacy
        // rows that predate the snapshot asset columns.
        const [assetA, assetB] = rv.aa > 0 && rv.ab > 0 ? [rv.aa, rv.ab] : [reg.asset_a, reg.asset_b]
        arr[b] = { assetA, assetB, reserveA: rv.ra, reserveB: rv.rb, totalShares: ts }
      }
    }
    stateByLp.set(lp, arr)
  }
  const underlyingAssetIds = [...new Set(regRows.flatMap(r => [r.asset_a, r.asset_b]))]
  return { lpAssetIds, underlyingAssetIds, stateByLp, farmSharesByLp }
}

// extrinsic by block-index (design routes #/extrinsic/h-i)
export async function getExtrinsicAt(height: number, index: number): Promise<ExtrinsicDetail | null> {
  return cached(`explorer:extrinsic-at:${height}:${index}`, 10000, async () => {
    const res = await client.query({
      query: `SELECT e.block_height AS block_height, e.extrinsic_index AS extrinsic_index, e.extrinsic_hash AS extrinsic_hash,
                     toString(e.block_timestamp) AS ts, e.version AS version,
                     coalesce(e.signer, e.effective_signer) AS signer, e.success AS success, e.call_name AS call_name,
                     e.fee AS fee, e.tip AS tip, e.call_args_json AS call_args_json, e.error_json AS error_json,
                     b.spec_version AS spec_version
              FROM price_data.raw_extrinsics e
              LEFT JOIN price_data.blocks b ON b.block_height = e.block_height
              WHERE e.block_height = {h:UInt32} AND e.extrinsic_index = {i:UInt32} LIMIT 1`,
      query_params: { h: height, i: index }, format: 'JSONEachRow',
    })
    const row = (await res.json<ExtrinsicDetailRow>())[0]
    return row ? hydrateExtrinsicDetail(row) : null
  })
}

// single event (block_height + event_index)
export interface EventDetail {
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  timestamp: string
  name: string
  args: unknown
  decoded: boolean
  phase: string
  extrinsic: ExtrinsicSummary | null
}
export async function getEventAt(height: number, index: number): Promise<EventDetail | null> {
  return cached(`explorer:event-at:${height}:${index}`, 10000, async () => {
    const res = await client.query({
      query: `SELECT block_height, event_index, extrinsic_index, toString(block_timestamp) AS ts, event_name, args_json
              FROM price_data.raw_events
              WHERE block_height = {h:UInt32} AND event_index = {i:UInt32} LIMIT 1`,
      query_params: { h: height, i: index }, format: 'JSONEachRow',
    })
    const e = (await res.json<{ block_height: number; event_index: number; extrinsic_index: number | null; ts: string; event_name: string; args_json: string }>())[0]
    if (!e) return null
    // Phase: an event tied to an extrinsic is in ApplyExtrinsic, otherwise it is
    // an Initialization/Finalization (system) event.
    const phase = e.extrinsic_index != null ? `ApplyExtrinsic(${e.extrinsic_index})` : 'Finalization'
    const extrinsic = e.extrinsic_index != null ? await getExtrinsicSummaryAt(e.block_height, e.extrinsic_index) : null
    return {
      blockHeight: e.block_height, eventIndex: e.event_index, extrinsicIndex: e.extrinsic_index, timestamp: e.ts,
      name: e.event_name, args: safeJson(e.args_json), decoded: false, phase, extrinsic,
    }
  })
}

// Lightweight extrinsic summary (no event list) for embedding in an event detail.
async function getExtrinsicSummaryAt(height: number, index: number): Promise<ExtrinsicSummary | null> {
  const res = await client.query({
    query: `SELECT block_height, extrinsic_index, extrinsic_hash, toString(block_timestamp) AS ts, signer, success, call_name, fee
            FROM price_data.raw_extrinsics WHERE block_height = {h:UInt32} AND extrinsic_index = {i:UInt32} LIMIT 1`,
    query_params: { h: height, i: index }, format: 'JSONEachRow',
  })
  const row = (await res.json<ExtrinsicSummaryRow>())[0]
  return row ? extrinsicSummary(row) : null
}

// assets registry with prices + total value on chain
export type ExplorerAssetType = 'Native' | 'Derivative' | 'Token'
export interface AssetListItem extends AssetRef { price: number | null; change24h: number | null; type: ExplorerAssetType; amountUsd: number | null; holderCount?: number }

function explorerAssetType(asset: AssetRef): ExplorerAssetType {
  if (asset.assetId === 0) return 'Native'
  return isXykShareToken(asset.assetId) || asset.symbol.startsWith('v')
    ? 'Derivative'
    : 'Token'
}

// Total raw balance per asset across all indexed accounts. Mirrors holder-list
// balance semantics: use the current latest balance only. Older non-zero
// observations are historical and must not resurrect current zero-balance holders.
async function getAssetTotals(): Promise<Map<number, bigint>> {
  return cached('explorer:asset-totals', 60000, async () => {
    const res = await client.query({
      query: `
        SELECT asset_id, toString(sum(bal)) AS raw FROM (
          SELECT account_id, asset_id, toUInt256OrZero(argMaxMerge(total_state)) AS bal
          FROM price_data.account_asset_latest_balances
          GROUP BY account_id, asset_id
        ) GROUP BY asset_id`,
      format: 'JSONEachRow',
    })
    const m = new Map<number, bigint>()
    for (const r of await res.json<{ asset_id: string; raw: string }>()) m.set(parseInt(r.asset_id, 10), BigInt(r.raw || '0'))
    return m
  })
}

export async function getAssetHolderCounts(): Promise<Map<number, number>> {
  return cached('explorer:asset-holder-counts', 60000, async () => {
    const res = await client.query({
      query: `
        SELECT asset_id, count() AS n FROM (
          SELECT account_id, asset_id, sum(bal) AS total_bal FROM (
            SELECT account_id, asset_id, toUInt256OrZero(argMaxMerge(total_state)) AS bal
            FROM price_data.account_asset_latest_balances
            GROUP BY account_id, asset_id
          )
          GROUP BY account_id, asset_id
          HAVING total_bal > 0
        )
        GROUP BY asset_id`,
      format: 'JSONEachRow',
    })
    const m = new Map<number, number>()
    for (const r of await res.json<{ asset_id: string; n: string | number }>()) m.set(parseInt(r.asset_id, 10), Number(r.n))
    return m
  })
}

// 7-day price samples per asset (oldest→newest) for the assets-list sparkline
// + 7D change. One bounded query over the last 7 days of blocks — no FINAL on
// the 485M-row prices table (cf. the perf rule).
//
// The window and the buckets are both wall-clock: the cutoff height comes from
// cutoffHeightForWindow (so "7 days" stays 7 days as block time changes) and
// the buckets are 4-hour timestamp intervals rather than a fixed 2400-block
// stride. The height predicate stays — it is what prunes the scan, since
// `prices` sorts by (asset_id, block_height) and partitions on a block-height
// expression, so a timestamp bound alone would read the whole table.
export const SPARKLINE_WINDOW_HOURS = 168
export const SPARKLINE_BUCKET_HOURS = 4
// 168h / 4h. The window's edges do not align to the bucket grid, so the query
// can return one extra partial bucket; the newest SPARKLINE_BUCKETS are kept so
// the series length never exceeds what the list has always rendered (the
// 2400-block stride this replaced produced exactly 42 buckets).
export const SPARKLINE_BUCKETS = SPARKLINE_WINDOW_HOURS / SPARKLINE_BUCKET_HOURS
async function getWeeklyPriceSamples(): Promise<Map<number, number[]>> {
  return cached('explorer:price-samples-7d', 60000, async () => {
    const m = new Map<number, number[]>()
    try {
      const head = await latestPriceBlock()
      if (!head) return m
      const weekStart = await cutoffHeightForWindow(SPARKLINE_WINDOW_HOURS, head)
      const res = await client.query({
        query: `
          SELECT asset_id, toStartOfInterval(block_timestamp, INTERVAL ${SPARKLINE_BUCKET_HOURS} HOUR) AS bucket,
            toFloat64(argMax(usd_price, block_height)) AS px
          FROM price_data.prices
          WHERE block_height > {weekStart:UInt32} AND block_height <= {head:UInt32} AND usd_price > 0
          GROUP BY asset_id, bucket
          ORDER BY asset_id, bucket`,
        query_params: { head, weekStart },
        format: 'JSONEachRow',
      })
      for (const r of await res.json<{ asset_id: number; bucket: string; px: number }>()) {
        const arr = m.get(r.asset_id) ?? []
        arr.push(r.px) // ordered oldest → newest by the bucket timestamp
        m.set(r.asset_id, arr)
      }
      for (const [assetId, arr] of m) {
        if (arr.length > SPARKLINE_BUCKETS) m.set(assetId, arr.slice(-SPARKLINE_BUCKETS))
      }
    } catch { /* prices may be unavailable */ }
    return m
  })
}

export async function getAssets(): Promise<AssetListItem[]> {
  return cached('explorer:assets-list', 30000, async () => {
    const [prices, totals, holderCounts, samples] = await Promise.all([ensurePrices(), getAssetTotals(), getAssetHolderCounts(), getWeeklyPriceSamples()])
    return allExplorerAssets()
      .filter(a => !isXykShareToken(a.assetId) && !a.symbol.startsWith('Asset') && a.symbol.trim() !== '')
      .map(a => {
        const p = prices.get(a.assetId)
        const type = explorerAssetType(a)
        const raw = totals.get(a.assetId) ?? 0n
        const amountUsd = p ? (Number(raw) / 10 ** a.decimals) * p.price : null
        const holderCount = holderCounts.get(a.assetId)
        const spark = samples.get(a.assetId)
        const change7d = spark && spark.length >= 2 && spark[0] > 0 ? (spark[spark.length - 1] - spark[0]) / spark[0] : null
        return { ...a, price: p?.price ?? null, change24h: p?.change24h ?? null, change7d, type, amountUsd, holderCount, sparkline: spark }
      })
      // Default ordering: total value held on Basilisk, descending.
      .sort((x, y) => (y.amountUsd ?? 0) - (x.amountUsd ?? 0) || (y.price ?? 0) - (x.price ?? 0))
  })
}

// What the activity token filter shows and searches on — nothing else. It is a
// projection of the same cached directory, so the option list and its value-ranked
// ordering are identical to the full payload's; it just leaves behind the totals,
// holder counts and weekly sparklines (57% of 74 kB) the combo never reads.
// `price` rides along (one number per row) because a price-alert form has to be
// able to say what the token costs right now, and re-fetching the full directory
// — or one asset detail — to learn one number would cost far more than this.
export interface AssetFilterItem { assetId: number; symbol: string; name: string | null; price: number | null }
export async function getAssetFilterOptions(): Promise<AssetFilterItem[]> {
  return (await getAssets()).map(a => ({ assetId: a.assetId, symbol: a.symbol, name: a.name, price: a.price }))
}

// The pallet.call and pallet.Event names actually present in the indexed data, so
// a filter box and an alert form can OFFER names instead of asking to be told one.
//
// Read from exactly the two tables the notification matchers window over
// (`raw_extrinsics.call_name`, `raw_events.event_name`) — a suggestion the
// matcher cannot match would be worse than no suggestion at all. Both columns
// are LowCardinality and both tables are `ORDER BY (block_height, …)`, so the
// distinct is a dictionary read over a primary-key range rather than a scan: the
// window is the last FILTER_NAME_WINDOW_BLOCKS blocks (≈2 months at 6s), which
// bounds the read AND is what makes the list current — a pallet removed by a
// runtime upgrade stops being offered instead of being suggested forever.
export interface FilterNames { calls: string[]; events: string[] }
const FILTER_NAME_WINDOW_BLOCKS = 1_000_000
const FILTER_NAME_CACHE_MS = 3_600_000

async function distinctNames(table: string, column: string): Promise<string[]> {
  const res = await client.query({
    // max(block_height) over the sort-key prefix is a part-metadata read, so the
    // window resolves without a scan of its own.
    query: `SELECT DISTINCT ${column} AS name
            FROM price_data.${table}
            WHERE block_height > (SELECT max(block_height) FROM price_data.${table}) - {window:UInt32}
            ORDER BY name`,
    query_params: { window: FILTER_NAME_WINDOW_BLOCKS },
    format: 'JSONEachRow',
  })
  return (await res.json<{ name: string }>()).map(r => r.name).filter(Boolean)
}

export async function getFilterNames(): Promise<FilterNames> {
  return cached('explorer:filter-names', FILTER_NAME_CACHE_MS, async () => {
    const [calls, events] = await Promise.all([
      distinctNames('raw_extrinsics', 'call_name'),
      distinctNames('raw_events', 'event_name'),
    ])
    return { calls, events }
  })
}


// events
export interface EventRow {
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  timestamp: string
  name: string
  args: unknown
  decoded: boolean
}
interface EventSourceRow {
  block_height: number
  event_index: number
  extrinsic_index: number | null
  ts: string
  event_name: string
  args_json: string
}

function eventRow(row: EventSourceRow): EventRow {
  return {
    blockHeight: row.block_height,
    eventIndex: row.event_index,
    extrinsicIndex: row.extrinsic_index,
    timestamp: row.ts,
    name: row.event_name,
    args: safeJson(row.args_json),
    decoded: false,
  }
}

function uniqueEventRows(rows: EventSourceRow[]): EventRow[] {
  const seen = new Set<string>()
  return rows.flatMap(row => {
    const key = `${row.block_height}:${row.event_index}`
    if (seen.has(key)) return []
    seen.add(key)
    return [eventRow(row)]
  })
}
export async function getRecentEvents(limit: number, from?: string, to?: string, offset = 0, filters: EventListFilters = {}): Promise<EventRow[]> {
  const tw = timeWindow(from, to)
  return cached(`explorer:events:${await liveHeadTag(Boolean(tw), datedWindowIsClosed(to))}:${limit}:${offset}:${from ?? ''}:${to ?? ''}:${filterKey(filters)}`, tw ? 30000 : LIVE_CACHE_MS, async () => {
    const eventFilter = filters.event?.trim() ? textNameFilter('event_name', 'eventName') : ''
    const rows = await withFeedWindow(tw, limit, offset + limit, async (bound) => {
      // A page cut by OFFSET reads every skipped row too, and args_json is ZSTD(6) —
      // the feed's whole weight. Locate the page on the sort key alone, then read the
      // payload for the page's own keys: at the pager's deepest offset (20M) that is
      // 78 ms / 177 MiB against 2,478 ms / 5.19 GiB / 765 MiB peak for the same rows.
      // (block_height, event_index) IS the table's ORDER BY, so the payload pass
      // returns exactly the key pass's rows and the re-stated ORDER BY reproduces its
      // order. Duplicated replacement rows are still deduped by uniqueEventRows, as
      // they were when one read carried both steps.
      const keyRes = await client.query({
        query: `
          SELECT block_height, event_index
          FROM price_data.raw_events
          WHERE ${bound}
            ${eventFilter}
          ORDER BY block_height DESC, event_index DESC
          LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
        query_params: { limit, offset, ...textNameParams('eventName', filters.event) }, format: 'JSONEachRow',
      })
      const keys = await keyRes.json<{ block_height: number; event_index: number }>()
      if (!keys.length) return []
      const tuples = [...new Set(keys.map(key => `(${key.block_height},${key.event_index})`))].join(',')
      const res = await client.query({
        query: `
          SELECT block_height, event_index, extrinsic_index, toString(block_timestamp) AS ts, event_name, args_json
          FROM price_data.raw_events
          WHERE (block_height, event_index) IN (${tuples})
            ${eventFilter}
          ORDER BY block_height DESC, event_index DESC`,
        query_params: { ...textNameParams('eventName', filters.event) }, format: 'JSONEachRow',
      })
      return res.json<EventSourceRow>()
    })
    return uniqueEventRows(rows)
  })
}

// trades (swaps)
export interface TradeRow {
  blockHeight: number
  timestamp: string
  eventIndex: number
  extrinsicIndex: number | null
  who: AccountRef | null
  assetIn: AssetRef
  assetOut: AssetRef
  amountIn: string
  amountOut: string
  valueUsd: number | null
  venue: string
  // The extrinsic a trade should link to. Null → link to block.
  linkBlock: number | null
  linkIndex: number | null
}
export interface RawSwapEventRow {
  block_height: number
  ts: string
  event_index: number
  extrinsic_index: number | null
  event_name: string
  who: string
  asset_in: number
  asset_out: number
  amount_in: string
  amount_out: string
}

// One trade per ROUTE, not per extrinsic.
//
// The router emits a route's hop events as it executes them and then its net
// summary, so a net event closes the run of hops before it: [5→25][25→10] then
// Router.Executed 5→10 is one trade, and a hop belongs to the first net event at or
// after it. That is what lets several routes share an extrinsic: a batch dispatching
// two Router.sells emits two such runs and is two trades.
//
// Keying the group by the extrinsic instead collapsed them and kept only the first —
// 52,700 trades chain-wide, including a proxied multisig batch whose $79.7k HUSDT
// leg appeared on no surface at all, and arbitrage triangles that showed one leg of
// three. The hops cannot simply be dropped instead: outside the router pallet's own
// account they carry the USER's `who` (102k XYK legs), so they would each surface as
// a trade of their own.
//
// Rows after the last net event have nothing to close them, so they stay one group
// per extrinsic — the conservative reading, since a pre-rename multi-hop route and
// two genuinely separate pool swaps are indistinguishable once no summary is emitted.
// The net event that closes the route an event belongs to: the first one at or after
// it. Ascending `netIndices`.
export function closingNetEvent(netIndices: number[], eventIndex: number): number | undefined {
  return netIndices.find(i => i >= eventIndex)
}

// Where a route's own events start: after the net event of the route before it, so a
// detail page can slice one route out of a batch. Exclusive; -1 when it is the first.
export function routeStartAfter(netIndices: number[], netEvent: number): number {
  const before = netIndices.filter(i => i < netEvent)
  return before.length ? before[before.length - 1] : -1
}

// The routes of ONE extrinsic's swap events, ascending, by the same boundary the feed
// groups on: a net event closes the run before it, and a trailing run with no net
// event of its own is a route too. Surfaces that read a single extrinsic's events
// (the extrinsic page, the block page) split them with this instead of keeping only
// the first route.
// How a trade row is identified when successive fetch windows are deduplicated.
//
// A route closed by a net event is identified BY that event, so the two routes of one
// batch are two rows: keying on the extrinsic deduped the second away, which is how a
// $79.7k swap stayed missing from /activity?min=5000 after the feed itself was fixed.
//
// A trailing run has no net event to anchor it, and its representative shifts when a
// window splits the extrinsic, so it stays keyed per extrinsic — one row rather than a
// duplicate, which is what the extrinsic-wide key got right.
export function tradeRowKey(row: { blockHeight: number; extrinsicIndex: number | null; eventIndex: number; venue: string }): string {
  if (row.extrinsicIndex == null) return `${row.blockHeight}:e${row.eventIndex}`
  const extrinsic = `${row.blockHeight}:x${row.extrinsicIndex}`
  return row.venue === 'Router' ? `${extrinsic}:r${row.eventIndex}` : `${extrinsic}:tail`
}

export function routeGroups<T extends { event_index: number; event_name: string }>(events: T[]): T[][] {
  const ordered = [...events].sort((l, r) => l.event_index - r.event_index)
  const nets = ordered.filter(e => isRouterNet(e.event_name)).map(e => e.event_index)
  const groups = new Map<number | 'tail', T[]>()
  const order: (number | 'tail')[] = []
  for (const e of ordered) {
    const key = closingNetEvent(nets, e.event_index) ?? 'tail'
    if (!groups.has(key)) { groups.set(key, []); order.push(key) }
    groups.get(key)!.push(e)
  }
  return order.map(k => groups.get(k)!)
}

// The fields grouping a swap event into its route needs. Kept structural so the
// account feed's rows (which carry `signer` where the asset feed's carry `who`) group
// through the same code rather than a parallel copy of it.
export interface SwapGroupRow {
  block_height: number
  extrinsic_index: number | null
  event_index: number
  event_name: string
}

export function swapGroupKey(row: SwapGroupRow, netEventsByExtrinsic: Map<string, number[]>): string {
  if (row.extrinsic_index == null) return `${row.block_height}:e${row.event_index}`
  const extrinsic = `${row.block_height}:x${row.extrinsic_index}`
  const nets = netEventsByExtrinsic.get(`${row.block_height}:${row.extrinsic_index}`) ?? []
  const closing = closingNetEvent(nets, row.event_index)
  return closing != null ? `${extrinsic}:r${closing}` : `${extrinsic}:tail`
}

export function groupSwapRows<T extends SwapGroupRow>(rows: T[]): { groups: Map<string, T[]>; order: string[] } {
  // The net events of each extrinsic, ascending, so a row can find the one that
  // closes it. The feed reads rows newest-first, so this cannot rely on input order.
  const netEventsByExtrinsic = new Map<string, number[]>()
  for (const row of rows) {
    if (row.extrinsic_index == null || !isRouterNet(row.event_name)) continue
    const key = `${row.block_height}:${row.extrinsic_index}`
    const at = netEventsByExtrinsic.get(key) ?? []
    at.push(row.event_index)
    netEventsByExtrinsic.set(key, at)
  }
  for (const indices of netEventsByExtrinsic.values()) indices.sort((l, r) => l - r)
  const groups = new Map<string, T[]>()
  const order: string[] = []
  for (const row of rows) {
    const key = swapGroupKey(row, netEventsByExtrinsic)
    if (!groups.has(key)) {
      groups.set(key, [])
      order.push(key)
    }
    groups.get(key)!.push(row)
  }
  return { groups, order }
}

// The one swap event that stands for each route, in the order the rows arrived — the
// shared basis every trade feed builds its rows from, so none of them can disagree
// about how many trades an extrinsic held.
//
// A route is represented by its Router net summary, which carries the user's real
// assets and amounts rather than an intermediate hop's. `prefer` narrows that to a
// summary the caller can use (the asset feed wants one that touches the asset whose
// page it is); the leading row stands in when no summary qualifies, which is also
// what a pre-rename route and a direct pool swap fall back to.
export function swapRouteReps<T extends SwapGroupRow>(rows: T[], prefer: (row: T) => boolean = () => true): T[] {
  const { groups, order } = groupSwapRows(rows)
  return order.map(key => {
    const group = groups.get(key)!
    return group.find(row => isRouterNet(row.event_name) && prefer(row)) ?? group[0]
  })
}

// activity_histogram_events.activity_index identifies a swap by its extrinsic (so a
// router hop and its pool leg count as one activity) and every other row by its
// event index — two identity spaces sharing one integer. Deduplicating on the
// number alone merges a swap in extrinsic N with an unrelated event at index N in
// the same block, so the space belongs in the key. This list must stay identical to
// the swap-event list in clickhouse/schema/003_materialized_views.sql.
const HISTOGRAM_SWAP_EVENTS_SQL = `'Router.Executed','XYK.SellExecuted','XYK.BuyExecuted','LBP.SellExecuted','LBP.BuyExecuted'`
const SWAP_EVENTS = ['Router.Executed', 'Router.RouteExecuted', 'XYK.SellExecuted', 'XYK.BuyExecuted', 'LBP.SellExecuted', 'LBP.BuyExecuted']
// The router's net-trade summary was emitted as Router.RouteExecuted before the
// pallet renamed it to Router.Executed (block ~4,542,080); both carry the same
// {assetIn, assetOut, amountIn, amountOut} args and an empty `who`.
const ROUTER_NET_EVENTS_SQL = `'Router.Executed','Router.RouteExecuted'`
function isRouterNet(eventName: string): boolean {
  return eventName === 'Router.Executed' || eventName === 'Router.RouteExecuted'
}
// The route-executor pallet account ("modlrouterex"). Per-hop AMM events of a routed
// swap are emitted with who=routerex; they're internal legs, not standalone trades —
// the net is captured by the accompanying Router.Executed (who=''). Exclude these hops
// so a multi-hop swap shows as ONE net trade, not one per leg.
const ROUTER_PALLET_ACCT = '0x6d6f646c726f7574657265780000000000000000000000000000000000000000'
const NOT_ROUTER_HOP = `AND JSONExtractString(args_json,'who') != '${ROUTER_PALLET_ACCT}'`
function positiveAccountVolumes(rows: Array<{ account_id: string; volume_usd: number }>): Map<string, number> {
  const volumes = new Map<string, number>()
  for (const row of rows) {
    if (row.volume_usd > 0) volumes.set(row.account_id, Number(row.volume_usd))
  }
  return volumes
}

async function tradingVolumeByAccount(accounts: string[]): Promise<Map<string, number>> {
  const safe = [...new Set(accounts.map(a => a.toLowerCase()).filter(a => ACCOUNT_RE.test(a)))]
  if (!safe.length) return new Map()
  const list = sqlAccountList(safe)
  const src = accountVolumeSource()
  const res = await client.query({
    query: `
      SELECT account AS account_id, toFloat64(sum(${src.col})) AS volume_usd
      FROM ${src.table}
      WHERE account IN (${list})
      GROUP BY account_id`,
    format: 'JSONEachRow',
  })
  return positiveAccountVolumes(await res.json<{ account_id: string; volume_usd: number }>())
}

// ---- protocol revenue breakdown (the Protocol Revenue detail tab) ----

// One trade per extrinsic (or per event for pallet-internal swaps), summarizing
// all hops/legs. A routed swap emits Router.Executed (net in→out) plus per-hop
// AMM events and many transfer legs (pool/fee/referral) — we keep just the net
// trade and attribute it to the extrinsic signer (or the AMM `who` when unsigned).
async function getRecentTrades(limit: number, from?: string, to?: string, offset = 0, filters: ValueListFilters = {}): Promise<TradeRow[]> {
  const tw = timeWindow(from, to)
  return cached(`explorer:trades:${await liveHeadTag(Boolean(tw), datedWindowIsClosed(to))}:${limit}:${offset}:${from ?? ''}:${to ?? ''}:${filterKey(filters)}`, tw ? 30000 : LIVE_CACHE_MS, async () => {
    const prices = await ensurePrices()
    const names = SWAP_EVENTS.map(n => `'${n}'`).join(',')
    const tokenIds = assetIdsForToken(filters.token)
    const useAssetSwapReadModel = tokenIds != null
    const swapTable = useAssetSwapReadModel ? 'asset_swap_activity' : 'swap_activity'
    const tokenFilter = tokenIds == null ? '' : tokenIds.length
      ? `AND asset_id IN (${tokenIds.join(',')})`
      : 'AND 0'
    const tokenRefsFilter = ''
    const assetOutExpr = 'asset_out'
    const amountOutExpr = 'amount_out'
    const postUsdFilter = filters.min != null && filters.unit !== 'token'
    const amountFilter = eventValueFilterSql(assetOutExpr, amountOutExpr, 'block_timestamp',
      postUsdFilter ? { ...filters, min: undefined, unit: undefined } : filters, prices, 'trade_price')
    const notRouterHop = `AND who != '${ROUTER_PALLET_ACCT}'`
    const want = offset + limit
    // Several swap events can collapse into one user trade (a batch extrinsic's
    // swaps, an old multi-hop route), so the scan over-fetches. Measured over the
    // whole swap_activity table that amplification is 1.16 raw events per grouped
    // trade (worst year 1.29), so the ×8 headroom only ever matters for small
    // pages — while a wide candidate window multiplied straight past the client's
    // result guard and failed the request with a ClickHouse 500. Clamping to the
    // guard leaves ≥ 2× headroom at every window the activity feed asks for, and
    // a scan that genuinely does not reach `want` is still reported below.
    const scanLimit = Math.min(Math.max(want * 8, 200), MAX_QUERY_RESULT_ROWS)
    const fetchRaw = async (bound: string, pageLimit: number): Promise<RawSwapEventRow[]> => {
      const res = await client.query({
        query: `
          SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name,
            who AS who,
            asset_in AS asset_in,
            asset_out AS asset_out,
            amount_in AS amount_in,
            amount_out AS amount_out
          FROM price_data.${swapTable}
          ${amountFilter.joinSql}
          WHERE ${bound} AND event_name IN (${names}) ${notRouterHop}
            ${tokenRefsFilter}
            ${tokenFilter}
            ${amountFilter.predicateSql}
          ORDER BY block_height DESC, event_index DESC
          LIMIT {limit:UInt32}`,
        query_params: { limit: pageLimit }, format: 'JSONEachRow',
      })
      return res.json<RawSwapEventRow>()
    }
    const buildRows = async (rows: RawSwapEventRow[], maxRows?: number): Promise<TradeRow[]> => {
      if (!rows.length) return []
      // One row per route, represented by its Router.Executed net summary rather than
      // an individual AMM hop event.
      const pairs = rows.map(r => [r.block_height, r.extrinsic_index] as [number, number | null])
      const signers = await actorsFor(pairs)
      const out: TradeRow[] = []
      for (const rep of swapRouteReps(rows)) {
        if (maxRows != null && out.length >= maxRows) break
        const venue = rep.event_name.split('.')[0]
        const signer = rep.extrinsic_index != null ? signers.get(`${rep.block_height}:${rep.extrinsic_index}`) : undefined
        const actor = signer ?? (rep.who && ACCOUNT_RE.test(rep.who) ? rep.who : null)
        const aOut = asset(rep.asset_out)
        out.push({
          blockHeight: rep.block_height, timestamp: rep.ts, eventIndex: rep.event_index, extrinsicIndex: rep.extrinsic_index,
          who: actor ? accountRef(actor) : null,
          assetIn: asset(rep.asset_in), assetOut: aOut, amountIn: rep.amount_in, amountOut: rep.amount_out,
          valueUsd: usdValue(prices, aOut.assetId, rep.amount_out, aOut.decimals),
          venue: venue === 'Router' ? 'Router' : venue,
          linkBlock: rep.extrinsic_index != null ? rep.block_height : null,
          linkIndex: rep.extrinsic_index,
        })
      }
      await attachHookSwapActors(out)
      await applyHistoricalUsd(out, tradeHistPick)
      return out
    }
    if (postUsdFilter) {
      let pageState: { scanned: number; cursor: { blockHeight: number; eventIndex: number } | null } = { scanned: 0, cursor: null }
      const deep = await fetchFilteredDeep(tw, want, async (bound, pageLimit) => {
        let raw = await fetchRaw(bound, pageLimit)
        pageState = {
          scanned: raw.length,
          cursor: raw.length ? { blockHeight: raw.at(-1)!.block_height, eventIndex: raw.at(-1)!.event_index } : null,
        }
        // A cursor page may split the swap events of its last extrinsic. Complete
        // that boundary block and advance past the whole block so grouping stays
        // identical to the unpaged feed.
        if (raw.length >= pageLimit) {
          const boundary = raw.at(-1)!.block_height
          const boundaryRows = await fetchRaw(`(${tw ?? '1'}) AND block_height = ${boundary}`, 25_000)
          const byEvent = new Map(raw.map(row => [`${row.block_height}:${row.event_index}`, row]))
          for (const row of boundaryRows) byEvent.set(`${row.block_height}:${row.event_index}`, row)
          raw = [...byEvent.values()].sort((a, b) => b.block_height - a.block_height || b.event_index - a.event_index)
          pageState.cursor = { blockHeight: boundary, eventIndex: 0 }
        }
        return buildRows(raw)
      }, row => rowMeetsExactUsdMinimum(row, filters.min!),
      row => row.blockHeight, row => row.eventIndex,
      tradeRowKey,
      { pageSize: 25_000, pageState: () => pageState })
      return deep.slice(offset, offset + limit)
    }
    const rows = await withFeedWindow(tw, scanLimit, scanLimit, bound => fetchRaw(bound, scanLimit))
    const out = await buildRows(rows, want)
    if (out.length < want && rows.length >= scanLimit) throw activityQueryTooBroad()
    return out.slice(offset, offset + limit)
  })
}

// trade detail
// One user trade = the swap events of one extrinsic: a routed swap has a
// Router.Executed net summary plus per-hop AMM events; a direct AMM call has a
// single *Executed event. The call args carry the route and the slippage limit.

export interface SwapAmounts { assetIn: number; assetOut: number; amountIn: string; amountOut: string }
// The AMM pallets name their amounts amount/salePrice (sell) and amount/buyPrice
// (buy); everything else uses amountIn/amountOut. The two buy events share those
// field names and mean the OPPOSITE by them: XYK.BuyExecuted is (amount =
// received, buyPrice = paid), LBP.BuyExecuted is (amount = paid, buyPrice =
// received). Verified against the Router.RouteExecuted of the same extrinsic
// across the legacy era (see the note above the legacy legs in
// accountTradeVolume.ts), so the buy branch splits by pallet. Reading an LBP buy
// with XYK's order swaps the trade's two sides, and since the assets rarely share
// decimals the error is unbounded rather than a rounding slip.
export function swapEventAmounts(name: string, args: Record<string, unknown>): SwapAmounts {
  const s = (v: unknown) => typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
  const n = (v: unknown) => Number(v ?? NaN)
  const base = { assetIn: n(args.assetIn), assetOut: n(args.assetOut) }
  if (name === 'XYK.SellExecuted' || name === 'LBP.SellExecuted') return { ...base, amountIn: s(args.amount), amountOut: s(args.salePrice) }
  if (name === 'XYK.BuyExecuted') return { ...base, amountIn: s(args.buyPrice), amountOut: s(args.amount) }
  if (name === 'LBP.BuyExecuted') return { ...base, amountIn: s(args.amount), amountOut: s(args.buyPrice) }
  return { ...base, amountIn: s(args.amountIn), amountOut: s(args.amountOut) }
}

export interface TradeLimitSpec { kind: 'minReceived' | 'maxPaid'; amount: string; assetId: number }
// The slippage-protection limit of a swap call. XYK's `maxLimit` arg is the
// min-received on sell and the max-paid on buy (pallet quirk).
export function parseTradeLimit(callName: string, args: Record<string, unknown>): TradeLimitSpec | null {
  const s = (v: unknown) => typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null
  const n = (v: unknown) => typeof v === 'number' ? v : null
  const minReceived = (amount: string | null) => amount != null && n(args.assetOut) != null ? { kind: 'minReceived' as const, amount, assetId: n(args.assetOut)! } : null
  const maxPaid = (amount: string | null) => amount != null && n(args.assetIn) != null ? { kind: 'maxPaid' as const, amount, assetId: n(args.assetIn)! } : null
  switch (callName) {
    case 'Router.sell': case 'Router.sell_all': return minReceived(s(args.minAmountOut))
    case 'Router.buy': return maxPaid(s(args.maxAmountIn))
    case 'XYK.sell': return minReceived(s(args.maxLimit) ?? s(args.minBought))
    case 'XYK.buy': return maxPaid(s(args.maxLimit) ?? s(args.maxSold))
    default: return null
  }
}

// Route hops from a Router call's args ([] for direct AMM calls / wrapped calls).
export function parseRouteHops(args: Record<string, unknown>): { pool: string; poolId: number | null; assetIn: number; assetOut: number }[] {
  const route = Array.isArray(args.route) ? args.route as Record<string, unknown>[] : []
  return route.map(h => {
    const pool = h.pool as Record<string, unknown> | string | undefined
    const kind = typeof pool === 'object' && pool ? String(pool.__kind ?? 'Pool') : typeof pool === 'string' ? pool : 'Pool'
    const poolId = typeof pool === 'object' && pool && typeof pool.value === 'number' ? pool.value as number : null
    return { pool: kind, poolId, assetIn: Number(h.assetIn), assetOut: Number(h.assetOut) }
  }).filter(h => Number.isFinite(h.assetIn) && Number.isFinite(h.assetOut))
}

// Headroom between the executed amount and the protection limit, in percent:
// how far above the min-received floor / under the max-paid ceiling the trade
// landed. Null when no meaningful limit was set (0 = unprotected).
export function limitMarginPct(kind: 'minReceived' | 'maxPaid', limitAmount: string, executed: string): number | null {
  const lim = Number(limitAmount), ex = Number(executed)
  if (!(lim > 0) || !(ex > 0)) return null
  return kind === 'minReceived' ? (ex - lim) / lim * 100 : (lim - ex) / lim * 100
}

export interface TradeHop {
  pool: string
  poolId: number | null
  assetIn: AssetRef
  assetOut: AssetRef
  amountIn: string | null   // executed amounts when the hop emitted an event
  amountOut: string | null  // (Aave wrap hops don't)
  fee: { amount: string; asset: AssetRef } | null
}
export interface TradeDetail {
  blockHeight: number
  timestamp: string
  extrinsicIndex: number | null
  eventIndex: number | null
  hash: string | null
  success: boolean
  who: AccountRef | null
  venue: string
  direction: 'Sell' | 'Buy'
  assetIn: AssetRef
  assetOut: AssetRef
  amountIn: string
  amountOut: string
  valueUsd: number | null
  executionPrice: number | null   // assetOut per 1 assetIn
  limit: { kind: 'minReceived' | 'maxPaid'; amount: string; asset: AssetRef; marginPct: number | null } | null
  extrinsicFee: string | null
  extrinsicTip: string | null
  // Set when the fee did not settle in BSX; show this instead of `extrinsicFee`
  // and `extrinsicTip`, whose tip slot it carries as `tipAmount`.
  feePayment?: FeePayment
  route: TradeHop[]
}

function tradeHopFee(name: string, args: Record<string, unknown>, outId: number): TradeHop['fee'] {
  const sv = (v: unknown) => (typeof v === 'string' && v !== '0') ? v : null
  if (name.startsWith('XYK.') || name.startsWith('LBP.')) {
    const amt = sv(args.feeAmount); const fa = Number(args.feeAsset)
    return amt && Number.isFinite(fa) ? { amount: amt, asset: asset(fa) } : null
  }
  const amt = sv(args.fee)
  return amt ? { amount: amt, asset: asset(outId) } : null
}

function syntheticRoutePool(): string {
  return 'Router'
}

function swapEventToHop(e: { name: string; args: Record<string, unknown> }): TradeHop {
  const a = swapEventAmounts(e.name, e.args)
  return {
    pool: e.name.split('.')[0],
    poolId: typeof e.args.poolId === 'number' ? e.args.poolId : null,
    assetIn: asset(a.assetIn),
    assetOut: asset(a.assetOut),
    amountIn: a.amountIn || null,
    amountOut: a.amountOut || null,
    fee: tradeHopFee(e.name, e.args, a.assetOut),
  }
}

async function inferredRouterRoute(height: number, eventIndex: number, netAmts: SwapAmounts): Promise<TradeHop[]> {
  const names = SWAP_EVENTS.filter(n => !isRouterNet(n)).map(n => `'${n}'`).join(',')
  const res = await client.query({
    query: `
      WITH (
        SELECT ifNull(max(event_index), -1) AS idx
        FROM price_data.raw_events
        WHERE block_height = {h:UInt32} AND event_index < {e:UInt32} AND event_name IN (${ROUTER_NET_EVENTS_SQL})
      ) AS prev_router
      SELECT event_index, event_name, args_json
      FROM price_data.raw_events
      WHERE block_height = {h:UInt32}
        AND event_index > prev_router
        AND event_index < {e:UInt32}
        AND event_name IN (${names})
        AND JSONExtractString(args_json, 'who') = '${ROUTER_PALLET_ACCT}'
      ORDER BY event_index ASC`,
    query_params: { h: height, e: eventIndex }, format: 'JSONEachRow',
  })
  const rows = await res.json<{ event_index: number; event_name: string; args_json: string }>()
  const route = rows.map(r => swapEventToHop({ name: r.event_name, args: (safeJson(r.args_json) ?? {}) as Record<string, unknown> }))
  if (!route.length) {
    return [{
      pool: 'Router',
      poolId: null,
      assetIn: asset(netAmts.assetIn),
      assetOut: asset(netAmts.assetOut),
      amountIn: netAmts.amountIn || null,
      amountOut: netAmts.amountOut || null,
      fee: null,
    }]
  }
  const first = route[0]
  if (first.assetIn.assetId !== netAmts.assetIn) {
    route.unshift({
      pool: syntheticRoutePool(),
      poolId: null,
      assetIn: asset(netAmts.assetIn),
      assetOut: first.assetIn,
      amountIn: netAmts.amountIn || null,
      amountOut: first.amountIn,
      fee: null,
    })
  }
  const last = route[route.length - 1]
  if (last.assetOut.assetId !== netAmts.assetOut) {
    route.push({
      pool: syntheticRoutePool(),
      poolId: null,
      assetIn: last.assetOut,
      assetOut: asset(netAmts.assetOut),
      amountIn: last.amountOut,
      amountOut: netAmts.amountOut || null,
      fee: null,
    })
  }
  return route
}

// `routeEvent` addresses ONE route of a batch that dispatched several: the events of
// the route it closes, rather than every swap event the extrinsic emitted. Without it
// a link to the second route's event answered with the first route's trade.
export async function getTradeDetail(height: number, index: number, routeEvent?: number): Promise<TradeDetail | null> {
  return cached(`explorer:trade:${height}:${index}:${routeEvent ?? ''}`, 60_000, async () => {
    const prices = await ensurePrices()
    // The fee-currency events ride along in the same read rather than a second
    // round trip, then are partitioned straight back out: the route slicing
    // below counts on `evRows` holding swap events only.
    const names = [...SWAP_EVENTS, ...FEE_BALANCE_EVENTS].map(n => `'${n}'`).join(',')
    const [evRes, extRes] = await Promise.all([
      client.query({
        query: `SELECT event_index, event_name, args_json, toString(block_timestamp) AS ts
                FROM price_data.raw_events
                WHERE block_height = {h:UInt32} AND extrinsic_index = {i:UInt32} AND event_name IN (${names})
                ORDER BY event_index`,
        query_params: { h: height, i: index }, format: 'JSONEachRow',
      }),
      client.query({
        query: `SELECT toString(block_timestamp) AS ts, extrinsic_hash, success, signer, effective_signer, fee, tip, call_name, call_args_json
                FROM price_data.raw_extrinsics
                WHERE block_height = {h:UInt32} AND extrinsic_index = {i:UInt32} LIMIT 1`,
        query_params: { h: height, i: index }, format: 'JSONEachRow',
      }),
    ])
    const allRows = await evRes.json<{ event_index: number; event_name: string; args_json: string; ts: string }>()
    const feeEventNames = new Set<string>(FEE_BALANCE_EVENTS)
    const feeEvents: FeePaymentEvent[] = allRows.filter(r => feeEventNames.has(r.event_name))
      .map(r => ({ name: r.event_name, args: safeJson(r.args_json) }))
    const evRows = allRows.filter(r => !feeEventNames.has(r.event_name))
    if (!evRows.length) return null
    const allEvs = evRows.map(r => ({ idx: r.event_index, name: r.event_name, ts: r.ts, args: (safeJson(r.args_json) ?? {}) as Record<string, unknown> }))
    // Slice the addressed route out, by the same boundaries the feed groups on.
    const netIndices = allEvs.filter(e => isRouterNet(e.name)).map(e => e.idx)
    const evs = routeEvent == null ? allEvs
      : allEvs.filter(e => e.idx > routeStartAfter(netIndices, routeEvent) && e.idx <= routeEvent)
    if (!evs.length) return null
    const ext = (await extRes.json<{ ts: string; extrinsic_hash: string; success: number | boolean; signer: string | null; effective_signer: string | null; fee: string | null; tip: string | null; call_name: string; call_args_json: string }>())[0]
    const callName = ext?.call_name ?? ''
    const callArgs = (safeJson(ext?.call_args_json ?? '') ?? {}) as Record<string, unknown>

    // Net trade: the Router.Executed summary when routed, else the first event
    // that isn't a router-internal hop.
    const routerNet = evs.find(e => isRouterNet(e.name))
    const nonHop = evs.filter(e => !isRouterNet(e.name) && String(e.args.who ?? '') !== ROUTER_PALLET_ACCT)
    const net = routerNet ?? nonHop[0] ?? evs[0]
    const netAmts = swapEventAmounts(net.name, net.args)
    const direction: 'Sell' | 'Buy' = net.name.includes('Buy') ? 'Buy'
      : isRouterNet(net.name) && /\.buy$/.test(callName) ? 'Buy' : 'Sell'

    const hopEvents = evs.filter(e => !isRouterNet(e.name))
    const routeSpecs = parseRouteHops(callArgs)
    const route: TradeHop[] = routeSpecs.length
      ? routeSpecs.map(spec => {
          // Match the executed event for this hop by its asset pair; Aave wrap
          // hops emit no event and keep null amounts (1:1 wraps).
          const ev = hopEvents.find(e => { const a = swapEventAmounts(e.name, e.args); return a.assetIn === spec.assetIn && a.assetOut === spec.assetOut })
          const a = ev ? swapEventAmounts(ev.name, ev.args) : null
          return { pool: spec.pool, poolId: spec.poolId, assetIn: asset(spec.assetIn), assetOut: asset(spec.assetOut), amountIn: a?.amountIn || null, amountOut: a?.amountOut || null, fee: ev ? tradeHopFee(ev.name, ev.args, spec.assetOut) : null }
        })
      : hopEvents.map(swapEventToHop)

    const limitSpec = parseTradeLimit(callName, callArgs)
    const limit = limitSpec ? {
      kind: limitSpec.kind, amount: limitSpec.amount, asset: asset(limitSpec.assetId),
      marginPct: limitMarginPct(limitSpec.kind, limitSpec.amount, limitSpec.kind === 'maxPaid' ? netAmts.amountIn : netAmts.amountOut),
    } : null

    const aIn = asset(netAmts.assetIn), aOut = asset(netAmts.assetOut)
    const inNum = Number(netAmts.amountIn) / 10 ** aIn.decimals
    const outNum = Number(netAmts.amountOut) / 10 ** aOut.decimals
    const netWho = String(net.args.who ?? '')
    // A proxied or multisig dispatch moves the funds of the account it ran AS, so the
    // detail names the same actor the feed does rather than the signatory.
    const onBehalf = (await onBehalfActorsFor([[height, index]])).get(`${height}:${index}`)
    const actorId = onBehalf || ext?.effective_signer || ext?.signer || (ACCOUNT_RE.test(netWho) && netWho !== ROUTER_PALLET_ACCT ? netWho : null)
    const detail: TradeDetail = {
      blockHeight: height, timestamp: ext?.ts ?? net.ts, extrinsicIndex: index, eventIndex: net.idx,
      hash: ext?.extrinsic_hash ?? null,
      success: ext ? !!ext.success : true,
      who: actorId ? accountRef(actorId) : null,
      venue: routerNet ? 'Router' : net.name.split('.')[0],
      direction,
      assetIn: aIn, assetOut: aOut, amountIn: netAmts.amountIn, amountOut: netAmts.amountOut,
      valueUsd: usdValue(prices, aOut.assetId, netAmts.amountOut, aOut.decimals),
      executionPrice: inNum > 0 && outNum > 0 ? outNum / inNum : null,
      limit,
      extrinsicFee: ext?.fee ?? null,
      extrinsicTip: ext?.tip ?? null,
      // The fee is charged to whoever SIGNED — a proxy or multisig dispatch pays
      // it out of the signatory's fee currency, not `who`'s.
      ...(() => {
        const payment = feePaymentOf(feeEvents, ext?.signer ?? ext?.effective_signer ?? null, ext?.fee ?? null, ext?.tip ?? null)
        return payment ? { feePayment: payment } : {}
      })(),
      route,
    }
    await applyHistoricalUsd([detail], d => ({ assetId: d.assetOut.assetId, decimals: d.assetOut.decimals, raw: d.amountOut, ts: d.timestamp }))
    return detail
  })
}

export async function getTradeDetailByEvent(height: number, eventIndex: number): Promise<TradeDetail | null> {
  return cached(`explorer:trade-event:${height}:${eventIndex}`, 60_000, async () => {
    const prices = await ensurePrices()
    const names = SWAP_EVENTS.map(n => `'${n}'`).join(',')
    const evRes = await client.query({
      query: `SELECT event_index, extrinsic_index, event_name, args_json, toString(block_timestamp) AS ts
              FROM price_data.raw_events
              WHERE block_height = {h:UInt32} AND event_index = {e:UInt32} AND event_name IN (${names})
              LIMIT 1`,
      query_params: { h: height, e: eventIndex }, format: 'JSONEachRow',
    })
    const ev = (await evRes.json<{ event_index: number; extrinsic_index: number | null; event_name: string; args_json: string; ts: string }>())[0]
    if (!ev) return null
    if (ev.extrinsic_index != null) {
      // Which route of the extrinsic this event belongs to, so a batch's second swap
      // opens its own trade instead of its neighbour's.
      const netRes = await client.query({
        query: `SELECT event_index FROM price_data.raw_events
                WHERE block_height = {h:UInt32} AND extrinsic_index = {i:UInt32}
                  AND event_name IN (${ROUTER_NET_EVENTS_SQL})
                ORDER BY event_index`,
        query_params: { h: height, i: ev.extrinsic_index }, format: 'JSONEachRow',
      })
      const nets = (await netRes.json<{ event_index: number }>()).map(r => r.event_index)
      return getTradeDetail(height, ev.extrinsic_index, closingNetEvent(nets, eventIndex))
    }

    const args = (safeJson(ev.args_json) ?? {}) as Record<string, unknown>
    const netAmts = swapEventAmounts(ev.event_name, args)
    const aIn = asset(netAmts.assetIn), aOut = asset(netAmts.assetOut)
    const inNum = Number(netAmts.amountIn) / 10 ** aIn.decimals
    const outNum = Number(netAmts.amountOut) / 10 ** aOut.decimals
    const direction: 'Sell' | 'Buy' = ev.event_name.includes('Buy') ? 'Buy' : 'Sell'
    const netWho = String(args.who ?? '')

    // An extrinsic-less swap event carries its actor in `who`, unless that is the
    // router's own pallet account standing in for the real trader.
    const actorId = ACCOUNT_RE.test(netWho) && netWho !== ROUTER_PALLET_ACCT ? netWho : null

    const route: TradeHop[] = isRouterNet(ev.event_name)
      ? await inferredRouterRoute(height, eventIndex, netAmts)
      : [swapEventToHop({ name: ev.event_name, args })]

    const detail: TradeDetail = {
      blockHeight: height, timestamp: ev.ts, extrinsicIndex: null, eventIndex,
      hash: null,
      success: true,
      who: actorId ? accountRef(actorId) : null,
      venue: ev.event_name.split('.')[0],
      direction,
      assetIn: aIn, assetOut: aOut, amountIn: netAmts.amountIn, amountOut: netAmts.amountOut,
      valueUsd: usdValue(prices, aOut.assetId, netAmts.amountOut, aOut.decimals),
      executionPrice: inNum > 0 && outNum > 0 ? outNum / inNum : null,
      limit: null,
      extrinsicFee: null,
      extrinsicTip: null,
      route,
    }
    await attachHookSwapActors([detail])
    await applyHistoricalUsd([detail], d => ({ assetId: d.assetOut.assetId, decimals: d.assetOut.decimals, raw: d.amountOut, ts: d.timestamp }))
    return detail
  })
}

// The account a dispatch ran AS, when it was not the signatory's own.
//
// A swap dispatched through a proxy or a multisig moves the funds of the account the
// call ran as, never those of the signatory who submitted it. The innermost proxy
// wins: Multisig.as_multi → Proxy.proxy(real=X) executes its batch with X's origin,
// so X is whose HUSDT left. Call addresses form a path tree ('root', '0', '0.0', …),
// so depth is the dot count and 'root' is shallowest.
//
// With no proxy, the multisig account itself is the actor. With neither, there is no
// on-behalf account and the signer stands.
export interface OnBehalfCandidateSet {
  proxies?: { callAddress: string; account: string }[]
  multisig?: string
}
export function onBehalfActor(candidates: OnBehalfCandidateSet): string | undefined {
  const depth = (callAddress: string) => callAddress === 'root' ? 0 : callAddress.split('.').length
  const innermost = (candidates.proxies ?? [])
    .filter(p => p.account)
    .sort((l, r) => depth(r.callAddress) - depth(l.callAddress))[0]
  return innermost?.account || candidates.multisig || undefined
}

// Map (block_height, extrinsic_index) → the account each extrinsic dispatched AS.
// Both reads are purpose-built on-behalf models rather than the raw call args, which
// would need a JSON path per nesting depth. Neither is keyed on (block, extrinsic),
// so each is a full scan — of 4,679 and 4,884 rows respectively, because only
// proxied/multisig dispatches land in them at all, against the ~2M swap extrinsics
// that do not.
async function onBehalfActorsFor(pairs: [number, number | null][]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const keys = [...new Set(pairs.filter(([, i]) => i != null).map(([h, i]) => `${h}:${i}`))]
  if (!keys.length) return out
  const tuples = keys.map(k => { const [h, i] = k.split(':'); return `(${h},${i})` }).join(',')
  const [proxyRes, msRes] = await Promise.all([
    client.query({
      query: `SELECT block_height, extrinsic_index, call_address, real_account
              FROM price_data.proxy_call_activity
              WHERE (block_height, extrinsic_index) IN (${tuples})`,
      format: 'JSONEachRow',
    }),
    client.query({
      query: `SELECT block_height, assumeNotNull(extrinsic_index) AS extrinsic_index, multisig
              FROM price_data.multisig_event_activity
              WHERE (block_height, assumeNotNull(extrinsic_index)) IN (${tuples})
                AND event_name = 'Multisig.MultisigExecuted' AND multisig != ''`,
      format: 'JSONEachRow',
    }),
  ])
  const candidates = new Map<string, OnBehalfCandidateSet>()
  for (const r of await proxyRes.json<{ block_height: number; extrinsic_index: number; call_address: string; real_account: string }>()) {
    const key = `${r.block_height}:${r.extrinsic_index}`
    const at = candidates.get(key) ?? {}
    ;(at.proxies ??= []).push({ callAddress: r.call_address, account: r.real_account })
    candidates.set(key, at)
  }
  for (const r of await msRes.json<{ block_height: number; extrinsic_index: number; multisig: string }>()) {
    const key = `${r.block_height}:${r.extrinsic_index}`
    const at = candidates.get(key) ?? {}
    at.multisig ??= r.multisig
    candidates.set(key, at)
  }
  for (const [key, set] of candidates) {
    const actor = onBehalfActor(set)
    if (actor) out.set(key, actor)
  }
  return out
}

// Map (block_height, extrinsic_index) → the account to attribute its pallet-internal
// events (trades) to: the account the extrinsic dispatched AS when it ran through a
// proxy or a multisig, else its signer. Attributing to the signatory credited a
// multisig member with the proxied account's $79.7k swap while the account whose
// funds moved showed nothing.
async function actorsFor(pairs: [number, number | null][]): Promise<Map<string, string>> {
  const [signers, onBehalf] = await Promise.all([signersFor(pairs), onBehalfActorsFor(pairs)])
  for (const [key, actor] of onBehalf) signers.set(key, actor)
  return signers
}

// Map (block_height, event_index) → the account a routed HOOK swap was made for.
//
// Router.Executed/RouteExecuted never carry a `who`, and a swap dispatched from a
// block hook — the Scheduler running a governance batch, say — has no
// extrinsic and so no signer either. That left DCA as the only hook actor any feed
// could name, and everything else rendered actorless: a $90k Treasury swap with a
// blank account. Broadcast.Swapped* records the swapper alongside the Router
// operation the swap belongs to, and swap_actor is that pairing, keyed by the same
// `eventId` Router.Executed reports.
//
// Only worth asking for the rows nothing cheaper could attribute, so callers pass
// just those; the lookup is then a primary-key match on both tables. Swaps before
// block 6837789 have no Broadcast event to read and stay unattributed rather than
// guessed at.
async function hookSwapActorsFor(rows: { blockHeight: number; eventIndex: number }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const keys = [...new Set(rows.map(r => `${r.blockHeight}:${r.eventIndex}`))]
  if (!keys.length) return out
  const chunks = await mapChunksConcurrently(keys, 5_000, CHUNK_QUERY_CONCURRENCY, async chunk => {
    const tuples = chunk.map(k => { const [h, i] = k.split(':'); return `(${h},${i})` }).join(',')
    const res = await client.query({
      query: `SELECT e.block_height AS block_height, e.event_index AS event_index, a.swapper AS swapper
              FROM price_data.raw_events AS e
              INNER JOIN price_data.swap_actor AS a
                ON a.block_height = e.block_height
               AND a.operation_event_id = toUInt64(greatest(0, JSONExtractInt(e.args_json, 'eventId')))
              WHERE (e.block_height, e.event_index) IN (${tuples})`,
      format: 'JSONEachRow',
    })
    return res.json<{ block_height: number; event_index: number; swapper: string }>()
  })
  for (const rows of chunks) {
    for (const r of rows) if (ACCOUNT_RE.test(r.swapper)) out.set(`${r.block_height}:${r.event_index}`, r.swapper)
  }
  return out
}

// Fill in the actor of any hook swap nothing cheaper could attribute. Runs as a
// post-pass over rows already built, so it cannot disturb the DCA adjacency claim
// that decides which execution owns which swap, and it costs nothing on the
// overwhelming majority of pages where every row already has an account.
//
// Shared by the trade feed, the asset feed, the block page and the swap detail so
// the six surfaces cannot disagree about who made a swap.
async function attachHookSwapActors(rows: { blockHeight: number; eventIndex?: number | null; extrinsicIndex: number | null; who: AccountRef | null }[]): Promise<void> {
  const pending = rows.filter((r): r is typeof r & { eventIndex: number } =>
    !r.who && r.extrinsicIndex == null && r.eventIndex != null)
  if (!pending.length) return
  const actors = await hookSwapActorsFor(pending)
  for (const row of pending) {
    const actor = actors.get(`${row.blockHeight}:${row.eventIndex}`)
    if (actor) row.who = accountRef(actor)
  }
}

// Map (block_height, extrinsic_index) → signer account_id for a set of rows.
// The raw signatory; callers attributing economic activity want actorsFor instead.
async function signersFor(pairs: [number, number | null][]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const keys = [...new Set(pairs.filter(([, i]) => i != null).map(([h, i]) => `${h}:${i}`))]
  if (!keys.length) return out
  const chunks = await mapChunksConcurrently(keys, 5_000, CHUNK_QUERY_CONCURRENCY, async chunk => {
    const tuples = chunk.map(k => { const [h, i] = k.split(':'); return `(${h},${i})` }).join(',')
    const res = await client.query({
      query: `SELECT block_height, extrinsic_index, coalesce(signer, effective_signer) AS signer FROM price_data.raw_extrinsics WHERE (block_height, extrinsic_index) IN (${tuples}) AND coalesce(signer, effective_signer) IS NOT NULL AND coalesce(signer, effective_signer) != ''`,
      format: 'JSONEachRow',
    })
    return res.json<{ block_height: number; extrinsic_index: number; signer: string }>()
  })
  for (const rows of chunks) {
    for (const r of rows) out.set(`${r.block_height}:${r.extrinsic_index}`, r.signer)
  }
  return out
}

// The subset of (block, extrinsic) pairs whose call is a genuine token-transfer
// call. Used to keep only real donations to the treasury pot on a transfer feed:
// a transfer *to* py/trsry emitted by any other call (a batch/swap fee, a
// Referrals.register_code deposit, an XCM inherent's fee) is a fee/deposit, not a
// user transfer.
async function transferCallExtrinsics(pairs: [number, number | null][]): Promise<Set<string>> {
  const out = new Set<string>()
  const keys = [...new Set(pairs.filter(([, i]) => i != null).map(([h, i]) => `${h}:${i}`))]
  if (!keys.length) return out
  const callList = [...TRANSFER_CALL_NAMES].map(c => `'${c}'`).join(',')
  const chunks = await mapChunksConcurrently(keys, 5_000, CHUNK_QUERY_CONCURRENCY, async chunk => {
    const tuples = chunk.map(k => { const [h, i] = k.split(':'); return `(${h},${i})` }).join(',')
    const res = await client.query({
      query: `SELECT block_height, extrinsic_index FROM price_data.raw_extrinsics
              WHERE (block_height, extrinsic_index) IN (${tuples}) AND call_name IN (${callList})`,
      format: 'JSONEachRow',
    })
    return res.json<{ block_height: number; extrinsic_index: number }>()
  })
  for (const rows of chunks) {
    for (const r of rows) out.add(`${r.block_height}:${r.extrinsic_index}`)
  }
  return out
}

// unified activity
export interface ActivityRow {
  type: 'transfer' | 'trade' | 'xcm' | 'liquidity' | 'vote'
  blockHeight: number
  timestamp: string
  eventIndex?: number | null
  extrinsicIndex: number | null
  who: AccountRef | null
  to: AccountRef | null
  asset: AssetRef | null
  assetIn: AssetRef | null
  assetOut: AssetRef | null
  amount: string | null
  amountIn: string | null
  amountOut: string | null
  valueUsd: number | null
  // Every asset the source event references, beyond the representative
  // asset/assetIn/assetOut the row displays (Stableswap nested `assets[]`, XYK
  // `assetB`). Token filters match against these too, so a pool-side asset the
  // row does not display still keeps its row.
  assetRefs?: number[]
  liqAction?: 'Add' | 'Remove' | 'Create' | 'Claim' | 'Destroy'   // Create = pool creation; Destroy = pool closure (no value); Claim = LM reward claim
  votePallet?: string
  // Referendum identity for the row's link, plus the off-chain title. Set only for
  // ConvictionVoting/Democracy rows: Council and Technical Committee votes are not
  // referenda and their "ref" is a proposal hash.
  voteRefPallet?: 'opengov' | 'democracy' | null
  voteRefTitle?: string | null
  voteAction?: string
  voteRef?: string | null
  voteSide?: string
  voteConviction?: string | null
  // xcm outbound: the message left through the xcm EXECUTOR, not through pallet_xcm's own
  // delivery. Set only by the arm and the extrinsic-page path that decode those sends, and
  // read by suppressSubordinateActivityRows: a swap in the same extrinsic bought this send
  // its delivery fee, so it folds behind this row. A pallet_xcm/XTokens send carries no such
  // claim over a swap batched beside it — that swap is one the user chose to make.
  xcmExecuted?: true
  destChain?: string         // xcm outbound: destination chain name
  destParachainId?: number | null
  destAccount?: {
    // The SAME canonical id accountRef uses for a local account: for an
    // AccountId32 this equals `raw`, and for an AccountKey20 it is the substrate
    // account the key truncates (a module/sovereign account) where there is one,
    // else the bare H160 — the client must key any viewer-side (user tag / avatar
    // URL) lookup on THIS field, never on `raw` or `address`.
    kind: 'AccountId32' | 'AccountKey20'; accountId: string; address: string; raw: string; subscanUrl: string | null
    emoji?: string; emojiName?: string; emojiUrl?: string
    tag?: { id: string; name: string; color: string; icon: string; memberCount?: number } | null
    identity?: { display: string; verified: boolean } | null
  }
  xcmDir?: 'in' | 'out'      // xcm: transfer direction relative to Basilisk
  fromChain?: string         // xcm inbound: origin chain name
  fromParachainId?: number | null
  // Source account of an inbound transfer, resolved from the Ocelloids
  // crosschain index (best-effort — absent for old rows or when the API is
  // unavailable). Same shape/semantics as destAccount.
  fromAccount?: ActivityRow['destAccount']
  messageId?: string | null  // xcm inbound: message topic id (MessageQueue.Processed)
  // Origin-chain extrinsic of an inbound transfer (explorer deep link) —
  // resolved with fromAccount from the crosschain journey index.
  fromTxUrl?: string | null
  // Explicit link target for rows whose own extrinsic is not the one to open.
  linkBlock?: number | null
  linkIndex?: number | null
}

// The order every activity surface presents: newest block first, and within a
// block the later event first. Rows without an event index (block hooks) sort last
// inside their block rather than ahead of real events.
//
// The order must also be TOTAL. Offset paging is only well defined if two feeds
// built from different candidate sets order the same rows the same way; under a
// tie `Array.sort` may pick either, and two pages sliced from separately-built
// arrays can then both hold one of a tied pair and neither the other — a duplicate
// and a gap, not a reordering. The discriminators below are all numeric and all
// derived from columns ClickHouse holds, so the same order is expressible there.
export function compareActivityRowsNewestFirst(a: ActivityRow, b: ActivityRow): number {
  return b.blockHeight - a.blockHeight
    || (b.eventIndex ?? -1) - (a.eventIndex ?? -1)
    || (b.extrinsicIndex ?? -1) - (a.extrinsicIndex ?? -1)
    || activityKindRank(a) - activityKindRank(b)
}
// A stable numeric rank per row family, so a tie on (block, event, extrinsic)
// still resolves identically every time the feed is built.
const ACTIVITY_KIND_RANK: Record<string, number> = {
  trade: 0, liquidity: 1, xcm: 2, vote: 3, transfer: 4,
}
function activityKindRank(r: ActivityRow): number {
  return ACTIVITY_KIND_RANK[r.type] ?? 5
}

// Pair rows that belong together by ADJACENCY rather than by a shared key, when the
// key alone can collide. Each claim consumes its candidate, so two claimants can
// never take the same one — the failure a plain Map lookup produces silently.
export function adjacencyClaimIndex<T>(items: T[], keyOf: (item: T) => string, indexOf: (item: T) => number) {
  const byKey = new Map<string, T[]>()
  for (const item of items) {
    const key = keyOf(item)
    const list = byKey.get(key) ?? []
    list.push(item)
    byKey.set(key, list)
  }
  for (const list of byKey.values()) list.sort((a, b) => indexOf(a) - indexOf(b))
  const take = (key: string, pick: (list: T[]) => number): T | undefined => {
    const list = byKey.get(key)
    if (!list?.length) return undefined
    const at = pick(list)
    return list.splice(at < 0 ? list.length - 1 : at, 1)[0]
  }
  return {
    // Nearest candidate AFTER `index`; falls back to the last remaining one.
    claimAfter: (key: string, index: number): T | undefined =>
      take(key, list => list.findIndex(item => indexOf(item) > index)),
    // Nearest candidate BEFORE `index`; falls back to the last remaining one.
    claimBefore: (key: string, index: number): T | undefined =>
      take(key, list => {
        let at = -1
        for (let i = 0; i < list.length && indexOf(list[i]) < index; i++) at = i
        return at
      }),
  }
}

// Whether the explorer can put a NAME to this account — the same four things
// that make it show one instead of bare hex: a system tag ("Treasury",
// "Kraken") or an on-chain identity,
// contract's name. A viewer's OWN tags are deliberately not part of it: they
// live in the browser, and a server-paged feed cannot honour a predicate only
// the client can evaluate without handing back ragged pages.
// Filters decided on the BUILT row rather than pushed into SQL. A source that
// has one must walk deeper until the page is full, instead of filtering a fixed
// candidate window and coming up short — which the window guard turns into a
// 503 telling the reader to narrow filters they just set.
export function hasRowLevelFilter(filters: ValueListFilters): boolean {
  return filters.min != null || filters.identity != null
}
// The subset a source re-checks after its SQL already enforced the rest.
export function rowLevelFilters(filters: ValueListFilters): ValueListFilters {
  return { min: filters.min, unit: filters.unit, identity: filters.identity, viewerTagged: filters.viewerTagged }
}

export function accountIsNamed(who: AccountRef | null | undefined, viewerTagged?: Set<string>): boolean {
  if (!who) return false
  if (who.tag || who.identity?.display) return true
  // ...and whatever the VIEWER has named themselves. Their own and subscribed
  // tags are as much a name as a system one to the person reading the page.
  return !!viewerTagged?.has(who.accountId.toLowerCase())
}

export function activityRowMatchesFilters(row: ActivityRow, filters: ValueListFilters): boolean {
  // Named / unnamed, judged on the row's ACTOR — the account the row is BY.
  // A row with no actor at all (a block hook, a scheduler payout) has no
  // account to name and so counts as unnamed.
  if (filters.identity) {
    const named = accountIsNamed(row.who, filters.viewerTagged)
    if (named !== (filters.identity === 'named')) return false
  }
  const tokenIds = assetIdsForToken(filters.token)
  if (tokenIds != null) {
    // assetRefs carries the pool-side assets a liquidity row references but does
    // not display, matching the SQL sources' `hasAny(asset_refs, …)` predicate.
    const rowIds = [row.asset?.assetId, row.assetIn?.assetId, row.assetOut?.assetId, ...(row.assetRefs ?? [])]
      .filter((id): id is number => id != null)
    if (!rowIds.some(id => tokenIds.includes(id))) return false
  }
  if (filters.min != null) {
    if (filters.unit === 'token') {
      const picks = [
        row.amount != null && row.asset ? { amt: row.amount, a: row.asset } : null,
        row.amountOut != null && row.assetOut ? { amt: row.amountOut, a: row.assetOut } : null,
        row.amountIn != null && row.assetIn ? { amt: row.amountIn, a: row.assetIn } : null,
      ].filter((pick): pick is { amt: string; a: AssetRef } => pick != null && /^\d+$/.test(pick.amt))
      const relevant = tokenIds == null ? picks.slice(0, 1) : picks.filter(pick => tokenIds.includes(pick.a.assetId))
      return relevant.some(pick => {
        const threshold = minimumRawAmountForValue(filters.min!, 1, pick.a.decimals)
        return threshold != null && BigInt(pick.amt) >= threshold
      })
    }
    if (!rowMeetsExactUsdMinimum(row, filters.min)) return false
  }
  return true
}

export interface LiquidityAmountCandidate {
  block_height: number
  event_index: number
  extrinsic_index: number | null
  event_name: string
  who: string
  asset_id: number
  amount: string
}

export interface LiquidityTransferLeg {
  block_height: number
  event_index: number
  extrinsic_index: number | null
  asset_id: number
  from_account: string
  to_account: string
  amount: string
}

// A removal event carries only the burnt share count (XYK.LiquidityRemoved), never
// the underlying token amounts — those live on the paired pool↔who transfer legs.
// Recover them by matching each amount-less row to a leg with the same asset +
// account and the nearest preceding event index, consuming each leg once.
//
// Legs are matched within the same DISPATCH SCOPE: signed user actions scope to
// their extrinsic, while events dispatched outside one (a runtime hook or the
// scheduler) carry no extrinsic index and scope to the block's out-of-extrinsic
// legs. Isolating the scopes stops a signed same-block transfer from being
// mistaken for a hook's leg.
export function matchLiquidityAmounts(missing: LiquidityAmountCandidate[], legs: LiquidityTransferLeg[]): void {
  const scopeOf = (ext: number | null | undefined): string => ext == null ? 'blk' : String(ext)
  const byTo = new Map<string, { event_index: number; amount: string; used: boolean }[]>()
  // Pool creation legs run who→pool (the opposite direction of a removal's
  // pool→who), so they're additionally indexed by the SENDER.
  const byFrom = new Map<string, { event_index: number; amount: string; used: boolean }[]>()
  const push = (map: Map<string, { event_index: number; amount: string; used: boolean }[]>, key: string, entry: { event_index: number; amount: string; used: boolean }): void => {
    const list = map.get(key) ?? []
    list.push(entry)
    map.set(key, list)
  }
  for (const t of legs) {
    if (!t.amount) continue
    // A payout leg always comes from the pool. The Treasury only appears in a
    // liquidity extrinsic to refund the XYK pool-creation deposit when the last
    // LP exits and the pool is destroyed — and that refund is emitted AFTER the
    // pool's own payout, so adjacency would pick the 1 BSX deposit over the real
    // withdrawal on every BSX-paired final removal.
    if (t.from_account.toLowerCase() === TREASURY_POT) continue
    const entry = { event_index: t.event_index, amount: t.amount, used: false }
    const scope = scopeOf(t.extrinsic_index)
    push(byTo, `${t.block_height}:${scope}:${t.asset_id}:${t.to_account.toLowerCase()}`, entry)
    push(byFrom, `${t.block_height}:${scope}:${t.asset_id}:${t.from_account.toLowerCase()}`, entry)
  }
  for (const list of byTo.values()) list.sort((a, b) => a.event_index - b.event_index)
  for (const list of byFrom.values()) list.sort((a, b) => a.event_index - b.event_index)
  for (const row of missing) {
    if (row.amount || !row.who || row.asset_id == null) continue
    const scope = scopeOf(row.extrinsic_index)
    const lookup = row.event_name === 'XYK.PoolCreated' ? byFrom : byTo
    const transfers = lookup.get(`${row.block_height}:${scope}:${row.asset_id}:${row.who.toLowerCase()}`)
    if (!transfers?.length) continue
    const before = transfers
      .filter(t => !t.used && t.event_index < row.event_index)
      .at(-1)
    const match = before ?? transfers.find(t => !t.used)
    if (!match) continue
    match.used = true
    row.amount = match.amount
  }
}

async function fillMissingLiquidityAmounts(rows: LiquidityAmountCandidate[]): Promise<void> {
  const missing = rows.filter(r => !r.amount && r.who && r.asset_id != null && !isAmountlessLiquidityEvent(r.event_name))
  if (!missing.length) return
  // Signed actions carry an extrinsic index; offboarding-style force-removals are
  // dispatched from a runtime hook and carry none. Fetch the transfer legs for
  // each: the touched extrinsics, plus the whole block's out-of-extrinsic legs.
  const extKeys = [...new Set(missing.filter(r => r.extrinsic_index != null).map(r => `${r.block_height}:${r.extrinsic_index}`))]
  const nullExtBlocks = [...new Set(missing.filter(r => r.extrinsic_index == null).map(r => r.block_height))]
  const columns = `block_height, event_index, extrinsic_index, asset_id, from_account, to_account, amount`
  const legs: LiquidityTransferLeg[] = []
  // Only legs in one of the missing rows' own assets can ever be matched (the
  // match key carries asset_id), so a batch or routed extrinsic's unrelated legs
  // are left in ClickHouse rather than shipped and discarded.
  const fillAssetIds = [...new Set(missing.map(r => r.asset_id!))]
  const assetFilter = `AND asset_id IN (${sqlUIntList(fillAssetIds)})`
  // Chunked far smaller than a row-per-key lookup would need: this returns EVERY
  // matching leg of each key, and legs per liquidity extrinsic run p50 11, p99 132,
  // max 738. A 5,000-key chunk came back with 94k rows and the next crossed the
  // client's 100k result guard, failing deep liquidity pages with a ClickHouse 500.
  const legChunk = 500
  const [signedLegs, hookLegs] = await Promise.all([
    mapChunksConcurrently(extKeys, legChunk, CHUNK_QUERY_CONCURRENCY, async chunk => {
      const tuples = chunk.map(k => { const [h, j] = k.split(':'); return `(${h},${j})` }).join(',')
      const res = await client.query({
        query: `SELECT ${columns} FROM price_data.transfer_activity_by_time WHERE (block_height, extrinsic_index) IN (${tuples}) ${assetFilter}`,
        format: 'JSONEachRow',
      })
      return res.json<LiquidityTransferLeg>()
    }),
    mapChunksConcurrently(nullExtBlocks, legChunk, CHUNK_QUERY_CONCURRENCY, async chunk => {
      const blocks = chunk.join(',')
      const res = await client.query({
        query: `SELECT ${columns} FROM price_data.transfer_activity_by_time WHERE block_height IN (${blocks}) AND extrinsic_index IS NULL ${assetFilter}`,
        format: 'JSONEachRow',
      })
      return res.json<LiquidityTransferLeg>()
    }),
  ])
  for (const rows of [...signedLegs, ...hookLegs]) legs.push(...rows)
  matchLiquidityAmounts(missing, legs)
}

// Liquidity provision/removal/creation events for Activity. The
// action filter pushes down to event names — pool creations are rare, so a
// post-filter over a recency window would mostly return empty pages.
async function getRecentLiquidity(limit: number, from?: string, to?: string, offset = 0, filters: ValueListFilters = {}, action?: string): Promise<ActivityRow[]> {
  const tw = timeWindow(from, to)
  const liqEvents = liquidityActionEventNames(action)
  // An action no liquidity event produces selects nothing — the same answer the merged
  // feed's activityRowMatchesAction gives it, reached without an empty `IN ()`.
  if (!liqEvents.length) return []
  return cached(`explorer:liquidity:${await liveHeadTag(Boolean(tw), datedWindowIsClosed(to))}:${limit}:${offset}:${from ?? ''}:${to ?? ''}:${filterKey(filters)}:${action ?? ''}`, tw ? 30000 : LIVE_CACHE_MS, async () => {
    const prices = await ensurePrices()
    const tokenIds = assetIdsForToken(filters.token)
    const assetExpr = 'asset_id'
    const amountExpr = 'amount'
    // Match against every asset the event references (Omnipool assetId, XYK
    // assetA/assetB, Stableswap nested assets[]), not just the representative
    // assetExpr used for the displayed asset_id — else a HOLLAR filter drops most
    // of its Stableswap/XYK liquidity rows.
    const tokenFilter = tokenIds == null ? '' : tokenIds.length ? `AND hasAny(asset_refs, [${tokenIds.join(',')}])` : 'AND 0'
    const tokenRefsFilter = ''
    // Token-unit thresholds are integer predicates and remain safe to push down.
    // USD thresholds are deliberately candidate-first: an ASOF price join ahead
    // of LIMIT scanned the entire compact liquidity history on every cold page.
    // Bounded candidates are valued at their exact event timestamps below and
    // the deep walker widens until it has a complete qualifying page.
    let amountFilter: EventValueFilterSql = { joinSql: '', predicateSql: '' }
    if (filters.min != null && filters.unit === 'token') {
      // XYK adds carry only amountA/amountB — the display amount is filled from
      // the matching transfer leg (≈ amountA), so amountA stands in here.
      const preAmountExpr = `multiIf(${amountExpr} != '', ${amountExpr}, amount_a)`
      const directFilter = eventValueFilterSql(assetExpr, preAmountExpr, 'block_timestamp', filters, prices, 'liquidity_price')
      const valueOk = directFilter.predicateSql.replace(/^AND\s+/, '')
      amountFilter = {
        joinSql: directFilter.joinSql,
        predicateSql: `AND (${valueOk} OR ${preAmountExpr} = '' OR event_name = 'XYK.PoolCreated')`,
      }
    }
    const postFilter = hasRowLevelFilter(filters)
    const want = offset + limit
    const fetchPage = async (bound: string, pageLimit: number, pageOffset: number): Promise<ActivityRow[]> => {
      const res = await client.query({
        query: `
          SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name,
            who AS who,
            ${assetExpr} AS asset_id,
            ${amountExpr} AS amount,
            asset_b AS asset_b,
            pool_account AS pool_acc,
            asset_refs AS asset_refs
          FROM price_data.liquidity_activity
          ${amountFilter.joinSql}
          WHERE ${bound}
            AND event_name IN (${sqlEventNameList(liqEvents)})
            ${tokenRefsFilter}
            AND who NOT LIKE '0x6d6f646c%'
            ${tokenFilter}
            ${amountFilter.predicateSql}
          ORDER BY block_height DESC, event_index DESC
          LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
        query_params: { limit: pageLimit, offset: pageOffset }, format: 'JSONEachRow',
      })
      const raw = await res.json<{ block_height: number; ts: string; event_index: number; extrinsic_index: number | null; event_name: string; who: string; asset_id: number; amount: string; asset_b: number; pool_acc: string; asset_refs: number[] }>()
      await fillMissingLiquidityAmounts(raw)
      const seen = new Set<string>()
      const out: ActivityRow[] = []
      const createCands: { row: ActivityRow; pool: string; assetB: number }[] = []
      for (const r of raw) {
        const key = `${r.block_height}:${r.event_index}`
        if (seen.has(key)) continue
        seen.add(key)
        const a = asset(r.asset_id)
        const row: ActivityRow = {
          type: 'liquidity', blockHeight: r.block_height, timestamp: r.ts, eventIndex: r.event_index, extrinsicIndex: r.extrinsic_index,
          who: r.who ? accountRef(r.who) : null, to: null, asset: a, assetIn: null, assetOut: null,
          ...liquidityRowAmount(r.event_name, prices, a.assetId, r.amount, a.decimals), amountIn: null, amountOut: null,
          assetRefs: r.asset_refs,
          liqAction: liqActionFor(r.event_name),
        }
        if (r.event_name === 'XYK.PoolCreated') createCands.push({ row, pool: r.pool_acc, assetB: r.asset_b })
        out.push(row)
      }
      await enrichPoolCreations(createCands)
      await applyHistoricalUsd(out, activityHistPick)
      return out
    }
    if (postFilter) {
      // Token is already enforced SQL-side over asset_refs — the post-match
      // re-checks just the value threshold.
      const rowFilters = rowLevelFilters(filters)
      const rows = await fetchFilteredDeep(tw, want, (bound, pageLimit) => fetchPage(bound, pageLimit, 0),
        r => activityRowMatchesFilters(r, rowFilters), r => r.blockHeight, r => r.eventIndex ?? -1, r => `${r.blockHeight}:${r.eventIndex}`)
      return rows.slice(offset, offset + limit)
    }
    return withFeedWindow(tw, limit, offset + limit, (bound) => fetchPage(bound, limit, offset))
  })
}
interface XcmNetworkMeta { name: string; subscan?: string; ss58?: number }
// A parachain's product name, for surfaces that hold a bare para id — a sibling
// sovereign account, an XCM leg. Falls back to the id so an unlisted chain is
// still named rather than blank.
export function parachainName(paraId: number): string {
  return PARACHAIN_META[paraId]?.name ?? `Parachain ${paraId}`
}
const RELAY_XCM_NETWORK: XcmNetworkMeta = { name: 'Kusama', subscan: 'https://kusama.subscan.io', ss58: 2 }
// Counterparty metadata for the Kusama parachains Basilisk exchanges XCM with.
// Basilisk is itself para 2090 on Kusama, so this table is the Kusama relay's, not
// the Polkadot relay's — a Polkadot id read against these ids names a different
// chain entirely (2004 is Moonbeam there and Khala here).
//
// `ss58` is present only where the chain's prefix is in @substrate/ss58-registry or
// is the relay's own; a missing prefix falls back to Kusama's 2 in
// externalAccountRef, which is what a Kusama-relay chain without a registered
// prefix uses anyway. Moonriver is deliberately absent from it: its accounts are
// H160, so an AccountId32 arriving from there has no meaningful Moonriver SS58.
//
// `subscan` is present only where Subscan still serves that chain — most Kusama
// parachain explorers have been retired, and a link to a 404 is worse than a plain
// name. Name-only entries render the chain and skip the deep link.
const PARACHAIN_META: Record<number, XcmNetworkMeta> = {
  1000: { name: 'AssetHub', subscan: 'https://assethub-kusama.subscan.io', ss58: 2 },
  2000: { name: 'Karura', ss58: 8 },
  2001: { name: 'Bifrost', ss58: 6 },
  2004: { name: 'Khala', ss58: 30 },
  2007: { name: 'Shiden', subscan: 'https://shiden.subscan.io', ss58: 5 },
  2015: { name: 'Integritee', ss58: 13 },
  2023: { name: 'Moonriver', subscan: 'https://moonriver.subscan.io' },
  2048: { name: 'Robonomics', subscan: 'https://robonomics.subscan.io', ss58: 32 },
  2084: { name: 'Calamari', ss58: 78 },
  2087: { name: 'Picasso', ss58: 49 },
  2090: { name: 'Basilisk', ss58: 10041 },
  2092: { name: 'Kintsugi', ss58: 2092 },
  2095: { name: 'Quartz', ss58: 255 },
  2105: { name: 'Crab' },
  2110: { name: 'Mangata' },
  2114: { name: 'Turing' },
}
function junctionValue<T = unknown>(j: unknown, key: string): T | undefined {
  const o = j as Record<string, unknown> | undefined
  const v = o?.[key] ?? (o?.value as Record<string, unknown> | undefined)?.[key]
  return v as T | undefined
}
function hexString(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const h = v.toLowerCase()
  return /^0x[0-9a-f]+$/.test(h) ? h : null
}
// Bare H160 (an AccountKey20 junction's raw key) → the canonical AccountId32 join
// key tags and identity are keyed by. A reserved module/sibling/para truncation
// resolves to its real substrate account; anything else stays the bare H160, which
// is what the row displays anyway — it belongs to a chain whose accounts are 20
// bytes wide, and there is no local AccountId32 it could stand for.
function h160AccountId(h160: string): string {
  return reservedH160AccountId(h160.slice(2)) ?? h160
}
// Display ref for an account on ANOTHER chain. Displayed address is ALWAYS the
// Kusama form (prefix 2) for AccountId32 — Basilisk sits on the Kusama relay, so
// that is the neutral form a reader of this explorer recognises, one identity per
// pubkey across the relay's chains — and the bare H160 for AccountKey20. The
// subscan deep-link still uses the chain's own SS58 encoding where the table knows
// it. The icon and any local tag/identity are resolved exactly like a local
// account's (same pubkey → same emoji/tag/identity), via the same
// tagForAccount/identityForAccount pipeline accountRef uses.
function externalAccountRef(raw: unknown, meta: XcmNetworkMeta | undefined): ActivityRow['destAccount'] {
  const h = hexString(raw)
  if (!h) return undefined
  if (h.length === 66) {
    let address = h
    let chainAddress = h
    try {
      address = encodeAddress(hexToU8a(h), KUSAMA_SS58_PREFIX)
      chainAddress = encodeAddress(hexToU8a(h), meta?.ss58 ?? KUSAMA_SS58_PREFIX)
    } catch { /* keep raw account id */ }
    const resolved = h
    const icon = accountIcon(resolved)
    const t = tagForAccount(resolved)
    const id = identityForAccount(resolved)
    return {
      kind: 'AccountId32', accountId: resolved, raw: h, address, subscanUrl: meta?.subscan ? `${meta.subscan}/account/${encodeURIComponent(chainAddress)}` : null,
      emoji: icon.emoji, emojiName: icon.emojiName, emojiUrl: icon.emojiUrl,
      tag: t ? { id: t.tagId, name: t.name, color: t.color, icon: t.icon, memberCount: t.memberCount } : null,
      identity: id ? { display: id.display, verified: id.verified } : null,
    }
  }
  if (h.length === 42) {
    const resolved = h160AccountId(h)
    const icon = accountIcon(resolved)
    const t = tagForAccount(resolved)
    const id = identityForAccount(resolved)
    return {
      kind: 'AccountKey20', accountId: resolved, raw: h, address: h, subscanUrl: meta?.subscan ? `${meta.subscan}/account/${encodeURIComponent(h)}` : null,
      emoji: icon.emoji, emojiName: icon.emojiName, emojiUrl: icon.emojiUrl,
      tag: t ? { id: t.tagId, name: t.name, color: t.color, icon: t.icon, memberCount: t.memberCount } : null,
      identity: id ? { display: id.display, verified: id.verified } : null,
    }
  }
  return undefined
}
function xcmDestination(args: { dest?: { parents?: number; interior?: { value?: unknown } } }): Pick<ActivityRow, 'destChain' | 'destParachainId' | 'destAccount'> {
  const di = args.dest?.interior?.value
  const junctions = Array.isArray(di) ? di as Record<string, unknown>[] : []
  const pc = junctions.find(x => x.__kind === 'Parachain')
  const paraId = junctionValue<number>(pc, 'value') ?? null
  const meta = paraId != null ? (PARACHAIN_META[paraId] ?? { name: `Parachain ${paraId}` }) : args.dest?.parents === 1 ? RELAY_XCM_NETWORK : undefined
  const account32 = junctions.find(x => x.__kind === 'AccountId32')
  const account20 = junctions.find(x => x.__kind === 'AccountKey20')
  const destAccount = externalAccountRef(junctionValue(account32, 'id') ?? junctionValue(account20, 'key'), meta)
  return { destChain: meta?.name, destParachainId: paraId, destAccount }
}
// A multilocation interior's junction list — X1 is a single object in XCM v3,
// an array in v4; Here has no value.
function xcmJunctions(interior: unknown): Record<string, unknown>[] {
  const v = (interior as { value?: unknown } | undefined)?.value
  return Array.isArray(v) ? v as Record<string, unknown>[] : v && typeof v === 'object' ? [v as Record<string, unknown>] : []
}

// One outbound XCM transfer event, shape-normalized. XTokens.TransferredAssets
// (legacy) carries sender/assets/dest directly; PolkadotXcm.Sent (pallet_xcm,
// the dominant path) nests the sender in the origin junction and the amounts
// inside the message instructions.
// Amounts are RAW candidates — the caller maps each to a substrate asset by
// matching the same-extrinsic Currencies.Withdrawn, which also discards fee
// legs and chain-internal noise. Null = not a user-sent transfer.
export function parseOutboundXcm(argsRaw: unknown): { sender: string; amounts: string[]; dest: Pick<ActivityRow, 'destChain' | 'destParachainId' | 'destAccount'> } | null {
  const args = argsRaw as {
    sender?: string
    assets?: { fun?: { value?: string } }[]
    dest?: { parents?: number; interior?: { value?: unknown } }
    origin?: { interior?: unknown }
    destination?: { parents?: number; interior?: { value?: unknown } }
    message?: { __kind?: string; value?: unknown; assets?: unknown }[]
  } | null
  if (!args || typeof args !== 'object') return null

  if (typeof args.sender === 'string') {
    const amounts: string[] = []
    for (const leg of Array.isArray(args.assets) ? args.assets : []) {
      const amount = leg?.fun?.value
      if (amount && !amounts.includes(amount)) amounts.push(amount)
    }
    return { sender: args.sender, amounts, dest: xcmDestination(args) }
  }

  if (args.origin && Array.isArray(args.message)) {
    const oj = xcmJunctions(args.origin.interior)
    const acc32 = oj.find(j => j.__kind === 'AccountId32')
    // A local send's origin is an AccountId32; Basilisk has no EVM origin to map an
    // AccountKey20 onto, and inventing an account id for one would attribute the
    // send to an account that cannot exist. Left unresolved instead.
    const senderId = typeof acc32?.id === 'string' ? acc32.id : null
    if (!senderId) return null
    const amounts: string[] = []
    const feeAmounts = new Set<string>()
    for (const ins of args.message) {
      // BuyExecution names the asset consumed as the XCM execution fee (it is
      // withdrawn by WithdrawAsset too, so it would otherwise become a candidate).
      if (ins.__kind === 'BuyExecution') {
        const fee = (ins as { fees?: { fun?: { value?: string } } }).fees?.fun?.value
        if (typeof fee === 'string') feeAmounts.add(fee)
        continue
      }
      // Asset-carrying instructions only.
      const legs = ins.__kind === 'WithdrawAsset' || ins.__kind === 'ReserveAssetDeposited' ? ins.value
        : ins.__kind === 'TransferReserveAsset' ? ins.assets
        : null
      for (const leg of Array.isArray(legs) ? legs as { fun?: { value?: string } }[] : []) {
        const amount = leg?.fun?.value
        if (amount && !amounts.includes(amount)) amounts.push(amount)
      }
    }
    // Drop a fee-only leg: when the message withdraws more than one asset and one
    // of them is exactly the BuyExecution fee, that asset is plumbing (e.g. DOT
    // withdrawn only to pay for bridging USDC), not a transfer — so it must not
    // appear as its own cross-chain activity. A single-asset message keeps its
    // asset (it both transfers and pays its own fee).
    const transferAmounts = amounts.length > 1 ? amounts.filter(a => !feeAmounts.has(a)) : amounts
    const dest = xcmDestination({ dest: args.destination })
    // Sent's destination names only the chain; the beneficiary account lives in
    // the message's DepositAsset instruction.
    if (!dest.destAccount) {
      const dep = args.message.find(i => i.__kind === 'DepositAsset') as { beneficiary?: { interior?: unknown } } | undefined
      const bj = xcmJunctions(dep?.beneficiary?.interior)
      const b32 = bj.find(j => j.__kind === 'AccountId32')
      const b20 = bj.find(j => j.__kind === 'AccountKey20')
      const meta = dest.destParachainId != null ? PARACHAIN_META[dest.destParachainId] : dest.destChain === RELAY_XCM_NETWORK.name ? RELAY_XCM_NETWORK : undefined
      const id = typeof b32?.id === 'string' ? b32.id : typeof b20?.key === 'string' ? b20.key : undefined
      dest.destAccount = externalAccountRef(id, meta)
    }
    return { sender: senderId, amounts: transferAmounts.length ? transferAmounts : amounts, dest }
  }

  return null
}

function outboundXcmRow(
  event: { block_height: number; ts: string; event_index: number; extrinsic_index: number | null },
  sender: string,
  assetId: number,
  amount: string,
  destination: Pick<ActivityRow, 'destChain' | 'destParachainId' | 'destAccount'>,
  prices: Map<number, PriceInfo>,
): ActivityRow {
  const transferAsset = asset(assetId)
  return {
    type: 'xcm',
    blockHeight: event.block_height,
    timestamp: event.ts,
    eventIndex: event.event_index,
    extrinsicIndex: event.extrinsic_index,
    who: accountRef(sender),
    to: null,
    asset: transferAsset,
    assetIn: null,
    assetOut: null,
    amount,
    amountIn: null,
    amountOut: null,
    valueUsd: usdValue(prices, transferAsset.assetId, amount, transferAsset.decimals),
    xcmDir: 'out',
    ...destination,
    linkBlock: event.block_height,
    linkIndex: event.extrinsic_index,
  }
}

// Outbound cross-chain (XCM) transfers as activity rows. `XTokens.TransferredAssets`
// carries sender + dest parachain + per-asset amounts; the substrate asset_id is
// recovered by matching each leg amount to the same-extrinsic Currencies.Withdrawn
// (the multilocation's GeneralIndex is the destination chain's index, not ours).
// Inbound XCM is covered separately by getRecentXcmIn. When `accounts` is given
// the feed is scoped to that sender (account/tag page).
async function getRecentXcm(limit: number, from?: string, to?: string, accounts?: string[], offset = 0, filters: ValueListFilters = {}): Promise<ActivityRow[]> {
  const tw = timeWindow(from, to)
  const acctList = accounts && accounts.length ? sqlAccountList(accounts) : null
  return cached(`explorer:xcm-activity:${await liveHeadTag(Boolean(tw), datedWindowIsClosed(to))}:${limit}:${offset}:${from ?? ''}:${to ?? ''}:${acctList ?? ''}:${filterKey(filters)}`, tw ? 30000 : LIVE_CACHE_MS, async () => {
    const prices = await ensurePrices()
    const tokenIds = assetIdsForToken(filters.token)
    const senderFilter = acctList ? `AND sender IN (${acctList})` : ''
    const want = offset + limit
    let pageState: { scanned: number; cursor: { blockHeight: number; eventIndex: number } | null } = { scanned: 0, cursor: null }
    const fetchPage = async (pageBound: string, pageLimit: number): Promise<ActivityRow[]> => {
      const senderRefsFilter = acctList
        ? `AND ${accountActivityRefsSql(accounts!, `event_name IN (${XCM_SENT_EVENTS_SQL})`, pageBound, pageLimit)}`
        : ''
      // raw_xcm_activity is ordered (block_height, source_kind, source_index, name), so
      // this page's `block_height DESC, event_index DESC` is not a readable key order and
      // every candidate row is read and then sorted. What makes that expensive is the
      // PAYLOAD, not the sort: args_json is ZSTD(6) and ~350 B/row, and reading it for
      // every candidate cost 755 MiB to return one 25k page.
      //
      // The account-scoped page never paid that — `senderRefsFilter` already bounds the
      // read to one page of (block_height, event_index) keys resolved from the account
      // index. The global/window walk takes the same shape and resolves its own page of
      // keys from this table's key columns first, so args_json is decompressed only for
      // the rows the page returns. (block_height, event_index) is unique across every
      // `source_kind='event'` row, so the payload pass returns exactly the key pass's
      // rows, in the same order.
      const pageOrder = 'ORDER BY block_height DESC, event_index DESC LIMIT {limit:UInt32}'
      const xcmRows = `source_kind='event' AND name IN (${XCM_SENT_EVENTS_SQL}) AND event_index IS NOT NULL`
      const candidateBound = `${pageBound} ${senderRefsFilter} AND ${xcmRows} ${senderFilter}`
      const rowBound = acctList
        ? candidateBound
        : `(block_height, event_index) IN (
             SELECT block_height, event_index FROM price_data.raw_xcm_activity
             WHERE ${candidateBound} ${pageOrder}
           ) AND ${xcmRows}`
      const res = await client.query({
        query: `SELECT block_height, toString(block_timestamp) AS ts, extrinsic_index, event_index, name, args_json
                FROM price_data.raw_xcm_activity
                WHERE ${rowBound}
                  ${pageOrder}`,
        query_params: { limit: pageLimit }, format: 'JSONEachRow',
      })
      const evs = await res.json<{ block_height: number; ts: string; extrinsic_index: number | null; event_index: number; name: string; args_json: string }>()
      const last = evs.at(-1)
      pageState = { scanned: evs.length, cursor: last ? { blockHeight: last.block_height, eventIndex: last.event_index } : null }
      if (!evs.length) return []
      // Bound-parameter chunks: a widened deep-walk page can carry tens of
      // thousands of blocks, and an interpolated list would exceed max_query_size.
      const blocks = [...new Set(evs.map(event => event.block_height))]
      type WithdrawalRow = { block_height: number; extrinsic_index: number | null; cid: number; amount: string }
      const withdrawals: WithdrawalRow[] = []
      const legacyPairs: { block_height: number; extrinsic_index: number | null }[] = []
      const blockChunks = await mapChunksConcurrently(blocks, 2_000, CHUNK_QUERY_CONCURRENCY, async chunk => {
        const [wRes, legacyRes] = await Promise.all([
          client.query({
            query: `SELECT block_height, extrinsic_index,
                      asset_id AS cid,
                      amount AS amount
                    FROM ${xcmEventActivityTable()}
                    WHERE event_name='Currencies.Withdrawn' AND block_height IN {blocks:Array(UInt32)}
                      ${assetIdFilterSql('asset_id', tokenIds)}`,
            query_params: { blocks: chunk },
            format: 'JSONEachRow',
          }),
          client.query({
            query: `SELECT DISTINCT block_height, extrinsic_index
                    FROM price_data.raw_xcm_activity
                    WHERE block_height IN {blocks:Array(UInt32)} AND source_kind='event'
                      AND name IN (${XCM_SENT_XTOKENS_EVENTS_SQL})`,
            query_params: { blocks: chunk },
            format: 'JSONEachRow',
          }),
        ])
        return {
          withdrawals: await wRes.json<WithdrawalRow>(),
          legacy: await legacyRes.json<{ block_height: number; extrinsic_index: number | null }>(),
        }
      })
      for (const chunk of blockChunks) {
        withdrawals.push(...chunk.withdrawals)
        legacyPairs.push(...chunk.legacy)
      }
      const wmap = new Map<string, number>()
      for (const withdrawal of withdrawals) {
        wmap.set(`${withdrawal.block_height}:${withdrawal.extrinsic_index}:${withdrawal.amount}`, withdrawal.cid)
      }
      // The rare extrinsic emitting both events yields one row set: the legacy
      // event wins and the pallet_xcm mirror is suppressed.
      const xtokensExts = new Set(legacyPairs.map(event => `${event.block_height}:${event.extrinsic_index}`))
      const out: ActivityRow[] = []
      for (const event of evs) {
        if (event.name === 'PolkadotXcm.Sent' && xtokensExts.has(`${event.block_height}:${event.extrinsic_index}`)) continue
        const parsed = parseOutboundXcm(safeJson(event.args_json))
        if (!parsed) continue
        for (const amount of parsed.amounts) {
          const assetId = wmap.get(`${event.block_height}:${event.extrinsic_index}:${amount}`)
          if (assetId == null) continue
          out.push(outboundXcmRow(event, parsed.sender, assetId, amount, parsed.dest, prices))
        }
      }
      await applyHistoricalUsd(out, activityHistPick)
      return out
    }
    const rows = await fetchFilteredDeep(
      tw,
      want,
      fetchPage,
      row => activityRowMatchesFilters(row, filters),
      row => row.blockHeight,
      row => row.eventIndex ?? -1,
      row => `${row.blockHeight}:${row.eventIndex}:${row.asset?.assetId ?? -1}:${row.amount ?? ''}`,
      { pageState: () => pageState },
    )
    return rows.slice(offset, offset + limit)
  })
}

// The barrier events every XCM decode below pairs its legs with. MessageQueue.Processed
// closes every inbound message since the MessageQueue runtime migration (block
// 5,433,625); before it, DMP messages from the relay closed with
// DmpQueue.ExecutedDownward and HRMP messages from sibling parachains with
// XcmpQueue.Success/Fail — a decode that only knows the new barrier drops every
// pre-migration cross-chain transfer (~120k messages) on the floor. Nothing predates
// these four: before the first XcmpQueue/DmpQueue event (block 1,439,879) not one
// user-account hook deposit shares a block with a downward message — measured, all
// 24,800 of them are on-initialize reward/vesting credits, not XCM.
const XCM_BARRIER_EVENTS = ['MessageQueue.Processed', 'DmpQueue.ExecutedDownward', 'XcmpQueue.Success', 'XcmpQueue.Fail']
const XCM_BARRIER_EVENTS_SQL = XCM_BARRIER_EVENTS.map(n => `'${n}'`).join(',')
// Outbound send events. XTokens emitted TransferredMultiAssets until the same
// MessageQueue migration renamed it TransferredAssets; both carry the identical
// sender/assets/fee/dest payload (parseOutboundXcm's legacy branch), so every
// consumer treats the two names as one event.
const XCM_SENT_XTOKENS_EVENTS = ['XTokens.TransferredAssets', 'XTokens.TransferredMultiAssets']
const XCM_SENT_XTOKENS_EVENTS_SQL = XCM_SENT_XTOKENS_EVENTS.map(n => `'${n}'`).join(',')
const XCM_SENT_EVENTS_SQL = [...XCM_SENT_XTOKENS_EVENTS, 'PolkadotXcm.Sent'].map(n => `'${n}'`).join(',')
// The only trace an executor-dispatched send leaves behind; see emitsExecutedOutboundXcm
// for why the send list above cannot see those messages at all.
const XCM_EXECUTED_SEND_EVENT = 'XcmpQueue.XcmpMessageSent'
const isXTokensSentEvent = (name: string): boolean => XCM_SENT_XTOKENS_EVENTS.includes(name)
// The runtime sets `type XcmEventEmitter = ()`, so a message
// the xcm-EXECUTOR dispatches (InitiateReserveWithdraw, DepositReserveAsset,
// InitiateTransfer, ExportMessage) leaves only `XcmpQueue.XcmpMessageSent`;
// `PolkadotXcm.Sent` is deposited solely where pallet_xcm itself delivers. The send list
// above therefore cannot see the modern `PolkadotXcm.execute` / EVM-dispatch-precompile
// path at all — 2,974 extrinsics, and rising from ~120/month in 2025 to ~320/month.
//
// `alreadyClaimed` is the load-bearing half: 1,248 extrinsics carry BOTH markers (pallet_xcm
// delivered AND the executor queued the XCMP leg), and those already have a row from
// parseOutboundXcm — re-emitting doubles them. A SWAP row must NOT suppress the send,
// though: the SDK builds every fee-bearing bridge as
// `Utility.batch_all([Router.buy, PolkadotXcm.execute])`, so yielding to a trade row hid
// the bridge behind its own delivery-fee purchase.
//
// Kept as pure fns so the emit-time guard and any suppression site share one definition,
// the same way isDcaFeeLegSwap does.
export function emitsExecutedOutboundXcm(hasXcmpMessageSent: boolean, existingRowTypes: readonly string[]): boolean {
  return hasXcmpMessageSent && !existingRowTypes.includes('xcm')
}
// Once the send has a row, a swap in the same extrinsic is the delivery-fee purchase that
// funded it, not a trade the user made — the same extrinsic-keyed ownership
// suppressActivityPlumbing already applies to transfer legs. Confirmed on chain: fee-bearing
// bridges decode to `0x0d02` (Utility.batch_all) while standalone swaps are their own
// extrinsic.
export function isBridgePlumbingSwap(extrinsicSentXcm: boolean): boolean {
  return extrinsicSentXcm
}
// The two above serve the extrinsic page, which holds the whole event list. The FEED arms
// hold one page of rows and have to find their candidates in SQL, so they need the same
// decision expressed over sets of extrinsic keys: which marker extrinsics are NOT already
// covered by getRecentXcm. Same precedence as emitsExecutedOutboundXcm — the legacy arm
// wins the 1,248 both-marker extrinsics — reached from the other direction.
const executedXcmExtrinsicKey = (blockHeight: number, extrinsicIndex: number | null): string =>
  `${blockHeight}:${extrinsicIndex ?? 'b'}`
export function executedXcmSendExtrinsics(markerExts: readonly string[], legacyExts: readonly string[]): Set<string> {
  const legacy = new Set(legacyExts)
  return new Set(markerExts.filter(key => !legacy.has(key)))
}
// A fee-bearing bridge withdraws from the user AND from pallet pots (routerex on the fee
// swap, the destination's sovereign on the transfer leg). Only the user's leg is the
// economic action, so this is the one admission rule both the extrinsic page and the feed
// arm apply to a candidate withdrawal.
export function admitsExecutedXcmWithdrawal(who: string, amount: string): boolean {
  return Boolean(who) && Boolean(amount) && amount !== '0' && !RESERVED_ACCOUNT_RE.test(who)
}
// A send extrinsic emits exactly ONE message — 2,650 of 2,650 measured — so a bridge send is
// ONE activity, not one row per asset that left. Its other admitted withdrawal legs are the
// cost of the send: the XCM fee(s), plus the input leg of any Router call batched in to buy
// them. The executor withdraws in program order (WithdrawAsset/BuyExecution for the fees
// first, the payload last, and a batched Router leg runs before PolkadotXcm.execute at all),
// so the PAYLOAD is the highest-event_index leg.
//
// Population check: across every multi-leg send the legs this drops are the fee assets
// (BSX 0, KSM 1) and swap inputs, which is why it also keeps the right leg in the reverse
// shape — Router.sell(USDC->DOT) batched with a DOT send. Ordering beats value here: it needs
// no price (a missing price would silently elect the wrong leg) and it survives a payload
// smaller than its own fee. Folded per (extrinsic, ACCOUNT): ~40 sends withdraw from two
// accounts, and each account's feed must still show its own send.
export function executedXcmPayloadLegs<T>(legs: readonly T[], key: (leg: T) => string, order: (leg: T) => number): T[] {
  const payload = new Map<string, T>()
  for (const leg of legs) {
    const k = key(leg)
    const held = payload.get(k)
    if (!held || order(leg) > order(held)) payload.set(k, leg)
  }
  return [...payload.values()]
}
// The execution CONTEXT switched with the barrier names: since the migration,
// messages process in on_initialize (hook context, extrinsic_index NULL); before
// it, they processed inside the parachainSystem.set_validation_data INHERENT, so
// every old barrier and every credit/withdrawal it governs carries that inherent's
// extrinsic_index (measured: all 120,351 old barriers are extrinsic-context). A leg
// therefore only ever pairs with a barrier from its own context — without that
// rule, a hook-context DCA withdrawal sitting below an old inherent barrier in the
// same block would masquerade as a remote-initiated cross-chain pull.
const MESSAGE_QUEUE_MIGRATION_BLOCK = 5_433_625
// The old barriers execute in the inherent, so `extrinsic_index IS NULL` would drop
// them; MessageQueue.Processed stays hook-only (its rare extrinsic-context
// occurrences — ServiceQueues calls — were deliberately excluded before this).
const XCM_BARRIER_CONTEXT_SQL = `(extrinsic_index IS NULL OR event_name != 'MessageQueue.Processed')`
// Three of a barrier's fields are read — success, the message topic id, and the origin
// network — and `weightUsed`, which none of them reads, is about half the payload.
// Extract the three in SQL: the barrier is read for every block of every XCM page
// and account feed, 164,581 times over two weeks for 20.78 GiB of result bytes,
// and shipping the payload bought nothing but a JSON.parse per barrier row.
interface XcmBarrierRow { block_height: number; ts: string; event_index: number; extrinsic_index: number | null; succeeded: boolean; message_id: string; origin_kind: string; origin_value: number }
// `succeeded` per barrier era: MessageQueue names it in `success`; DmpQueue names it
// in `outcome.__kind` (anything but Complete executed partially or not at all);
// XcmpQueue splits it across two event names. The default stays "not explicitly
// false": a barrier that stops naming its outcome is still a barrier, and dropping
// it would drop the credits it terminates.
// `message_id`: MessageQueue `id`, DmpQueue/XcmpQueue `messageId`/`messageHash` —
// and the oldest XcmpQueue.Success rows are a bare JSON string holding the hash.
// `origin`: only MessageQueue carries one. DMP is from the relay by construction;
// an XCMP barrier is from a sibling parachain the old event never names.
const XCM_BARRIER_COLUMNS = `block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index,
              multiIf(
                event_name = 'DmpQueue.ExecutedDownward', toUInt8(JSONExtractString(args_json,'outcome','__kind') = 'Complete'),
                event_name = 'XcmpQueue.Fail', toUInt8(0),
                JSONHas(args_json,'success'), toUInt8(JSONExtractBool(args_json,'success')),
                toUInt8(1)) AS succeeded,
              multiIf(
                JSONType(args_json) = 'String', JSONExtractString(args_json),
                JSONHas(args_json,'id'), JSONExtractString(args_json,'id'),
                JSONHas(args_json,'messageId'), JSONExtractString(args_json,'messageId'),
                JSONExtractString(args_json,'messageHash')) AS message_id,
              multiIf(
                event_name = 'DmpQueue.ExecutedDownward', 'Parent',
                event_name IN ('XcmpQueue.Success','XcmpQueue.Fail'), 'SiblingUnknown',
                JSONExtractString(args_json,'origin','__kind')) AS origin_kind,
              JSONExtractUInt(args_json,'origin','value') AS origin_value`
// Origin network of an inbound XCM message (MessageQueue.Processed `origin`, or
// synthesized from the barrier's event name for the pre-MessageQueue eras).
function xcmOrigin(barrier: Pick<XcmBarrierRow, 'origin_kind' | 'origin_value'>): Pick<ActivityRow, 'fromChain' | 'fromParachainId'> {
  if (barrier.origin_kind === 'Parent') return { fromChain: RELAY_XCM_NETWORK.name, fromParachainId: null }
  if (barrier.origin_kind === 'Sibling') {
    const id = barrier.origin_value
    return { fromChain: (PARACHAIN_META[id] ?? { name: `Parachain ${id}` }).name, fromParachainId: id }
  }
  // Pre-MessageQueue XCMP: the sender is some sibling parachain, but the old event
  // carries no identity — say "Parachain" and no more rather than fabricate one.
  if (barrier.origin_kind === 'SiblingUnknown') return { fromChain: 'Parachain', fromParachainId: null }
  return {}
}
// The topic id as the explorer links it: a barrier without a hex topic has none.
function xcmMessageId(barrier: Pick<XcmBarrierRow, 'message_id'>): string | null {
  return barrier.message_id.startsWith('0x') ? barrier.message_id : null
}

// Inbound XCM detection. An incoming message executes outside any extrinsic and
// ends with a barrier event (XCM_BARRIER_EVENTS — MessageQueue.Processed names
// the origin chain; the pre-migration barriers name at most the relay). The
// beneficiary credit is the run of deposit events directly before that barrier:
// walk back while events stay in the deposit family, keep non-module/
// non-sovereign recipients, and fold the Currencies/Tokens/Balances mirror
// duplicates into one row per (who, currency, amount). A remote-execution
// message (Transact/swap) cuts the walk at its first non-deposit event, so only
// what the message actually credited to a user account surfaces.
const XCM_IN_DEPOSIT_EVENTS = ['Currencies.Deposited', 'Tokens.Deposited', 'Balances.Deposit']
const XCM_IN_WALK_EVENTS = [...XCM_IN_DEPOSIT_EVENTS, 'Balances.Issued', 'Balances.Endowed', 'Tokens.Endowed', 'Balances.Minted', 'System.NewAccount']
const RESERVED_ACCOUNT_RE = /^0x(6d6f646c|7369626c|70617261)/ // modl / sibl / para prefixes
const sqlEventNameList = (names: string[]): string => names.map(n => `'${n}'`).join(',')

// Events the XCM executor emits WHILE running a message, between the deposits it
// credits and the MessageQueue.Processed that closes it. The credit run steps over
// these; anything else ends it.
//
// `AssetsTrapped` is the one that matters: it is emitted when part of a message's
// assets cannot be delivered — a Snowbridge transfer whose DOT fee remainder could
// not be deposited traps it here — and it lands directly before the barrier, which
// is precisely where a contiguity rule cannot survive it.
//
// Deliberately NOT crossable: MessageQueue.*, DmpQueue.* and XcmpQueue.Success/Fail.
// Each of those closes or reports a DIFFERENT message, so crossing one would let a
// run reach into the message before it.
const XCM_WALK_CROSSABLE_EVENTS = [
  'PolkadotXcm.AssetsTrapped', 'PolkadotXcm.AssetsClaimed', 'PolkadotXcm.FeesPaid',
  'PolkadotXcm.Sent', 'PolkadotXcm.Attempted', 'PolkadotXcm.SupportedVersionChanged',
  'PolkadotXcm.VersionNotifyRequested', 'PolkadotXcm.VersionChangeNotified',
  'PolkadotXcm.VersionNotifyStarted', 'PolkadotXcm.VersionMigrationFinished',
  'XcmpQueue.XcmpMessageSent',
]

// The event indices one inbound message credited, walking back from its barrier.
//
// Two bounds, and both are needed. The run steps over XCM bookkeeping but stops at
// anything else, because the walk table holds EVERY hook-context deposit — including
// the on_initialize credits of DCA, staking and referral payouts, which belong to no
// message: dropping the stop rule and taking everything below the barrier would have
// swept 740,829 further walk events into inbound transfers to recover 511. And it
// never crosses the preceding barrier, so a block carrying several messages keeps
// each one's credits to itself.
export function xcmCreditRun(
  barrierIndex: number, previousBarrierIndex: number,
  inWalkFamily: (index: number) => boolean, crossable: (index: number) => boolean,
): number[] {
  const walked: number[] = []
  for (let idx = barrierIndex - 1; idx > previousBarrierIndex; idx--) {
    if (inWalkFamily(idx)) { walked.push(idx); continue }
    if (crossable(idx)) continue
    break
  }
  return walked
}

// Decode the inbound-XCM beneficiary credits of the given blocks (see above).
// `whoIn` restricts rows to those raw beneficiary account ids (account/tag page).
async function xcmInRowsForBlocks(blocks: number[], prices: Map<number, PriceInfo>, whoIn?: Set<string>): Promise<ActivityRow[]> {
  const list = sqlUIntList(blocks)
  if (!list) return []
  // Pre-migration blocks execute their messages inside the set_validation_data
  // inherent, so their family/crossable events are extrinsic-context and invisible
  // to the hook-only walk projection — they are read from the block-first parent
  // instead, and pairing matches each barrier's own context below.
  const oldList = sqlUIntList(blocks.filter(b => b < MESSAGE_QUEUE_MIGRATION_BLOCK))
  const [barRes, famRes, oldFamRes, crossRes] = await Promise.all([
    client.query({
      query: `SELECT ${XCM_BARRIER_COLUMNS}
              FROM ${xcmEventActivityTable()}
              WHERE block_height IN (${list}) AND event_name IN (${XCM_BARRIER_EVENTS_SQL}) AND ${XCM_BARRIER_CONTEXT_SQL}
              ORDER BY block_height DESC, event_index DESC`,
      format: 'JSONEachRow',
    }),
    // The deposit run is read for the WHOLE block, never scoped to the account: the
    // walk-back has to see every family event between the barrier and its credits, so
    // dropping another account's event out of the run would end the walk early and
    // lose credits behind it. Hence the block-first projection, where these blocks are
    // a primary-key read instead of eight whole event-name slices — and where
    // `extrinsic_index IS NULL` is the view's own filter rather than this predicate's,
    // because the projection holds only hook-context rows.
    //
    // Read the extracted columns rather than args_json: `who`, `asset_id` and
    // `amount` are exactly what the decode below consumes, and the payload is the
    // fattest column of the parent model (794 MiB of its 1.87 GiB, 6.18 GiB of its
    // 12 GiB uncompressed) on the read that touches the most rows of it.
    client.query({
      query: `SELECT block_height, event_index, event_name, who, asset_id, amount
              FROM ${xcmInboundWalkTable()}
              WHERE block_height IN (${list}) AND event_name IN (${sqlEventNameList(XCM_IN_WALK_EVENTS)})`,
      format: 'JSONEachRow',
    }),
    // Pre-migration family events (inherent context) from the parent model, which
    // filters names only, never context. Bounded exactly like the walk read: the
    // page's blocks against the parent's (event_name, asset_id, block_height) key.
    oldList
      ? client.query({
        query: `SELECT block_height, event_index, extrinsic_index, event_name, who, asset_id, amount
                FROM ${xcmEventActivityTable()}
                WHERE block_height IN (${oldList}) AND event_name IN (${sqlEventNameList(XCM_IN_WALK_EVENTS)})
                  AND extrinsic_index IS NOT NULL`,
        format: 'JSONEachRow',
      })
      : null,
    // The indices the run may step over (XCM_WALK_CROSSABLE_EVENTS). raw_events is
    // ordered (block_height, event_index), so this is the same bounded primary-key
    // read on the page's blocks that extrinsicIndexFor already does — and it is read
    // as a SET of indices, so an unmerged replay duplicate cannot change the outcome
    // and FINAL is not needed. Context follows the era: hook-only in the MessageQueue
    // era (so a run can never step out of hook context into an extrinsic's events),
    // inherent context included for pre-migration blocks (the pairing below still
    // requires the barrier's own context).
    client.query({
      query: `SELECT block_height, event_index, extrinsic_index
              FROM price_data.raw_events
              WHERE block_height IN (${list})
                AND (extrinsic_index IS NULL OR block_height < ${MESSAGE_QUEUE_MIGRATION_BLOCK})
                AND event_name IN (${sqlEventNameList(XCM_WALK_CROSSABLE_EVENTS)})`,
      format: 'JSONEachRow',
    }),
  ])
  const barriers = await barRes.json<XcmBarrierRow>()
  type WalkEvent = { event_name: string; who: string; asset_id: number; amount: string; ext: number | null }
  const byBlock = new Map<number, Map<number, WalkEvent>>()
  const addFamily = (e: { block_height: number; event_index: number; event_name: string; who: string; asset_id: number; amount: string }, ext: number | null): void => {
    const m = byBlock.get(e.block_height) ?? new Map<number, WalkEvent>()
    m.set(e.event_index, { event_name: e.event_name, who: e.who, asset_id: e.asset_id, amount: e.amount, ext })
    byBlock.set(e.block_height, m)
  }
  for (const e of await famRes.json<{ block_height: number; event_index: number; event_name: string; who: string; asset_id: number; amount: string }>()) addFamily(e, null)
  if (oldFamRes) for (const e of await oldFamRes.json<{ block_height: number; event_index: number; extrinsic_index: number; event_name: string; who: string; asset_id: number; amount: string }>()) addFamily(e, e.extrinsic_index)
  const crossableByBlock = new Map<number, Map<number, number | null>>()
  for (const e of await crossRes.json<{ block_height: number; event_index: number; extrinsic_index: number | null }>()) {
    const s = crossableByBlock.get(e.block_height) ?? new Map<number, number | null>()
    s.set(e.event_index, e.extrinsic_index)
    crossableByBlock.set(e.block_height, s)
  }
  // Every barrier in a block is a floor for the one above it, failed ones included: a
  // message that failed still ran, and its credits (if any) are its own.
  const barrierIdxByBlock = new Map<number, number[]>()
  for (const b of barriers) {
    const at = barrierIdxByBlock.get(b.block_height) ?? []
    at.push(b.event_index)
    barrierIdxByBlock.set(b.block_height, at)
  }
  for (const idxs of barrierIdxByBlock.values()) idxs.sort((l, r) => l - r)
  const rows: ActivityRow[] = []
  for (const b of barriers) {
    if (!b.succeeded) continue
    const from = xcmOrigin(b)
    const messageId = xcmMessageId(b)
    const evs = byBlock.get(b.block_height)
    const crossable = crossableByBlock.get(b.block_height)
    const blockBarriers = barrierIdxByBlock.get(b.block_height) ?? []
    const below = blockBarriers.filter(i => i < b.event_index)
    const floor = below.length ? below[below.length - 1] : -1
    const seen = new Set<string>()
    // A leg belongs to a barrier only in the barrier's own execution context: hook
    // legs to a hook barrier, the inherent's legs to that same inherent's barrier.
    const bExt = b.extrinsic_index ?? null
    const inFamily = (i: number): boolean => { const e = evs?.get(i); return e !== undefined && e.ext === bExt }
    const canCross = (i: number): boolean => { const c = crossable?.get(i); return c !== undefined && c === bExt }
    for (const idx of xcmCreditRun(b.event_index, floor, inFamily, canCross)) {
      const e = evs!.get(idx)!
      if (!XCM_IN_DEPOSIT_EVENTS.includes(e.event_name)) continue
      // `asset_id` already carries the 0 that Balances.Deposit has no currencyId for.
      const { who, amount, asset_id: cid } = e
      if (!who || !amount || amount === '0' || RESERVED_ACCOUNT_RE.test(who)) continue
      if (whoIn && !whoIn.has(who)) continue
      const key = `${who}:${cid}:${amount}`
      if (seen.has(key)) continue
      seen.add(key)
      const a = asset(cid)
      rows.push({
        type: 'xcm', blockHeight: b.block_height, timestamp: b.ts, eventIndex: idx, extrinsicIndex: null,
        who: accountRef(who), to: null, asset: a, assetIn: null, assetOut: null,
        amount, amountIn: null, amountOut: null, valueUsd: usdValue(prices, a.assetId, amount, a.decimals),
        xcmDir: 'in', ...from, messageId,
      })
    }
  }
  return rows.sort(compareActivityRowsNewestFirst)
}

// Remote-initiated OUTBOUND transfers: an inbound message (no local extrinsic,
// no PolkadotXcm.Sent) that withdraws from a local account and parks the funds
// in the initiating chain's sovereign — e.g. HOLLAR pulled to AssetHub from
// the AssetHub side. Detected as hook-context Currencies.Withdrawn rows
// attributed to the next successful barrier event in the block; the
// message origin is where the funds went. Fee withdrawals of the same message
// surface as their own (small) rows — factual parts of the remote operation.
async function xcmOutRemoteRowsForBlocks(blocks: number[], prices: Map<number, PriceInfo>, whoIn?: Set<string>): Promise<ActivityRow[]> {
  const list = sqlUIntList(blocks)
  if (!list) return []
  const [barRes, wdRes] = await Promise.all([
    client.query({
      query: `SELECT ${XCM_BARRIER_COLUMNS}
              FROM ${xcmEventActivityTable()}
              WHERE block_height IN (${list}) AND event_name IN (${XCM_BARRIER_EVENTS_SQL}) AND ${XCM_BARRIER_CONTEXT_SQL}
              ORDER BY block_height DESC, event_index ASC`,
      format: 'JSONEachRow',
    }),
    // Unlike the inbound deposit run, each withdrawal stands on its own — it is
    // paired with the block's next barrier, never with its neighbours — so an
    // account-scoped caller can prefilter on `who` in SQL and read the account-first
    // table, where (who, block_height) prunes to the account's own blocks instead
    // of scanning the whole Currencies.Withdrawn slice. `whoIn` below stays the
    // authority on membership, so this only shrinks the granules read. The extracted
    // columns replace args_json either way: this decode only ever read
    // who/currencyId/amount.
    whoIn
      ? client.query({
        query: `SELECT block_height, event_index, extrinsic_index, who, asset_id, amount
                FROM ${xcmEventActivityByAccountTable()}
                WHERE who IN (${sqlAccountList([...whoIn])}) AND block_height IN (${list})
                  AND event_name = 'Currencies.Withdrawn'
                  AND (extrinsic_index IS NULL OR block_height < ${MESSAGE_QUEUE_MIGRATION_BLOCK})`,
        format: 'JSONEachRow',
      })
      : client.query({
        query: `SELECT block_height, event_index, extrinsic_index, who, asset_id, amount
                FROM ${xcmEventActivityTable()}
                WHERE block_height IN (${list}) AND event_name = 'Currencies.Withdrawn'
                  AND (extrinsic_index IS NULL OR block_height < ${MESSAGE_QUEUE_MIGRATION_BLOCK})`,
        format: 'JSONEachRow',
      }),
  ])
  const barriersByBlock = new Map<number, XcmBarrierRow[]>()
  for (const b of await barRes.json<XcmBarrierRow>()) {
    const l = barriersByBlock.get(b.block_height) ?? []
    l.push(b)
    barriersByBlock.set(b.block_height, l)
  }
  const rows: ActivityRow[] = []
  const seen = new Set<string>()
  for (const w of await wdRes.json<{ block_height: number; event_index: number; extrinsic_index: number | null; who: string; asset_id: number; amount: string }>()) {
    const { who, amount, asset_id: cid } = w
    if (!who || !amount || amount === '0' || RESERVED_ACCOUNT_RE.test(who)) continue
    if (whoIn && !whoIn.has(who)) continue
    // Context-matched: a withdrawal pairs with the next barrier of its OWN execution
    // context — without this, a hook-context DCA withdrawal below an old inherent
    // barrier (or an old signed swap's withdrawal below nothing) would false-pair.
    const wExt = w.extrinsic_index ?? null
    const barrier = (barriersByBlock.get(w.block_height) ?? []).find(b => b.event_index > w.event_index && (b.extrinsic_index ?? null) === wExt)
    if (!barrier) continue
    if (!barrier.succeeded) continue
    const key = `${w.block_height}:${barrier.event_index}:${who}:${cid}:${amount}`
    if (seen.has(key)) continue
    seen.add(key)
    const origin = xcmOrigin(barrier)
    const a = asset(cid)
    rows.push({
      type: 'xcm', blockHeight: w.block_height, timestamp: barrier.ts, eventIndex: w.event_index, extrinsicIndex: null,
      who: accountRef(who), to: null, asset: a, assetIn: null, assetOut: null,
      amount, amountIn: null, amountOut: null, valueUsd: usdValue(prices, a.assetId, amount, a.decimals),
      xcmDir: 'out', destChain: origin.fromChain, destParachainId: origin.fromParachainId ?? null,
      messageId: xcmMessageId(barrier),
    })
  }
  return rows.sort(compareActivityRowsNewestFirst)
}

// Chunked reads exist to keep each query's result under the client's 100k
// max_result_rows guard (and each query's text under max_query_size). Both guards
// are per-query, so the chunks never had to wait for each other: the XCM decoders
// issued 92 chunk round-trips in one deep activity page, some of them GiB-scale,
// one at a time, and a filtered global page summed 51 s of ClickHouse time against
// a 37 s wall — essentially serial. Run a few at a time — the bound the aToken
// reconstruction already uses for heavy scans — and keep the results in chunk
// order, because callers concatenate the chunks and then sort on a key with ties,
// so chunk order is part of the response. Every caller here either concatenates in
// that order or folds the rows into a set/map keyed on the identities its own
// chunk carried, which no two chunks share; completion order cannot reach either.
//
// Worth knowing before chasing more of it: this removes the serial round-trips, not
// the page's wall time. On the deep account page only 3.1s of 10.0s is ClickHouse
// time at all, and these chunk bursts already ran at ~0.1 effective parallelism
// against their own summed query time — the span between the round-trips is
// TS-side assembly, which is where that page's remaining seconds live.
const CHUNK_QUERY_CONCURRENCY = 4

export async function mapChunksConcurrently<T, R>(
  items: T[],
  chunkSize: number,
  concurrency: number,
  run: (chunk: T[]) => Promise<R>,
): Promise<R[]> {
  const chunks: T[][] = []
  for (let start = 0; start < items.length; start += chunkSize) chunks.push(items.slice(start, start + chunkSize))
  const out = new Array<R>(chunks.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < chunks.length) { const index = next++; out[index] = await run(chunks[index]) }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker))
  return out
}

async function fetchDecodedXcmDeep(
  base: string,
  want: number,
  fetchBlocks: (bound: string, limit: number) => Promise<{ block_height: number }[]>,
  decode: (blocks: number[]) => Promise<ActivityRow[]>,
  matches: (row: ActivityRow) => boolean,
  tailKey?: string,
): Promise<ActivityRow[]> {
  const walk = async (base: string): Promise<ActivityRow[]> => {
    const out: ActivityRow[] = []
    let cursor: number | null = null
    const initialPageSize = Math.min(Math.max(want * 2, 500), 5_000)
    for (let page = 0; ; page++) {
      const bound = cursor == null ? base : `(${base}) AND block_height < ${cursor}`
      const pageSize = Math.min(initialPageSize * 2 ** Math.min(page, 16), 5_000)
      const candidates = await fetchBlocks(bound, pageSize)
      const blocks = [...new Set(candidates.map(row => Number(row.block_height)).filter(Number.isSafeInteger))]
      const rows: ActivityRow[] = []
      for (const chunk of await mapChunksConcurrently(blocks, 1_000, CHUNK_QUERY_CONCURRENCY, decode)) rows.push(...chunk)
      await applyHistoricalUsd(rows, activityHistPick)
      out.push(...rows.filter(matches))
      if (out.length >= want || candidates.length < pageSize) break
      const next = blocks.length ? Math.min(...blocks) : null
      if (next == null || (cursor != null && next >= cursor)) break
      cursor = next
    }
    return out.sort((left, right) =>
      right.blockHeight - left.blockHeight || (right.eventIndex ?? 0) - (left.eventIndex ?? 0))
  }
  // Unbounded candidate reads have to sort the whole event-name slice of
  // xcm_event_activity to take their newest rows — the table sorts by
  // (event_name, asset_id, block_height, …), so block order is not available for a
  // short-circuit and one global activity page read 1.15 GiB / 17.2M rows. Try a
  // recency window first exactly like withFeedWindow, and fall back to full history
  // when it underfills, so no page ever sees only "an hour of chain".
  if (base !== '1') return walk(base)
  const recent = await walk(feedWindowBoundSql())
  if (recent.length >= want) return recent
  if (!tailKey) return walk('1')
  // A sparse arm underfills its recent window on EVERY live rebuild — its newest
  // matching rows are simply old — so the head-keyed outer cache re-ran this
  // full-history walk once per ingested block (the xcm-out-remote arm alone read
  // ~340 MiB per feed poll). Everything the full walk can see beyond the live
  // window is immutable chain history: only a backfill changes it. So the full
  // walk is refreshed on the shared window TTL instead, and the LIVE recent rows
  // are merged over it — a new matching event still appears the block it lands,
  // through `recent`, while the immutable tail stops being recomputed per block.
  const full = await cachedSwr(
    `explorer:xcm-deep-tail:${tailKey}:${want}`, ACTIVITY_WINDOW_FRESH_MS, ACTIVITY_WINDOW_STALE_MS, () => walk('1'))
  const seen = new Set(recent.map(row => `${row.blockHeight}:${row.eventIndex ?? ''}:${row.extrinsicIndex ?? ''}`))
  // Copies: the cached tail's rows are shared across requests, and downstream
  // enrichment writes to the rows it is handed.
  return [...recent, ...full.filter(row => !seen.has(`${row.blockHeight}:${row.eventIndex ?? ''}:${row.extrinsicIndex ?? ''}`))]
    .map(row => ({ ...row }))
    .sort((left, right) =>
      right.blockHeight - left.blockHeight || (right.eventIndex ?? 0) - (left.eventIndex ?? 0))
}

async function getRecentXcmOutRemote(limit: number, from?: string, to?: string, accounts?: string[], offset = 0, filters: ValueListFilters = {}): Promise<ActivityRow[]> {
  const tw = timeWindow(from, to)
  const acctList = accounts && accounts.length ? sqlAccountList(accounts) : null
  return cached(`explorer:xcmoutr-activity:${await liveHeadTag(Boolean(tw), datedWindowIsClosed(to))}:${limit}:${offset}:${from ?? ''}:${to ?? ''}:${acctList ?? ''}:${filterKey(filters)}`, tw ? 30000 : LIVE_CACHE_MS, async () => {
    if (acctList === "''") return []
    const prices = await ensurePrices()
    const bound = tw ?? '1'
    const want = offset + limit
    const tokenIds = assetIdsForToken(filters.token)
    const candidateAsset = 'asset_id'
    const candidateAmount = 'amount'
    const candidateWho = 'who'
    const candidateValue = eventValueFilterSql(candidateAsset, candidateAmount, 'block_timestamp', filters, prices, 'xcm_remote_price')
    const candidateToken = assetIdFilterSql(candidateAsset, tokenIds)
    // Account-scoped: the account-first table makes `who IN (…)` the sort-key
    // prefix, so `ORDER BY block_height DESC … LIMIT n` is a reverse primary-key
    // read of that account's own rows. It carries the SAME reserved-account
    // exclusion the global arm does, for the same reason: the decode below drops
    // every module/sovereign beneficiary, so their candidate blocks can only cost
    // work. Stating it here is what keeps a structural pot bounded — the Omnipool
    // pallet account holds millions of hook-context rows and none of them can
    // become a row.
    const fetchBlocks = acctList
      ? async (pageBound: string, pageLimit: number) => {
        const res = await client.query({
          query: `SELECT block_height FROM ${xcmEventActivityByAccountTable()}
                  ${candidateValue.joinSql}
                  WHERE ${pageBound}
                    AND ${candidateWho} IN (${acctList})
                    AND event_name = 'Currencies.Withdrawn' AND (extrinsic_index IS NULL OR block_height < ${MESSAGE_QUEUE_MIGRATION_BLOCK})
                    AND NOT match(${candidateWho}, '${RESERVED_ACCOUNT_RE.source}')
                    ${candidateToken} ${candidateValue.predicateSql}
                  ORDER BY block_height DESC, event_index DESC LIMIT {limit:UInt32}`,
          query_params: { limit: pageLimit }, format: 'JSONEachRow',
        })
        return res.json<{ block_height: number }>()
      }
      : async (pageBound: string, pageLimit: number) => {
        const res = await client.query({
          query: `SELECT block_height FROM ${xcmEventActivityTable()}
                  ${candidateValue.joinSql}
                  WHERE ${pageBound}
                    AND event_name = 'Currencies.Withdrawn' AND (extrinsic_index IS NULL OR block_height < ${MESSAGE_QUEUE_MIGRATION_BLOCK})
                    AND NOT match(${candidateWho}, '${RESERVED_ACCOUNT_RE.source}')
                    ${candidateToken} ${candidateValue.predicateSql}
                  ORDER BY block_height DESC, event_index DESC LIMIT {limit:UInt32}`,
          query_params: { limit: pageLimit }, format: 'JSONEachRow',
        })
        return res.json<{ block_height: number }>()
      }
    const whoIn = accounts && accounts.length ? new Set(accounts) : undefined
    const rows = await fetchDecodedXcmDeep(
      bound,
      want,
      fetchBlocks,
      blocks => xcmOutRemoteRowsForBlocks(blocks, prices, whoIn),
      row => activityRowMatchesFilters(row, filters),
      `xcmoutr:${acctList ?? ''}:${filterKey(filters)}`,
    )
    return rows.slice(offset, offset + limit)
  })
}

// Executor-dispatched OUTBOUND sends: a SIGNED extrinsic whose message left through the xcm
// executor rather than through pallet_xcm's own delivery, so `XcmpQueue.XcmpMessageSent` is
// its only trace. raw_xcm_activity.sender is NULL on all 271,574 of those rows (versus 0 of
// the XTokens rows), which is why getRecentXcm's `sender IN (…)` scoping cannot reach one:
// there is nothing to match on. So this arm inverts the lookup. The user's own
// Currencies.Withdrawn rows are what actually left the chain, so THEY are the row identity
// and the marker is only a filter — and since `who` is the sort-key prefix of the account
// projection, that makes the account-scoped read a reverse primary-key walk of the account's
// own rows, the same shape every other account-scoped XCM arm uses.
//
// The arbitrary XCM program is not decoded, so the destination stays unresolved rather than
// guessed, per the "keep unresolved XCM explicit" rule. The extrinsic page emits the
// identical rows from the events it already holds (see emitsExecutedOutboundXcm).
async function xcmExecutedRowsForBlocks(blocks: number[], prices: Map<number, PriceInfo>, whoIn?: Set<string>): Promise<ActivityRow[]> {
  const list = sqlUIntList(blocks)
  if (!list) return []
  // The marker read first, alone. `xcm_event_activity` is keyed
  // (event_name, asset_id, block_height, …), and naming an event family without
  // an asset leaves block_height unreachable — so the withdrawal read prunes
  // nothing and scans every asset range of Currencies.Withdrawn, which is what
  // put it at 25s on a wide candidate window. Running it AFTER the markers costs
  // one round trip and pays for it many times over: the rows that survive are
  // exactly those in a CLAIMED extrinsic, so the block set shrinks from every
  // candidate block to the few that actually sent a message through the executor.
  // The `claimed` filter below is unchanged and still decides membership.
  const sendRes = await client.query({
    // Both marker families in one read: which of this block's extrinsics sent a message,
    // and which of those getRecentXcm already covers. `extrinsic_index IS NOT NULL` keeps
    // the 5,497 hook-context marker rows out — a remote-initiated send has no local
    // extrinsic and belongs to xcmOutRemoteRowsForBlocks.
    query: `SELECT DISTINCT block_height, extrinsic_index, name
            FROM price_data.raw_xcm_activity
            WHERE block_height IN (${list}) AND source_kind = 'event' AND extrinsic_index IS NOT NULL
              AND name IN ('${XCM_EXECUTED_SEND_EVENT}', ${XCM_SENT_EVENTS_SQL})`,
    format: 'JSONEachRow',
  })
  const markerExts: string[] = []
  const legacyExts: string[] = []
  const claimedBlocks = new Set<number>()
  for (const send of await sendRes.json<{ block_height: number; extrinsic_index: number | null; name: string }>()) {
    const key = executedXcmExtrinsicKey(send.block_height, send.extrinsic_index)
    if (send.name === XCM_EXECUTED_SEND_EVENT) markerExts.push(key)
    else legacyExts.push(key)
    claimedBlocks.add(send.block_height)
  }
  const claimed = executedXcmSendExtrinsics(markerExts, legacyExts)
  if (!claimed.size) return []
  const withdrawalColumns = 'block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, who, asset_id, amount'
  const claimedList = sqlUIntList([...claimedBlocks])
  if (!claimedList) return []
  const withdrawalBound = `block_height IN (${claimedList}) AND event_name = 'Currencies.Withdrawn' AND extrinsic_index IS NOT NULL`
  // Same account-first/parent split, and for the same reason, as the sibling arm:
  // `whoIn` stays the authority on membership, so prefiltering on `who` only shrinks
  // the granules read.
  const wdRes = await (whoIn
    ? client.query({
      query: `SELECT ${withdrawalColumns}
              FROM ${xcmEventActivityByAccountTable()}
              WHERE who IN (${sqlAccountList([...whoIn])}) AND ${withdrawalBound}`,
      format: 'JSONEachRow',
    })
    // Global arm: read raw_events, not the projection. `xcm_event_activity` is
    // keyed (event_name, asset_id, block_height, …) and this names an event
    // family with no asset, so block_height stays unreachable and it scans every
    // asset range of Currencies.Withdrawn whatever the block set — 2.00M rows
    // for the same 46. raw_events IS keyed by block_height, so the claimed
    // blocks prune it to 81.7k. The three extracted columns are the MV's own
    // expressions for this event, verified byte-identical over the same window;
    // Currencies.Withdrawn always carries `currencyId`, which is the only branch
    // of the MV's asset_id multiIf this family can take.
    : client.query({
      query: `SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index,
                     JSONExtractString(args_json, 'who') AS who,
                     toUInt32(greatest(0, JSONExtractInt(args_json, 'currencyId'))) AS asset_id,
                     JSONExtractString(args_json, 'amount') AS amount
              FROM price_data.raw_events
              WHERE ${withdrawalBound}`,
      format: 'JSONEachRow',
    }))
  const admitted = (await wdRes.json<{ block_height: number; ts: string; event_index: number; extrinsic_index: number | null; who: string; asset_id: number; amount: string }>())
    .filter(w => admitsExecutedXcmWithdrawal(w.who, w.amount)
      && (!whoIn || whoIn.has(w.who))
      && claimed.has(executedXcmExtrinsicKey(w.block_height, w.extrinsic_index)))
  const rows: ActivityRow[] = []
  // One row per send, per account: the fee legs are the cost of this row, not siblings of it.
  for (const w of executedXcmPayloadLegs(
    admitted,
    leg => `${executedXcmExtrinsicKey(leg.block_height, leg.extrinsic_index)}:${leg.who}`,
    leg => leg.event_index,
  )) {
    const { who, amount, asset_id: cid } = w
    const a = asset(cid)
    rows.push({
      type: 'xcm', blockHeight: w.block_height, timestamp: w.ts, eventIndex: w.event_index, extrinsicIndex: w.extrinsic_index,
      who: accountRef(who), to: null, asset: a, assetIn: null, assetOut: null,
      amount, amountIn: null, amountOut: null, valueUsd: usdValue(prices, a.assetId, amount, a.decimals),
      xcmDir: 'out', xcmExecuted: true, linkBlock: w.block_height, linkIndex: w.extrinsic_index,
    })
  }
  return rows.sort(compareActivityRowsNewestFirst)
}

async function getRecentXcmExecuted(limit: number, from?: string, to?: string, accounts?: string[], offset = 0, filters: ValueListFilters = {}): Promise<ActivityRow[]> {
  const tw = timeWindow(from, to)
  const acctList = accounts && accounts.length ? sqlAccountList(accounts) : null
  return cached(`explorer:xcmexec-activity:${await liveHeadTag(Boolean(tw), datedWindowIsClosed(to))}:${limit}:${offset}:${from ?? ''}:${to ?? ''}:${acctList ?? ''}:${filterKey(filters)}`, tw ? 30000 : LIVE_CACHE_MS, async () => {
    if (acctList === "''") return []
    const prices = await ensurePrices()
    const bound = tw ?? '1'
    const want = offset + limit
    const tokenIds = assetIdsForToken(filters.token)
    const candidateValue = eventValueFilterSql('asset_id', 'amount', 'block_timestamp', filters, prices, 'xcm_executed_price')
    const candidateToken = assetIdFilterSql('asset_id', tokenIds)
    // Only ~2,974 extrinsics in all of history sent this way, so an unpruned candidate walk
    // would read every Currencies.Withdrawn row (11.6M) to find them. The semi-join makes
    // the marker's own block set the bound instead: 271,574 key-ordered rows, one small
    // block_height set, and the candidate read then only touches blocks where a message
    // actually left. `pageBound` is pushed into it too — raw_xcm_activity carries both
    // block_height and block_timestamp — so a windowed page never builds the whole set.
    const markerBlocks = (pageBound: string): string =>
      `block_height IN (
         SELECT block_height FROM price_data.raw_xcm_activity
         WHERE (${pageBound}) AND source_kind = 'event' AND extrinsic_index IS NOT NULL
           AND name = '${XCM_EXECUTED_SEND_EVENT}'
       )`
    // Everything below the FROM is identical between the two arms; only the table and the
    // `who` prefilter differ, exactly as in getRecentXcmOutRemote. The reserved-account
    // exclusion is stated on both because admitsExecutedXcmWithdrawal drops those rows in
    // the decode anyway — carrying them as candidates could only cost work, and a
    // structural pot holds millions of withdrawals that can never become a row.
    const candidateTail = (pageBound: string): string =>
      `${candidateValue.joinSql}
       WHERE ${pageBound}
         AND event_name = 'Currencies.Withdrawn' AND extrinsic_index IS NOT NULL
         AND NOT match(who, '${RESERVED_ACCOUNT_RE.source}')
         AND ${markerBlocks(pageBound)}
         ${candidateToken} ${candidateValue.predicateSql}`
    const pageOrder = 'ORDER BY block_height DESC, event_index DESC LIMIT {limit:UInt32}'
    const fetchBlocks = async (pageBound: string, pageLimit: number) => {
      const res = await client.query({
        query: acctList
          ? `SELECT block_height FROM ${xcmEventActivityByAccountTable()}
             ${candidateTail(pageBound)} AND who IN (${acctList})
             ${pageOrder}`
          : `SELECT block_height FROM ${xcmEventActivityTable()}
             ${candidateTail(pageBound)}
             ${pageOrder}`,
        query_params: { limit: pageLimit }, format: 'JSONEachRow',
      })
      return res.json<{ block_height: number }>()
    }
    const whoIn = accounts && accounts.length ? new Set(accounts) : undefined
    const rows = await fetchDecodedXcmDeep(
      bound,
      want,
      fetchBlocks,
      blocks => xcmExecutedRowsForBlocks(blocks, prices, whoIn),
      row => activityRowMatchesFilters(row, filters),
      `xcmexec:${acctList ?? ''}:${filterKey(filters)}`,
    )
    return rows.slice(offset, offset + limit)
  })
}

// Inbound cross-chain (XCM) transfers as activity rows: what processed inbound
// messages credited to user accounts. When `accounts` is given the feed is
// scoped to those beneficiaries (account/tag page).
async function getRecentXcmIn(limit: number, from?: string, to?: string, accounts?: string[], offset = 0, filters: ValueListFilters = {}): Promise<ActivityRow[]> {
  const tw = timeWindow(from, to)
  const acctList = accounts && accounts.length ? sqlAccountList(accounts) : null
  return cached(`explorer:xcmin-activity:${await liveHeadTag(Boolean(tw), datedWindowIsClosed(to))}:${limit}:${offset}:${from ?? ''}:${to ?? ''}:${acctList ?? ''}:${filterKey(filters)}`, tw ? 30000 : LIVE_CACHE_MS, async () => {
    if (acctList === "''") return []
    const prices = await ensurePrices()
    const bound = tw ?? '1'
    const want = offset + limit
    const tokenIds = assetIdsForToken(filters.token)
    const candidateAsset = 'asset_id'
    const candidateAmount = 'amount'
    const candidateWho = 'who'
    const candidateValue = eventValueFilterSql(candidateAsset, candidateAmount, 'block_timestamp', filters, prices, 'xcm_in_price')
    const candidateToken = assetIdFilterSql(candidateAsset, tokenIds)
    // Candidate blocks: account-scoped from the account's own hook-context deposit
    // events, read account-first with the same reserved-account exclusion the global
    // arm carries (see getRecentXcmOutRemote for both); global from the newest
    // processed messages.
    const fetchBlocks = acctList
      ? async (pageBound: string, pageLimit: number) => {
        const res = await client.query({
          query: `SELECT block_height FROM ${xcmEventActivityByAccountTable()}
                  ${candidateValue.joinSql}
                  WHERE ${pageBound}
                    AND ${candidateWho} IN (${acctList})
                    AND event_name IN (${sqlEventNameList(XCM_IN_DEPOSIT_EVENTS)}) AND (extrinsic_index IS NULL OR block_height < ${MESSAGE_QUEUE_MIGRATION_BLOCK})
                    AND NOT match(${candidateWho}, '${RESERVED_ACCOUNT_RE.source}')
                    ${candidateToken} ${candidateValue.predicateSql}
                  ORDER BY block_height DESC, event_index DESC LIMIT {limit:UInt32}`,
          query_params: { limit: pageLimit }, format: 'JSONEachRow',
        })
        return res.json<{ block_height: number }>()
      }
      : async (pageBound: string, pageLimit: number) => {
        const res = await client.query({
          query: `SELECT block_height FROM ${xcmEventActivityTable()}
                  ${candidateValue.joinSql}
                  WHERE ${pageBound}
                    AND event_name IN (${sqlEventNameList(XCM_IN_DEPOSIT_EVENTS)}) AND (extrinsic_index IS NULL OR block_height < ${MESSAGE_QUEUE_MIGRATION_BLOCK})
                    AND NOT match(${candidateWho}, '${RESERVED_ACCOUNT_RE.source}')
                    ${candidateToken} ${candidateValue.predicateSql}
                  ORDER BY block_height DESC, event_index DESC LIMIT {limit:UInt32}`,
          query_params: { limit: pageLimit }, format: 'JSONEachRow',
        })
        return res.json<{ block_height: number }>()
      }
    const whoIn = accounts && accounts.length ? new Set(accounts) : undefined
    const rows = await fetchDecodedXcmDeep(
      bound,
      want,
      fetchBlocks,
      blocks => xcmInRowsForBlocks(blocks, prices, whoIn),
      row => activityRowMatchesFilters(row, filters),
      `xcmin:${acctList ?? ''}:${filterKey(filters)}`,
    )
    return rows.slice(offset, offset + limit)
  })
}

// Attach the source of inbound XCM rows (Ocelloids journey lookup by message
// topic id — see xcmJourneyService). Unmatched rows keep their hop-chain badge
// without a source pill.
// Explorer deep link for the journey's origin transaction: Subscan for
// substrate chains, the native explorer for other consensus systems.
// The EVM chains reachable through the bridges, by their own chain id. Naming these
// matters as much as linking them: an `ethereum:8453` journey read as plain
// "Ethereum" sent a reader to etherscan for a transaction that only exists on Base.
const EVM_CHAIN_META: Record<string, { name: string; explorer: string }> = {
  1: { name: 'Ethereum', explorer: 'https://etherscan.io' },
  8453: { name: 'Base', explorer: 'https://basescan.org' },
  42161: { name: 'Arbitrum', explorer: 'https://arbiscan.io' },
  10: { name: 'Optimism', explorer: 'https://optimistic.etherscan.io' },
  56: { name: 'BNB Chain', explorer: 'https://bscscan.com' },
  137: { name: 'Polygon', explorer: 'https://polygonscan.com' },
}
// A consensus system's own chain id is not always a number — Sui names itself by a
// hex digest — so the id stays a string and only the polkadot branch reads it as one.
function parseOcnUrn(urnStr: string): { consensus: string; chainId: string } | null {
  const urn = /^urn:ocn:([a-z0-9-]+):([0-9a-zA-Zx]+)$/.exec(urnStr)
  return urn ? { consensus: urn[1], chainId: urn[2] } : null
}
// Chain display name for either end of a journey, whatever consensus it sits in.
export function ocnChainName(urnStr: string): string | null {
  const parsed = parseOcnUrn(urnStr)
  if (!parsed) return null
  const { consensus, chainId } = parsed
  // PARACHAIN_META is the KUSAMA relay's table, so only a kusama-consensus urn may
  // be read through it. A Polkadot para id names a different chain at the same
  // number, and naming it from this table would assert the wrong counterparty
  // outright rather than leave it unresolved.
  if (consensus === 'kusama') {
    const paraId = Number(chainId)
    if (paraId === 0) return RELAY_XCM_NETWORK.name
    return (PARACHAIN_META[paraId] ?? { name: `Parachain ${paraId}` }).name
  }
  if (consensus === 'ethereum') return EVM_CHAIN_META[chainId]?.name ?? `EVM chain ${chainId}`
  if (consensus === 'solana') return 'Solana'
  if (consensus === 'sui') return 'Sui'
  if (consensus === 'polkadot') {
    const paraId = Number(chainId)
    return paraId === 0 ? 'Polkadot' : `Polkadot ${paraId}`
  }
  return null
}

export function originTxExplorerUrl(urnStr: string, txHash: string | null): string | null {
  if (!txHash) return null
  const parsed = parseOcnUrn(urnStr)
  if (!parsed) return null
  const { consensus, chainId } = parsed
  const isHex = /^0x[0-9a-fA-F]+$/.test(txHash)
  // Kusama only, for the same reason ocnChainName reads that arm alone: the table
  // is the Kusama relay's, so a Polkadot para id would deep-link into the wrong
  // chain's explorer.
  if (consensus === 'kusama') {
    if (!isHex) return null
    const paraId = Number(chainId)
    const meta = paraId === 0 ? RELAY_XCM_NETWORK : PARACHAIN_META[paraId]
    return meta?.subscan ? `${meta.subscan}/extrinsic/${txHash}` : null
  }
  if (consensus === 'ethereum') {
    const meta = EVM_CHAIN_META[chainId]
    return isHex && meta ? `${meta.explorer}/tx/${txHash}` : null
  }
  // Solana signatures are base58, not hex, so no hex test applies here.
  if (consensus === 'solana') return `https://solscan.io/tx/${encodeURIComponent(txHash)}`
  if (consensus === 'sui') return `https://suiscan.xyz/mainnet/tx/${encodeURIComponent(txHash)}`
  return null
}

function argStr(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  return typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'bigint' ? String(v) : ''
}
function argInt(args: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const n = Number(args[key])
    if (Number.isInteger(n)) return n
  }
  return 0
}

export interface VoteRow {
  // Conviction-weighted power, planck. Null for a collective vote, which has neither a
  // balance nor a conviction — no weight to report rather than a misleading zero.
  weighted?: string | null
  // Referendum identity + off-chain title, exactly as activity rows carry them, so the
  // votes tab renders through the same table instead of a look-alike of its own.
  voteRefPallet?: 'opengov' | 'democracy' | null
  voteRefTitle?: string | null
  blockHeight: number
  timestamp: string
  eventIndex: number
  extrinsicIndex: number | null
  account: AccountRef | null
  pallet: string
  action: string
  referendum: string | null
  side: string
  conviction: string | null
  amount: string | null
  asset: AssetRef
  valueUsd: number | null
}
const CONVICTION = ['None', 'Locked1x', 'Locked2x', 'Locked3x', 'Locked4x', 'Locked5x', 'Locked6x']
function decodeStandardVote(v: unknown): { side: string; conviction: string | null } {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  if (!Number.isFinite(n)) return { side: 'Vote', conviction: null }
  return { side: n >= 128 ? 'Aye' : 'Nay', conviction: CONVICTION[n & 0x7f] ?? `Conviction ${n & 0x7f}` }
}
type VoteDetails = { amount: string | null; side: string; conviction: string | null }
export function voteDetails(args: Record<string, unknown>): VoteDetails {
  const vote = args.vote as Record<string, unknown> | undefined
  if (!vote) return { amount: null, side: 'Vote', conviction: null }
  if (vote.__kind === 'Split') {
    const aye = argStr(vote, 'aye'), nay = argStr(vote, 'nay')
    const amount = /^\d+$/.test(aye) && /^\d+$/.test(nay) ? String(BigInt(aye) + BigInt(nay)) : null
    return { amount, side: 'Split', conviction: null }
  }
  if (vote.__kind === 'SplitAbstain') {
    const aye = argStr(vote, 'aye'), nay = argStr(vote, 'nay'), abstain = argStr(vote, 'abstain')
    const amount = /^\d+$/.test(aye) && /^\d+$/.test(nay) && /^\d+$/.test(abstain)
      ? String(BigInt(aye) + BigInt(nay) + BigInt(abstain))
      : null
    // The chain's own variant name, as the referendum voter list also reports it —
    // one token per side across both vote sources, which the UI maps to its label.
    return { amount, side: 'SplitAbstain', conviction: null }
  }
  const std = decodeStandardVote(vote.vote)
  return { amount: argStr(vote, 'balance') || null, ...std }
}
// Gasless app votes arrive as MultiTransactionPayment.dispatch_permit with the
// SCALE-encoded ConvictionVoting.vote call in the permit's `data` payload — the
// call tree never contains a ConvictionVoting.vote row, so the referendum index
// must be decoded from those bytes: [pallet u8, call u8, compact pollIndex,
// AccountVote]. Pallet/call indexes are runtime constants.
const CONVICTION_VOTING_PALLET_IDX = 0x24
const CONVICTION_VOTE_CALL_IDX = 0x00
// Wrapper calls whose args can carry a nested ConvictionVoting.vote.
const VOTE_WRAPPER_CALLS = ["'Proxy.proxy'", "'Proxy.proxy_announced'", "'Utility.batch'", "'Utility.batch_all'", "'Utility.force_batch'", "'Utility.as_derivative'", "'Multisig.as_multi'", "'Multisig.as_multi_threshold_1'"].join(',')
export function voteFromPermitData(dataHex: unknown): { ref: string; details: VoteDetails } | null {
  if (typeof dataHex !== 'string' || !dataHex.startsWith('0x')) return null
  const b = Buffer.from(dataHex.slice(2), 'hex')
  if (b.length < 4 || b[0] !== CONVICTION_VOTING_PALLET_IDX || b[1] !== CONVICTION_VOTE_CALL_IDX) return null
  let off = 2
  const mode = b[off] & 3
  let ref: number
  if (mode === 0) { ref = b[off] >> 2; off += 1 }
  else if (mode === 1) { ref = (b[off] | (b[off + 1] << 8)) >> 2; off += 2 }
  else if (mode === 2) { ref = (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 2; off += 4 }
  else return null
  // AccountVote::Standard { vote: u8, balance: u128 LE }; Split/SplitAbstain via
  // permit stay event-only (no referendum recoverable).
  if (b[off] !== 0x00 || b.length < off + 2 + 16) return null
  const voteByte = b[off + 1]
  let balance = 0n
  for (let i = 15; i >= 0; i--) balance = (balance << 8n) | BigInt(b[off + 2 + i])
  return { ref: String(ref), details: { amount: balance.toString(), ...decodeStandardVote(voteByte) } }
}
// ConvictionVoting.vote calls hidden inside wrapper args (Proxy.proxy,
// Utility.batch*, Multisig.as_multi, …): the decoded call tree is right there in
// the wrapper's JSON, so walk it. Used as a fallback when the nested call row
// itself is unavailable.
export function nestedVoteInfos(value: unknown, out: { ref: string; details: VoteDetails }[] = []): { ref: string; details: VoteDetails }[] {
  if (Array.isArray(value)) {
    for (const v of value) nestedVoteInfos(v, out)
    return out
  }
  if (value == null || typeof value !== 'object') return out
  const o = value as Record<string, unknown>
  if (o.__kind === 'ConvictionVoting') {
    const inner = o.value as Record<string, unknown> | undefined
    if (inner?.__kind === 'vote') {
      const ref = argStr(inner, 'pollIndex')
      if (ref) out.push({ ref, details: voteDetails(inner) })
      return out
    }
  }
  for (const v of Object.values(o)) nestedVoteInfos(v, out)
  return out
}
const CONVICTION_REMOVE_VOTE_CALL_IDX = 0x04
const UTILITY_PALLET_IDX = 0x0d
// Utility.batch, batch_all and force_batch: a compact item count, then the calls.
const UTILITY_BATCH_CALL_IDXS = new Set([0x00, 0x02, 0x04])
const REMOVAL_CALL_KINDS = new Set(['remove_vote', 'remove_other_vote', 'force_remove_vote'])

// The polls a gasless permit payload removes a vote from.
//
// A removal names its poll only on the CALL: ConvictionVoting.VoteRemoved carries the
// account and the vote it dropped, but no index. The permit carries the call as SCALE
// bytes rather than as a decoded row, so without this the removal cannot be attributed
// to a referendum at all.
//
// The app sends these as a Utility batch of remove_vote calls, usually with an unrelated
// Staking call last, so the batch is walked item by item and the walk STOPS at the first
// item that is not a removal: without runtime metadata there is no way to know how long
// another call is, and guessing an offset would invent poll indexes out of unrelated
// bytes. That costs nothing in practice — across all 23 permit payloads on the chain a
// byte-pattern scan finds no removal this walk misses, because the Staking call is last.
//
// remove_vote encodes `Option<Class>` then a PLAIN u32 poll index, where vote encodes a
// compact one — hence the separate decoder rather than a parameter on voteFromPermitData.
export function removalRefsFromPermitData(dataHex: unknown): string[] {
  if (typeof dataHex !== 'string' || !dataHex.startsWith('0x')) return []
  const b = Buffer.from(dataHex.slice(2), 'hex')
  let off = 0
  let items = 1
  if (b.length >= 2 && b[0] === UTILITY_PALLET_IDX && UTILITY_BATCH_CALL_IDXS.has(b[1])) {
    off = 2
    if (off >= b.length) return []
    const mode = b[off] & 3
    if (mode === 0) { items = b[off] >> 2; off += 1 }
    else if (mode === 1) { items = (b[off] | (b[off + 1] << 8)) >> 2; off += 2 }
    else if (mode === 2) { items = ((b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 2); off += 4 }
    else return []
  }
  const refs: string[] = []
  for (let i = 0; i < items; i++) {
    if (off + 2 > b.length || b[off] !== CONVICTION_VOTING_PALLET_IDX || b[off + 1] !== CONVICTION_REMOVE_VOTE_CALL_IDX) break
    off += 2
    // Option<Class>: None, or Some(u16).
    const some = b[off]
    off += 1
    if (some === 0x01) off += 2
    else if (some !== 0x00) break
    if (off + 4 > b.length) break
    refs.push(String(b.readUInt32LE(off)))
    off += 4
  }
  return refs
}
// ConvictionVoting removals hidden inside wrapper args (Utility.batch*, Proxy.proxy, …),
// the decoded-JSON counterpart of removalRefsFromPermitData. Same reason as
// nestedVoteInfos: the wrapper's own call row is all `raw_calls` kept, so the nested call
// is only readable from its JSON.
export function nestedRemovalRefs(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) nestedRemovalRefs(v, out)
    return out
  }
  if (value == null || typeof value !== 'object') return out
  const o = value as Record<string, unknown>
  if (o.__kind === 'ConvictionVoting') {
    const inner = o.value as Record<string, unknown> | undefined
    if (inner && REMOVAL_CALL_KINDS.has(String(inner.__kind))) {
      const ref = argStr(inner, 'index')
      if (ref) out.push(ref)
      return out
    }
  }
  for (const v of Object.values(o)) nestedRemovalRefs(v, out)
  return out
}
function mergeVoteDetails(primary: VoteDetails, fallback?: VoteDetails): VoteDetails {
  if (!fallback) return primary
  return {
    amount: primary.amount ?? fallback.amount,
    side: primary.side === 'Vote' ? fallback.side : primary.side,
    conviction: primary.conviction ?? fallback.conviction,
  }
}
function voteAmountSqlExpr(): string {
  const vote = `JSONExtractRaw(args_json,'vote')`
  const aye = `toUInt256OrZero(JSONExtractString(${vote},'aye'))`
  const nay = `toUInt256OrZero(JSONExtractString(${vote},'nay'))`
  const abstain = `toUInt256OrZero(JSONExtractString(${vote},'abstain'))`
  return `multiIf(
    JSONExtractString(${vote},'__kind') = 'Split', toString(${aye} + ${nay}),
    JSONExtractString(${vote},'__kind') = 'SplitAbstain', toString(${aye} + ${nay} + ${abstain}),
    JSONExtractString(${vote},'balance')
  )`
}
// A vote row's referendum, as the explorer needs it: the pallet slug its detail
// page and SubSquare link are keyed on, plus the off-chain title. This chain voted
// through both pallets and both index from 0, so the slug travels with the index.
// Council/Technical Committee votes carry a proposal hash rather than an index and
// are not referenda, so they get neither.
export function referendumRefFields(
  votePallet: string | null | undefined,
  voteRef: string | null | undefined,
): { voteRefPallet: 'opengov' | 'democracy' | null; voteRefTitle: string | null } {
  const pallet = votePallet === 'ConvictionVoting' ? 'opengov' : votePallet === 'Democracy' ? 'democracy' : null
  if (!pallet || !voteRef || !/^\d+$/.test(voteRef)) return { voteRefPallet: null, voteRefTitle: null }
  return { voteRefPallet: pallet, voteRefTitle: referendumTitleFor(pallet, voteRef) }
}

function voteRowMatchesFilters(row: VoteRow, filters: VoteListFilters): boolean {
  if (filters.referendum && row.referendum !== filters.referendum) return false
  if (filters.conviction && (row.conviction ?? '').toLowerCase() !== filters.conviction.toLowerCase()) return false
  return true
}
// Vote/wrapper call rows per `(block,extrinsic)` tuple, memoized below the
// ingested head like nttLogsFor's pairs: the rows are immutable chain history,
// but the head-keyed vote arm re-reads the same tuple list on every rebuild and
// each cold tuple costs a whole granule of raw_calls' fat args_json (~120 MiB
// per feed poll measured). Consumers only parse the rows, never write them, so
// the memo shares them; rows of one extrinsic stay in their returned order
// (they always come from a single tuple's read).
interface VoteCallRow { block_height: number; extrinsic_index: number | null; call_address: string; call_name: string; args_json: string }
const VOTE_CALLS_MEMO_MAX = 50_000
const VOTE_CALLS_FINALITY_MARGIN_BLOCKS = 600
const voteCallsMemo = new Map<string, VoteCallRow[]>()
async function voteCallRowsForTuples(tuples: string[]): Promise<VoteCallRow[]> {
  const out: VoteCallRow[] = []
  const misses: string[] = []
  for (const tuple of tuples) {
    const hit = voteCallsMemo.get(tuple)
    if (hit === undefined) misses.push(tuple)
    else out.push(...hit)
  }
  if (!misses.length) return out
  const memoFloor = (await indexedRawHead()) - VOTE_CALLS_FINALITY_MARGIN_BLOCKS
  // Chunked like every other tuple read here: the merged feed's vote arm asks
  // for as many candidates as the window is deep, and one interpolated list of
  // 20k tuples already crossed `max_query_size` and failed deep `type=all`
  // pages with a ClickHouse 500. The call-name filter keeps this at ~1.02 rows
  // per tuple (max 3 measured over every vote extrinsic), so the wider 5,000-key
  // chunk stays far below the client's result guard.
  const chunks = await mapChunksConcurrently(misses, 5_000, CHUNK_QUERY_CONCURRENCY, async chunk => {
    const calls = await client.query({
      query: `SELECT block_height, extrinsic_index, call_address, call_name, args_json
              FROM price_data.raw_calls
              WHERE (block_height, extrinsic_index) IN (${chunk.join(',')})
                AND call_name IN ('ConvictionVoting.vote', 'MultiTransactionPayment.dispatch_permit', ${VOTE_WRAPPER_CALLS})`,
      format: 'JSONEachRow',
    })
    return calls.json<VoteCallRow>()
  })
  const byTuple = new Map<string, VoteCallRow[]>(misses.map(tuple => [tuple, []]))
  for (const row of chunks.flat()) {
    byTuple.get(`(${row.block_height},${row.extrinsic_index})`)?.push(row)
    out.push(row)
  }
  for (const [tuple, rows] of byTuple) {
    if (Number(tuple.slice(1, tuple.indexOf(','))) > memoFloor) continue
    if (voteCallsMemo.size >= VOTE_CALLS_MEMO_MAX) {
      let drop = VOTE_CALLS_MEMO_MAX / 10
      for (const old of voteCallsMemo.keys()) { voteCallsMemo.delete(old); if (--drop <= 0) break }
    }
    voteCallsMemo.set(tuple, rows)
  }
  return out
}

async function getRecentVotes(limit: number, from?: string, to?: string, offset = 0, filters: VoteListFilters = {}, accounts?: string[], valueFilters: ValueListFilters = {}): Promise<VoteRow[]> {
  const tw = timeWindow(from, to)
  const acctList = accounts && accounts.length ? sqlAccountList(accounts) : null
  return cached(`explorer:votes:${await liveHeadTag(Boolean(tw), datedWindowIsClosed(to))}:${limit}:${offset}:${from ?? ''}:${to ?? ''}:${acctList ?? ''}:${filterKey(filters)}:${filterKey(valueFilters)}`, tw ? 30000 : LIVE_CACHE_MS, async () => {
    const prices = await ensurePrices()
    const bound = tw ?? '1'
    const eventFilter = "AND event_name IN ('ConvictionVoting.Voted','Democracy.Voted')"
    const tokenIds = assetIdsForToken(valueFilters.token)
    if (tokenIds != null && !tokenIds.includes(0)) return []
    const amountFilter = eventValueFilterSql('0', voteAmountSqlExpr(), 'block_timestamp', valueFilters, prices, 'vote_price')
    const postFilter = !!filters.referendum || !!filters.conviction || hasRowLevelFilter(valueFilters)
    const want = offset + limit
    const scanLimit = postFilter ? Math.max(want * 8, limit + 500) : limit
    const scanOffset = postFilter ? 0 : offset
    const accountRefsFilter = acctList && !postFilter && tokenIds == null && valueFilters.min == null
      ? `AND ${accountActivityRefsSql(accounts!, `event_name IN ('ConvictionVoting.Voted','Democracy.Voted')`, bound, scanOffset + scanLimit)}`
      : ''
    const accountFilter = acctList ? `AND (JSONExtractString(args_json,'who') IN (${acctList}) OR JSONExtractString(args_json,'voter') IN (${acctList}))` : ''
    const runVotes = async (b: string, pageLimit: number, pageOffset: number) => {
      const res = await client.query({
        query: `SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, ifNull(call_address, '') AS call_address, event_name, args_json
                FROM price_data.vote_activity FINAL
                ${amountFilter.joinSql}
                WHERE ${b} ${accountRefsFilter} ${eventFilter} ${accountFilter} ${amountFilter.predicateSql}
                ORDER BY block_height DESC, event_index DESC LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
        query_params: { limit: pageLimit, offset: pageOffset }, format: 'JSONEachRow',
      })
      return res.json<{ block_height: number; ts: string; event_index: number; extrinsic_index: number | null; call_address: string; event_name: string; args_json: string }>()
    }
    const buildRows = async (events: { block_height: number; ts: string; event_index: number; extrinsic_index: number | null; call_address: string; event_name: string; args_json: string }[]): Promise<VoteRow[]> => {
      const callTuples = [...new Set(events.filter(e => e.event_name === 'ConvictionVoting.Voted' && e.extrinsic_index != null).map(e => `(${e.block_height},${e.extrinsic_index})`))]
      const callByExact = new Map<string, { ref: string | null; details: VoteDetails }>()
      const callByExt = new Map<string, { ref: string | null; details: VoteDetails }>()
      const callsByExt = new Map<string, { ref: string | null; details: VoteDetails }[]>()
      if (callTuples.length) {
        const callRows = await voteCallRowsForTuples(callTuples)
        for (const c of callRows) {
          if (c.extrinsic_index == null) continue
          const args = (safeJson(c.args_json) ?? {}) as Record<string, unknown>
          // Gasless votes: the vote call hides SCALE-encoded in the permit payload.
          const info = c.call_name === 'MultiTransactionPayment.dispatch_permit'
            ? voteFromPermitData(args.data)
            : c.call_name === 'ConvictionVoting.vote'
              ? (() => { const ref = argStr(args, 'pollIndex'); return ref ? { ref, details: voteDetails(args) } : null })()
              : null
          if (!info) continue
          const extKey = `${c.block_height}:${c.extrinsic_index}`
          callByExact.set(`${c.block_height}:${c.extrinsic_index}:${c.call_address}`, info)
          if (!callsByExt.has(extKey)) callsByExt.set(extKey, [])
          callsByExt.get(extKey)!.push(info)
        }
        // Wrapper fallback (proxy/batch/multisig args carry the decoded vote call):
        // only for extrinsics without a direct vote/permit row. This also covers
        // retained historical rows where nested calls were not indexed separately.
        for (const c of callRows) {
          if (c.extrinsic_index == null || c.call_name === 'ConvictionVoting.vote' || c.call_name === 'MultiTransactionPayment.dispatch_permit') continue
          const extKey = `${c.block_height}:${c.extrinsic_index}`
          if (callsByExt.has(extKey)) continue
          const infos = nestedVoteInfos(safeJson(c.args_json))
          if (infos.length) callsByExt.set(extKey, infos)
        }
        for (const [key, infos] of callsByExt) if (infos.length === 1) callByExt.set(key, infos[0])
      }
      const bsx = asset(0)
      const out: VoteRow[] = []
      for (const e of events) {
        const args = (safeJson(e.args_json) ?? {}) as Record<string, unknown>
        const pallet = e.event_name.split('.')[0]
        const account = argStr(args, e.event_name === 'Democracy.Voted' ? 'voter' : 'who')
        const callInfo = e.extrinsic_index != null ? (callByExact.get(`${e.block_height}:${e.extrinsic_index}:${e.call_address}`) ?? callByExt.get(`${e.block_height}:${e.extrinsic_index}`)) : undefined
        const ref = e.event_name === 'Democracy.Voted'
          ? argStr(args, 'refIndex') || null
          : callInfo?.ref ?? null
        const details = mergeVoteDetails(voteDetails(args), callInfo?.details)
        const row: VoteRow = {
          blockHeight: e.block_height, timestamp: e.ts, eventIndex: e.event_index, extrinsicIndex: e.extrinsic_index,
          account: account && ACCOUNT_RE.test(account) ? accountRef(account) : null,
          pallet, action: 'Voted', referendum: ref, side: details.side, conviction: details.conviction, amount: details.amount,
          ...referendumRefFields(pallet, ref),
          weighted: weightedFromLabels(details.amount, details.conviction),
          asset: bsx, valueUsd: details.amount ? usdValue(prices, bsx.assetId, details.amount, bsx.decimals) : null,
        }
        out.push(row)
      }
      return out
    }
    if (postFilter) {
      // Referendum/conviction resolve from the joined vote CALL, not the event —
      // walk full history in pages until enough filtered rows exist instead of
      // post-filtering a recency window.
      // The identity filter is judged on the voter, so it belongs in the WALK's
      // matcher: applied afterwards it would trim a page the walk had already
      // declared full, and a category whose voters are mostly bare addresses
      // would return four rows where it promised twenty-five.
      const wantsNamed = valueFilters.identity ? valueFilters.identity === 'named' : null
      const deep = await fetchFilteredDeep(tw, want, async (b, pageLimit) => buildRows(await runVotes(b, pageLimit, 0)),
        r => voteRowMatchesFilters(r, filters) && (wantsNamed == null || accountIsNamed(r.account, valueFilters.viewerTagged) === wantsNamed),
        r => r.blockHeight, r => r.eventIndex, r => `${r.blockHeight}:${r.eventIndex}`)
      return deep.slice(offset, offset + limit)
    }
    const events = acctList ? await runVotes(bound, scanLimit, scanOffset) : await withFeedWindow(tw, scanLimit, scanOffset + scanLimit, (b) => runVotes(b, scanLimit, scanOffset))
    const out = (await buildRows(events)).filter(r => voteRowMatchesFilters(r, filters))
    return postFilter ? out.slice(offset, offset + limit) : out.slice(0, limit)
  })
}

// Collective (Council / Technical Committee) votes are too sparse (~3k events
// all-time) to justify extending the vote_activity model: read raw_events
// directly — the event-name set index plus the tiny row volume keep the scan
// bounded. These events carry no conviction, balance, or referendum index; the
// proposal hash (shortened) stands in for the referendum and the row carries no
// token amount.
const COLLECTIVE_VOTE_EVENTS = ['Council.Voted', 'TechnicalCommittee.Voted']
function shortProposalHash(hash: string): string {
  return /^0x[0-9a-f]+$/i.test(hash) && hash.length > 18 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash
}

export interface RawCollectiveVoteEvent {
  block_height: number
  ts: string
  event_index: number
  extrinsic_index: number | null
  event_name: string
  args_json: string
}

// One collective vote event as a VoteRow. Shared by the windowed source below and
// by the extrinsic/block detail page, so no two surfaces can describe the same
// event differently. `voted` is the chain's own boolean (aye = true).
export function collectiveVoteRow(e: RawCollectiveVoteEvent, native: AssetRef): VoteRow {
  const args = (safeJson(e.args_json) ?? {}) as Record<string, unknown>
  const account = argStr(args, 'account')
  const hash = argStr(args, 'proposalHash')
  return {
    blockHeight: e.block_height, timestamp: e.ts, eventIndex: e.event_index, extrinsicIndex: e.extrinsic_index,
    account: account && ACCOUNT_RE.test(account) ? accountRef(account) : null,
    pallet: e.event_name === 'Council.Voted' ? 'Council' : 'Technical Committee',
    action: 'Voted', referendum: hash ? shortProposalHash(hash) : null,
    side: args.voted === true ? 'Aye' : args.voted === false ? 'Nay' : 'Vote',
    conviction: null, amount: null, asset: native, valueUsd: 0,
  }
}

// The collective votes in one window (whole chain when `accounts` is absent, one
// account set when it is present). Bounded by the block window, the tiny
// event-name set and its own LIMIT — never a FINAL read or an unbounded join.
async function getCollectiveVotes(accounts: string[] | undefined, limit: number, from?: string, to?: string): Promise<VoteRow[]> {
  const list = accounts ? sqlAccountList(accounts) : null
  if (list === "''") return []
  const bound = timeWindow(from, to) ?? '1'
  const res = await client.query({
    query: `SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name, args_json
            FROM price_data.raw_events
            WHERE ${bound}
              AND event_name IN (${sqlEventNameList(COLLECTIVE_VOTE_EVENTS)})
              ${list ? `AND JSONExtractString(args_json,'account') IN (${list})` : ''}
            ORDER BY block_height DESC, event_index DESC
            LIMIT {limit:UInt32}`,
    query_params: { limit }, format: 'JSONEachRow',
  })
  const events = await res.json<RawCollectiveVoteEvent>()
  const bsx = asset(0)
  // raw_events is a ReplacingMergeTree read without FINAL; dedup any re-ingested
  // rows by (block, event_index) so a re-index can't emit a duplicate vote.
  const seen = new Set<string>()
  const out: VoteRow[] = []
  for (const e of events) {
    const key = `${e.block_height}:${e.event_index}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(collectiveVoteRow(e, bsx))
  }
  return out
}

// Whether a feed's value/token filter can admit a collective vote at all.
//
// A collective vote locks no capital: the row carries no amount and no USD value,
// so ANY value floor — USD or token units — rejects it on the built row, and the
// only asset a governance row is denominated in is BSX. A filtered feed therefore
// SKIPS the source instead of reading rows its own predicate would drop, and the
// vote category's exact total (getGlobalActivityTotal) skips the same count under
// the same condition, which is what keeps the total equal to the feed.
export function collectiveVotesAdmitted(filters: ValueListFilters): boolean {
  if (filters.min != null) return false
  const tokenIds = assetIdsForToken(filters.token)
  return tokenIds == null || tokenIds.includes(0)
}

// The whole collective-vote history of a window, newest first, cached and shared
// by every page of the vote feed. Enumerated rather than paged on purpose: the
// merged pager below translates ranks against it, which needs the complete set,
// and the source holds a few thousand events all-time so reading it whole costs
// less than the two extra queries a paged translation would take.
const COLLECTIVE_VOTE_WINDOW_CAP = 100_000
async function collectiveVoteWindow(from?: string, to?: string): Promise<VoteRow[]> {
  const tw = timeWindow(from, to)
  const rows = await cached(`explorer:collective-votes:${await liveHeadTag(Boolean(tw), datedWindowIsClosed(to))}:${from ?? ''}:${to ?? ''}`,
    tw ? 30_000 : LIVE_CACHE_MS,
    () => getCollectiveVotes(undefined, COLLECTIVE_VOTE_WINDOW_CAP, from, to))
  // A truncated enumeration would silently mis-rank the merged page, so it is
  // refused instead. The cap is ~30x the events the pallets have ever emitted.
  if (rows.length >= COLLECTIVE_VOTE_WINDOW_CAP) throw activityQueryTooBroad()
  return rows
}

const voteNewestFirst = (a: VoteRow, b: VoteRow) => b.blockHeight - a.blockHeight || b.eventIndex - a.eventIndex

// Where the indexed source's read has to start, and how deep, for the merged page
// at `offset` to be exact: `collectiveCount` rows can sit above the page, so the
// window starts that many ranks early and carries them on top of the page size.
export function voteFeedGovWindow(limit: number, offset: number, collectiveCount: number): { start: number; limit: number } {
  const lead = Math.min(offset, collectiveCount)
  return { start: offset - lead, limit: limit + lead }
}

// The merge's rank translation, split out from the reads so its exactness is
// testable without a ClickHouse-shaped fake. `gov` is the indexed source's page
// starting at rank `govStart` of ITS OWN newest-first ordering; `collective` is
// the COMPLETE collective set for the same window, also newest first.
//
// With `govStart === 0` the merged ordering is complete from rank 0 and the page
// is a plain slice. Above it, the first indexed row anchors the translation: every
// collective row newer than it is known, so its merged rank is exact and the page
// is the slice at that distance.
export function mergeVoteFeedPage(
  gov: readonly VoteRow[], collective: readonly VoteRow[],
  limit: number, offset: number, govStart: number,
): VoteRow[] {
  if (govStart === 0) return [...gov, ...collective].sort(voteNewestFirst).slice(offset, offset + limit)
  // The indexed source ran out above this page, so with at most `offset - govStart`
  // collective rows left the merged feed cannot reach the page at all.
  const first = gov[0]
  if (!first) return []
  const above = collective.filter(row => voteNewestFirst(row, first) < 0).length
  const rank = govStart + above
  return [...gov, ...collective.slice(above)].sort(voteNewestFirst).slice(offset - rank, offset - rank + limit)
}

// One page of the chain-wide vote feed: the indexed conviction/Democracy source
// merged with the collective (Council / Technical Committee) votes.
//
// The two sources have very different shapes. vote_activity is large and pages in
// SQL — the tab is thousands of pages deep and a page at the end of it is still a
// ~50 ms read — while the collective source is a few thousand rows all-time.
// Pulling BOTH to `offset + limit` in memory would have cost the deep pages that
// read, so the small source is enumerated whole and used to translate ranks: a
// vote_activity window starting `n` rows early holds every row the merged page
// can contain, and the merged rank of its first row is exact because every
// collective row newer than that row is known.
async function getVoteFeedRows(
  limit: number, from: string | undefined, to: string | undefined, offset: number,
  valueFilters: ValueListFilters, withCollective: boolean,
): Promise<VoteRow[]> {
  const govPage = (pageLimit: number, pageOffset: number) =>
    getRecentVotes(pageLimit, from, to, pageOffset, {}, undefined, valueFilters)
  if (!withCollective) return govPage(limit, offset)
  // The identity filter is judged on the voter, so it belongs to the RANKING —
  // applied to the merged page afterwards it would return a short page, exactly
  // as it would for the indexed source (which applies it inside its own walk).
  const wantsNamed = valueFilters.identity ? valueFilters.identity === 'named' : null
  const collective = (await collectiveVoteWindow(from, to))
    .filter(row => wantsNamed == null || accountIsNamed(row.account, valueFilters.viewerTagged) === wantsNamed)
  if (!collective.length) return govPage(limit, offset)
  const window = voteFeedGovWindow(limit, offset, collective.length)
  const gov = await govPage(window.limit, window.start)
  return mergeVoteFeedPage(gov, collective, limit, offset, window.start)
}

// The collective side of the vote category's exact total, over exactly the
// predicate the feed read it under. DISTINCT (block, event) because raw_events is
// replayable and the feed dedupes the same way.
async function countCollectiveVotes(from?: string, to?: string): Promise<number> {
  const bound = timeWindow(from, to) ?? '1'
  const res = await client.query({
    query: `SELECT toString(uniqExact((block_height, event_index))) AS c FROM price_data.raw_events
            WHERE ${bound}
              AND event_name IN (${sqlEventNameList(COLLECTIVE_VOTE_EVENTS)})`,
    format: 'JSONEachRow',
  })
  return Number((await res.json<{ c: string }>())[0]?.c ?? 0)
}

// Account/tag Votes tab: OpenGov + Democracy rows come from the indexed
// vote_activity path (getRecentVotes recovers referendum/conviction from the
// joined vote call), collective rows from raw_events. Each source is fetched to
// offset+limit depth, merged newest-first, and paged after the merge.
async function getScopedVotes(accounts: string[], cacheScope: string, limit: number, offset: number, from?: string, to?: string, filters: VoteListFilters = {}): Promise<VoteRow[]> {
  const window = timeWindow(from, to)
  return cached(`explorer:${cacheScope}:votes:${limit}:${offset}:${from ?? ''}:${to ?? ''}:${filterKey(filters)}`, window ? 30_000 : 8_000, async () => {
    const want = offset + limit
    const [gov, collective] = await Promise.all([
      getRecentVotes(want, from, to, 0, filters, accounts),
      getCollectiveVotes(accounts, want, from, to),
    ])
    return [...gov, ...collective.filter(row => voteRowMatchesFilters(row, filters))]
      .sort((a, b) => b.blockHeight - a.blockHeight || b.eventIndex - a.eventIndex)
      .slice(offset, offset + limit)
  })
}

// One referendum's combined vote across a tag's members: each member's LATEST
// vote (a re-vote replaces the earlier row, exactly what the referendum page
// counts), summed as integers. `conviction` is not carried — the client derives
// the capital-weighted average from weighted/amount at presentation time, the
// same way the bubble chart does for a folded tag bubble.
export interface VoteGroupRow {
  pallet: string
  referendum: string | null
  voteRefPallet?: 'opengov' | 'democracy' | null
  voteRefTitle?: string | null
  // The side cast when every member agrees; 'Split' when they diverge.
  side: string
  voters: number
  weighted: string | null
  amount: string | null
  blockHeight: number
  timestamp: string
  eventIndex: number
  extrinsicIndex: number | null
  asset: AssetRef
  valueUsd: number | null
}
export interface VotesByReferendumPage { rows: VoteGroupRow[]; total: number; complete: boolean }

// The deepest member-vote history one aggregation reads. Far above any real
// tag's vote count (the busiest system tag is a few hundred events); if a tag
// ever exceeds it, `complete: false` says so explicitly instead of the page
// silently pretending the tail doesn't exist.
const VOTE_AGGREGATE_SCAN = 10_000

// The tag/list-tag Votes tab's grouped mode: the same merged rows getScopedVotes
// pages flat, folded to one row per referendum. Aggregates over the FULL history
// before paginating — grouping a single page would split a referendum's members
// across page boundaries.
async function getScopedVotesByReferendum(accounts: string[], cacheScope: string, limit: number, offset: number): Promise<VotesByReferendumPage> {
  return cached(`explorer:${cacheScope}:votes-by-ref:${limit}:${offset}`, 8_000, async () => {
    const [gov, collective] = await Promise.all([
      getRecentVotes(VOTE_AGGREGATE_SCAN, undefined, undefined, 0, {}, accounts),
      getCollectiveVotes(accounts, VOTE_AGGREGATE_SCAN),
    ])
    const complete = gov.length < VOTE_AGGREGATE_SCAN && collective.length < VOTE_AGGREGATE_SCAN
    return aggregateVotesByReferendum([...gov, ...collective], limit, offset, complete)
  })
}

// The pure half of the grouped Votes view, split out so its invariants (latest
// vote wins, integer sums, side agreement, unattributable isolation) are
// directly testable without a ClickHouse-shaped fake.
export function aggregateVotesByReferendum(voteRows: VoteRow[], limit: number, offset: number, complete: boolean): VotesByReferendumPage {
  const all = [...voteRows].sort((a, b) => b.blockHeight - a.blockHeight || b.eventIndex - a.eventIndex)
  interface Group {
      row: VoteGroupRow
      weighted: bigint | null
      amount: bigint | null
      sides: Set<string>
      valueUsd: number | null
    }
    const seen = new Set<string>()   // (referendum, member) pairs already counted — first hit is the latest vote
    const groups = new Map<string, Group>()
    for (const row of all) {
      // Collective votes name a proposal hash instead of an index; either way the
      // referendum identity is (pallet-space, referendum). An unattributable vote
      // still counts, keyed by its own event so it can never collapse with another.
      const groupKey = `${row.voteRefPallet ?? row.pallet}:${row.referendum ?? `${row.blockHeight}:${row.eventIndex}`}`
      const memberKey = `${groupKey}:${row.account ? row.account.accountId : `${row.blockHeight}:${row.eventIndex}`}`
      if (seen.has(memberKey)) continue
      seen.add(memberKey)
      let group = groups.get(groupKey)
      if (!group) {
        // Rows arrive newest-first, so the first row IS the group's latest moment.
        group = {
          row: {
            pallet: row.pallet, referendum: row.referendum,
            voteRefPallet: row.voteRefPallet ?? null, voteRefTitle: row.voteRefTitle ?? null,
            side: row.side, voters: 0, weighted: null, amount: null,
            blockHeight: row.blockHeight, timestamp: row.timestamp,
            eventIndex: row.eventIndex, extrinsicIndex: row.extrinsicIndex,
            asset: row.asset, valueUsd: null,
          },
          weighted: null, amount: null, sides: new Set(), valueUsd: null,
        }
        groups.set(groupKey, group)
      }
      group.row.voters++
      group.sides.add(row.side)
      if (row.weighted != null) group.weighted = (group.weighted ?? 0n) + BigInt(row.weighted)
      if (row.amount != null) group.amount = (group.amount ?? 0n) + BigInt(row.amount)
      if (row.valueUsd != null) group.valueUsd = (group.valueUsd ?? 0) + row.valueUsd
    }
    const rows = [...groups.values()].slice(offset, offset + limit).map(group => ({
      ...group.row,
      side: group.sides.size === 1 ? group.row.side : 'Split',
      weighted: group.weighted?.toString() ?? null,
      amount: group.amount?.toString() ?? null,
      valueUsd: group.valueUsd,
    }))
    return { rows, total: groups.size, complete }
}

// How many rows the Votes list holds — its tab badge and its pager's total.
// Counts each source the list merges, over exactly the source's own predicate:
// conviction/democracy rows out of vote_activity restricted to the account's
// activity-index references (the pair of conditions the feed reads them under),
// plus the rare collective votes from raw_events. Both sides count DISTINCT
// (block, event) because both tables are replayable and the list dedupes.
async function countScopedVotes(accounts: string[], cacheKey: string, from?: string, to?: string): Promise<number> {
  const list = sqlAccountList(accounts)
  if (list === "''") return 0
  const bound = timeWindow(from, to) ?? '1'
  return cached(`explorer:votes-count:${cacheKey}:${from ?? ''}:${to ?? ''}`, 600_000, async () => {
    const [govRes, collectiveRes] = await Promise.all([
      client.query({
        query: `SELECT uniqExact((block_height, event_index)) AS c FROM price_data.vote_activity FINAL
                WHERE ${bound}
                  AND event_name IN ('ConvictionVoting.Voted','Democracy.Voted')
                  AND (block_height, event_index) IN (
                    SELECT block_height, event_index FROM price_data.account_activity_v3
                    WHERE account IN (${list}) AND event_name IN ('ConvictionVoting.Voted','Democracy.Voted'))
                  AND (JSONExtractString(args_json,'who') IN (${list}) OR JSONExtractString(args_json,'voter') IN (${list}))`,
        format: 'JSONEachRow',
      }),
      client.query({
        query: `SELECT uniqExact((block_height, event_index)) AS c FROM price_data.raw_events
                WHERE ${bound}
                  AND event_name IN (${sqlEventNameList(COLLECTIVE_VOTE_EVENTS)})
                  AND JSONExtractString(args_json,'account') IN (${list})`,
        format: 'JSONEachRow',
      }),
    ])
    const n = (v: unknown) => Number(v ?? 0)
    return n((await govRes.json<{ c: string }>())[0]?.c) + n((await collectiveRes.json<{ c: string }>())[0]?.c)
  })
}

const isModuleAcct = (a: AccountRef | null | undefined): boolean => !!a && a.accountId.startsWith('0x6d6f646c')
function activityExtrinsicSet(rows: ActivityRow[]): Set<string> {
  return new Set(rows.filter(r => r.extrinsicIndex != null).map(r => `${r.blockHeight}:${r.extrinsicIndex}`))
}

// Keep the semantic (highest-level) activity and hide its transfer plumbing.
// Signed activity is owned by its extrinsic. Hook/finalization activity has no
// extrinsic, so require both the block and an involved account to match; this
// avoids swallowing an unrelated transfer merely because it shares a block.
//
// This deliberately works on ActivityRow rather than event names so every feed
// (global/account/tag/asset/block/detail) applies exactly the same rule after
// its source-specific rows have been constructed.
// Whether a hook-context semantic row — one with no extrinsic to be owned by —
// also owns the transfers that share its block and one of its accounts.
//
// An OTC placement or pull does not: what it moves is a RESERVE, and a reserve
// never reaches the transfer feed, so claiming the block can only swallow a
// transfer that happens to sit beside it. (A fill DOES settle in transfers, but
// a fill always carries an extrinsic and is owned by that instead.) These rows
// carried no account at all until the maker resolved, which is what used to
// keep the treasury's funding leg visible next to a governance-dispatched
// placement in the same block.
//
// Exported because planExactActivity mirrors this same split when it counts a
// transfer feed: two copies of the rule is how a total and its page drift apart.
export function hookActivityOwnsBlockTransfers(_row: ActivityRow): boolean {
  return true
}

export function suppressSubordinateActivityRows<T extends ActivityRow>(rows: T[]): T[] {
  const semanticByExtrinsic = new Set<string>()
  const semanticHookAccounts = new Map<number, Set<string>>()
  // Extrinsics whose message left through the xcm executor. A swap in one of those bought the
  // send its delivery fee — the SDK builds every fee-bearing bridge as
  // `Utility.batch_all([Router.buy, PolkadotXcm.execute])` — so it folds behind the send the
  // same way a transfer leg does. Gated on the row's own `xcmExecuted` claim, never on "an xcm
  // row shares this extrinsic": a deliberate batch of a swap and an XTokens send is two
  // actions the user chose, and both keep their rows.
  const executedSendExtrinsics = new Set<string>()
  for (const row of rows) {
    if (row.xcmExecuted && row.extrinsicIndex != null) executedSendExtrinsics.add(`${row.blockHeight}:${row.extrinsicIndex}`)
    if (row.type === 'transfer') continue
    if (row.extrinsicIndex != null) {
      semanticByExtrinsic.add(`${row.blockHeight}:${row.extrinsicIndex}`)
      continue
    }
    if (!hookActivityOwnsBlockTransfers(row)) continue
    const accounts = [row.who?.accountId, row.to?.accountId].filter((a): a is string => !!a).map(a => a.toLowerCase())
    if (!accounts.length) continue
    const blockAccounts = semanticHookAccounts.get(row.blockHeight) ?? new Set<string>()
    for (const account of accounts) blockAccounts.add(account)
    semanticHookAccounts.set(row.blockHeight, blockAccounts)
  }
  return rows.filter(row => {
    if (row.type === 'trade' && row.extrinsicIndex != null
      && executedSendExtrinsics.has(`${row.blockHeight}:${row.extrinsicIndex}`)) return false
    if (row.type !== 'transfer') return true
    if (row.extrinsicIndex != null) return !semanticByExtrinsic.has(`${row.blockHeight}:${row.extrinsicIndex}`)
    const owners = semanticHookAccounts.get(row.blockHeight)
    if (!owners) return true
    return ![row.who?.accountId, row.to?.accountId]
      .filter((a): a is string => !!a)
      .some(account => owners.has(account.toLowerCase()))
  })
}

// A dust cleanup is emitted as Tokens.Transfer immediately followed by the tokens
// pallet's dust event. It is balance-accounting performed by the pallet, not a transfer
// initiated by the account. Match the exact sibling event (including account, asset and
// amount) rather than hiding every treasury leg.
//
// The pair is read from the dust_lost_events projection, which is the same table and the
// same pre-extracted columns accountTransferArm's exclusion uses, so the count and the
// rows cannot decide a pair differently. `who` is stored already case-folded. No FINAL:
// the rows only build a lookup set, so an unmerged replacement duplicate is harmless.
async function suppressDustTransferRows<T extends ActivityRow>(rows: T[]): Promise<T[]> {
  const transfers = rows.filter(r => r.type === 'transfer' && r.eventIndex != null && r.who && r.asset && r.amount)
  if (!transfers.length) return rows
  const tuples = [...new Set(transfers.map(r => `(${r.blockHeight},${r.eventIndex! + 1})`))]
  const dustKeys = new Set<string>()
  const dustChunks = await mapChunksConcurrently(tuples, 5_000, CHUNK_QUERY_CONCURRENCY, async chunk => {
    const res = await client.query({
      query: `SELECT block_height, event_index, who, asset_id, amount
              FROM price_data.dust_lost_events
              WHERE (block_height, event_index) IN (${chunk.join(',')})`,
      format: 'JSONEachRow',
    })
    return res.json<{ block_height: number; event_index: number; who: string; asset_id: number; amount: string }>()
  })
  for (const rows of dustChunks) {
    for (const d of rows) {
      dustKeys.add(`${d.block_height}:${d.event_index - 1}:${d.who}:${d.asset_id}:${d.amount}`)
    }
  }
  return rows.filter(r => r.type !== 'transfer' || r.eventIndex == null || !r.who || !r.asset || !r.amount
    || !dustKeys.has(`${r.blockHeight}:${r.eventIndex}:${r.who.accountId.toLowerCase()}:${r.asset.assetId}:${r.amount}`))
}

async function suppressActivityPlumbing<T extends ActivityRow>(rows: T[]): Promise<T[]> {
  return suppressDustTransferRows(suppressSubordinateActivityRows(rows))
}

// Transfer-only pages still need the same semantic ownership decision as the
// merged feed, but they must not enumerate every unrelated activity source far
// enough back to cover a sparse value filter. Resolve ownership only for the
// bounded transfer candidates. Signed rows are matched by exact
// (block,extrinsic); hook rows use the same block+account rule as
// suppressSubordinateActivityRows.
async function suppressTransferCandidates(transfers: TransferRow[]): Promise<TransferRow[]> {
  if (!transfers.length) return []
  const signedKeys = [...new Set(transfers
    .filter(row => row.extrinsicIndex != null)
    .map(row => `${row.blockHeight}:${row.extrinsicIndex}`))]
  const hookBlocks = [...new Set(transfers
    .filter(row => row.extrinsicIndex == null)
    .map(row => row.blockHeight))]
  const semanticExtrinsics = new Set<string>()
  const hookAccounts = new Map<number, Set<string>>()
  const addHookAccount = (blockHeight: number, account: string | null | undefined) => {
    if (!account || !ACCOUNT_RE.test(account)) return
    const accounts = hookAccounts.get(blockHeight) ?? new Set<string>()
    accounts.add(account.toLowerCase())
    hookAccounts.set(blockHeight, accounts)
  }

  type SemanticEvent = {
    block_height: number
    extrinsic_index: number | null
    event_name: string
    args_json: string
  }
  const semanticNames = [...new Set([
    ...SWAP_EVENTS,
    ...LIQUIDITY_EVENTS,
    ...VOTE_EVENTS,
  ])]
  const semanticEvents: SemanticEvent[] = []
  const signedSemanticChunks = await mapChunksConcurrently(signedKeys, 5_000, CHUNK_QUERY_CONCURRENCY, async chunk => {
    const tuples = chunk.map(key => { const [height, index] = key.split(':'); return `(${height},${index})` })
    const result = await client.query({
      query: `SELECT block_height, extrinsic_index, event_name, args_json
              FROM price_data.raw_events
              WHERE (block_height, extrinsic_index) IN (${tuples.join(',')})
                AND event_name IN (${sqlEventNameList(semanticNames)})
                AND NOT (event_name IN (${sqlEventNameList(SWAP_EVENTS)})
                  AND JSONExtractString(args_json,'who') = '${ROUTER_PALLET_ACCT}')
                AND NOT (event_name IN (${sqlEventNameList(LIQUIDITY_EVENTS)})
                  AND JSONExtractString(args_json,'who') LIKE '0x6d6f646c%')`,
      format: 'JSONEachRow',
    })
    return result.json<SemanticEvent>()
  })
  for (const rows of signedSemanticChunks) semanticEvents.push(...rows)
  const hookSemanticChunks = await mapChunksConcurrently(hookBlocks, 5_000, CHUNK_QUERY_CONCURRENCY, async chunk => {
    const blocks = chunk.join(',')
    const result = await client.query({
      query: `SELECT block_height, extrinsic_index, event_name, args_json
              FROM price_data.raw_events
              WHERE block_height IN (${blocks}) AND extrinsic_index IS NULL
                AND event_name IN (${sqlEventNameList(semanticNames)})
                AND NOT (event_name IN (${sqlEventNameList(SWAP_EVENTS)})
                  AND (JSONExtractString(args_json,'who') = '${ROUTER_PALLET_ACCT}'
                    OR (JSONExtractString(args_json,'who') != ''
                      AND JSONExtractString(args_json,'who') NOT LIKE '0x6d6f646c%')))
                AND NOT (event_name IN (${sqlEventNameList(LIQUIDITY_EVENTS)})
                  AND JSONExtractString(args_json,'who') LIKE '0x6d6f646c%')`,
      format: 'JSONEachRow',
    })
    return result.json<SemanticEvent>()
  })
  for (const rows of hookSemanticChunks) semanticEvents.push(...rows)
  for (const event of semanticEvents) {
    const args = (safeJson(event.args_json) ?? {}) as Record<string, unknown>
    if (event.extrinsic_index != null) {
      semanticExtrinsics.add(`${event.block_height}:${event.extrinsic_index}`)
      continue
    }
    addHookAccount(event.block_height, argStr(args, 'who') || argStr(args, 'voter'))
  }

  // XCM ownership is based on successfully decoded economic rows, not merely
  // the presence of a similarly named event. Decode the bounded candidate
  // blocks in chunks using the shared global/block builders.
  if (hookBlocks.length) {
    const prices = await ensurePrices()
    const decoded = await mapChunksConcurrently(hookBlocks, 1_000, CHUNK_QUERY_CONCURRENCY, async blocks => {
      const [incoming, outgoing] = await Promise.all([
        xcmInRowsForBlocks(blocks, prices),
        xcmOutRemoteRowsForBlocks(blocks, prices),
      ])
      return [...incoming, ...outgoing]
    })
    for (const chunk of decoded) {
      for (const row of chunk) addHookAccount(row.blockHeight, row.who?.accountId)
    }
  }
  const xcmChunks = await mapChunksConcurrently(signedKeys, 5_000, CHUNK_QUERY_CONCURRENCY, async chunk => {
    const tuples = chunk.map(key => { const [height, index] = key.split(':'); return `(${height},${index})` })
    const result = await client.query({
      query: `SELECT DISTINCT block_height, extrinsic_index
              FROM price_data.raw_xcm_activity
              WHERE (block_height, extrinsic_index) IN (${tuples.join(',')})
                AND source_kind='event'
                AND name IN (${XCM_SENT_EVENTS_SQL})`,
      format: 'JSONEachRow',
    })
    return result.json<{ block_height: number; extrinsic_index: number | null }>()
  })
  for (const rows of xcmChunks) {
    for (const row of rows) {
      if (row.extrinsic_index != null) semanticExtrinsics.add(`${row.block_height}:${row.extrinsic_index}`)
    }
  }

  return transfers.filter(row => {
    if (row.extrinsicIndex != null) return !semanticExtrinsics.has(`${row.blockHeight}:${row.extrinsicIndex}`)
    const owners = hookAccounts.get(row.blockHeight)
    return !owners || (!owners.has(row.from.accountId.toLowerCase()) && !owners.has(row.to.accountId.toLowerCase()))
  })
}

// single-assignment activity classification
// Every on-chain activity lands in exactly ONE activity category. Precedence:
// trades own their extrinsics' transfer legs (dropped from Transfers); liquidity
// owns share-asset trade legs (routing into/out of a pool share inside an
// add/remove is mechanics, not a trade); module-account rows are protocol
// internals, not user activity.
// A pool's LP share token. Basilisk registers these unnamed, so there is no symbol
// to match on: membership comes from the XYK pool registry (see isXykShareToken).
const isShareAssetId = (id: number) => isXykShareToken(id)
function dropShareRoutedTrades<T extends { blockHeight: number; extrinsicIndex: number | null; assetIn: AssetRef | null; assetOut: AssetRef | null }>(trades: T[], liquidityExtrinsics: Set<string>): T[] {
  return trades.filter(t => !(t.extrinsicIndex != null && liquidityExtrinsics.has(`${t.blockHeight}:${t.extrinsicIndex}`)
    && ((t.assetIn && isShareAssetId(t.assetIn.assetId)) || (t.assetOut && isShareAssetId(t.assetOut.assetId)))))
}
async function liquidityExtrinsicsForShareTrades(trades: TradeRow[]): Promise<Set<string>> {
  const tuples = [...new Set(trades
    .filter(t => t.extrinsicIndex != null && ((t.assetIn && isShareAssetId(t.assetIn.assetId)) || (t.assetOut && isShareAssetId(t.assetOut.assetId))))
    .map(t => `(${t.blockHeight},${t.extrinsicIndex})`))]
  if (!tuples.length) return new Set()
  const out = new Set<string>()
  const chunks = await mapChunksConcurrently(tuples, 5_000, CHUNK_QUERY_CONCURRENCY, async chunk => {
    const res = await client.query({
      query: `SELECT DISTINCT block_height, extrinsic_index
              FROM price_data.raw_events
              WHERE (block_height, extrinsic_index) IN (${chunk.join(',')})
                AND event_name IN (${sqlEventNameList(LIQUIDITY_EVENTS)})`,
      format: 'JSONEachRow',
    })
    return res.json<{ block_height: number; extrinsic_index: number }>()
  })
  for (const rows of chunks) {
    for (const row of rows) out.add(`${row.block_height}:${row.extrinsic_index}`)
  }
  return out
}
function normalizeActivityTypeKey(type: string): string { return type }
export function activityTypeMatchesFamily(rowType: ActivityRow['type'], type: string): boolean {
  return rowType === type
}
// Per-category action filter (the sub-type select next to the chips).
export function activityRowMatchesAction(r: ActivityRow, action?: string): boolean {
  if (!action) return true
  switch (r.type) {
    case 'trade': return action === 'swap'
    case 'liquidity': return r.liqAction === action
    case 'vote': return (r.voteSide ?? '') === action
    case 'xcm': return (r.xcmDir ?? 'out') === action
    default: return true
  }
}
// A candidate window ClickHouse refuses to READ means the same thing to the reader
// as one too broad to assemble: this depth needs a narrower filter or date range.
// Its own guards — result rows, query text size, execution time — otherwise arrive
// as an opaque 500 and the page shows "Internal Server Error" instead of what to
// do about it. The multi-source categories still have secondary lookups whose size
// follows the candidate window rather than the page, so a deep page under a sparse
// filter can reach one of these guards.
const CLICKHOUSE_QUERY_GUARD_CODES = new Set(['396', '62', '159'])
function activityReadFailure(error: unknown): Error {
  const code = (error as { code?: unknown })?.code
  return typeof code === 'string' && CLICKHOUSE_QUERY_GUARD_CODES.has(code) ? activityQueryTooBroad() : error as Error
}

// Unified Activity feed. `type` selects a single category server-side (so the UI
// chips paginate correctly through that category) or 'all' for the merged feed.
// Attaching revenue costs a read of its own (the unbooked tail is recomputed per
// event), so it is opt-in: the explorer surfaces want it on every page, while the
// notification evaluator reads this same feed every few seconds and must not pay for
// it unless a rule actually looks at revenue. Default on — every existing caller is
// a display path.
//
// `forwardOnly` names the OTHER kind of caller: a reader whose cursor only moves
// forward and can never come back for a row it did not see. The shared classified
// window is stale-while-revalidate on a key with no head in it, so a dated or
// sparse page can be a minute old — invisible to a UI reader, a permanent loss to
// this one. It puts the read on the head-keyed window instead: one build per block
// rather than one per minute, for a page that is complete when it is read.
export interface ActivityPageOptions { revenue?: boolean; forwardOnly?: boolean }

export async function getRecentActivity(limit: number, from?: string, to?: string, offset = 0, type = 'all', filters: ValueListFilters = {}, action?: string, opts: ActivityPageOptions = {}): Promise<ActivityRow[]> {
  try {
    return await recentActivityPage(limit, from, to, offset, type, filters, action, opts)
  } catch (error) {
    throw activityReadFailure(error)
  }
}

async function recentActivityPage(limit: number, from?: string, to?: string, offset = 0, type = 'all', filters: ValueListFilters = {}, action?: string, opts: ActivityPageOptions = {}): Promise<ActivityRow[]> {
  const tw = timeWindow(from, to)
  type = normalizeActivityTypeKey(type)
  // The forward-only flag is part of the key, not just of the build: the page a UI
  // reader cached for this same head was sliced from the shared stale window, and
  // serving it to the evaluator would hand back exactly the rows the flag exists to
  // avoid.
  return cached(`explorer:activity:${await liveHeadTag(Boolean(tw), datedWindowIsClosed(to))}:${type}:${limit}:${offset}:${from ?? ''}:${to ?? ''}:${filterKey(filters)}:${action ?? ''}${opts.forwardOnly ? ':fwd' : ''}`, tw ? 30000 : LIVE_CACHE_MS, async () => {
    const { rows, locallyPaged } = await activityWindow(limit, from, to, offset, type, filters, action, opts.forwardOnly)
    // A locally paged window holds the whole filtered ordering, so this page
    // starts at `offset`; a SQL-paged read already returned the page itself.
    // Copy the rows the page publishes: the window is shared with every other
    // page of the same feed, and the enrichment below writes to its rows.
    const sliceOffset = locallyPaged ? offset : 0
    const page = rows.slice(sliceOffset, sliceOffset + limit).map(row => ({ ...row }))
    await applyHistoricalUsd(page, activityHistPick)
    return page
  })
}

interface ActivityWindow { rows: ActivityRow[]; locallyPaged: boolean }

// The window a page is a slice of: shared by every page whose depth falls in the
// same bucket, so paging a filtered feed assembles it once instead of per click.
//
// The live head of a cheap feed keeps the feed's own TTL, because that is the row
// set a reader watches for their own transaction — including the Activity page's
// default $10 smol floor, which is a filter but not an expensive one. Everything
// else (a bounded date range, a page past the head, a sparse value floor that
// sends every source to its exact event-time predicate) is not live data: keep it
// fresh for a minute and serve it stale while it revalidates, so a reader paging
// deep is never blocked on a rebuild.
async function activityWindow(
  limit: number, from: string | undefined, to: string | undefined, offset: number,
  type: string, filters: ValueListFilters, action?: string, forwardOnly = false,
): Promise<ActivityWindow> {
  const plan = activityWindowPlan(limit, offset, type, from, to, filters, action, forwardOnly)
  // A page cut by SQL OFFSET is its own window — the offset is part of the read —
  // so it stays on the per-page cache above.
  if (!plan) return buildActivityWindow(limit, from, to, offset, type, filters, action)
  const load = async (key: string, depth: number): Promise<ActivityWindow> => {
    const build = async (): Promise<ActivityWindow> => {
      const window = await buildActivityWindow(depth, from, to, 0, type, filters, action)
      // Hold exactly the depth this key promises. No page keyed on it reads
      // further, and the rows past it are the ones no source proved complete.
      return { ...window, rows: window.rows.slice(0, depth) }
    }
    return plan.live
      ? cached(`${key}:${await liveHeadTag()}`, LIVE_CACHE_MS, build)
      : cachedSwr(key, ACTIVITY_WINDOW_FRESH_MS, ACTIVITY_WINDOW_STALE_MS, build)
  }
  const want = offset + limit
  try {
    return await load(plan.key, plan.depth)
  } catch (error) {
    // The bucket's deepest page needs more candidates than a request may read. A
    // shallower page in the same bucket can still be served, so fall back to the
    // depth this page itself asked for rather than refusing it.
    if ((error as { code?: unknown })?.code !== 'ACTIVITY_QUERY_TOO_BROAD' || plan.depth === want) throw error
    return await load(`${plan.key}:exact:${want}`, want)
  }
}

// A filtered or deep Activity page is a slice of a window that costs seconds to
// tens of seconds to assemble, and it is the same window at every offset of the
// feed. One minute of freshness with stale-while-revalidate keeps a pager on one
// window instead of paying the whole assembly per click, and keeps consecutive
// pages inside a bucket slices of the SAME ordering rather than of two reads
// taken seconds apart.
const ACTIVITY_WINDOW_FRESH_MS = 60_000
const ACTIVITY_WINDOW_STALE_MS = 5 * 60_000

export interface ActivityWindowPlan { key: string; depth: number; live: boolean }

// The shared window a request pages from, or null when the request's read already
// IS its page. The key names the window — feed shape and proven depth — and
// deliberately carries no offset and no page size: those choose the slice, not the
// window, and putting them in the key is what made an expensive result reusable
// only by an identical request.
//
// The window holding offset 0 of a live feed is the one whose freshness a reader
// can see, so it stays on the feed TTL while every deeper bucket takes the window
// TTL below.
export function activityWindowPlan(
  limit: number, offset: number, type: string, from: string | undefined, to: string | undefined,
  filters: ValueListFilters, action?: string, forwardOnly = false,
): ActivityWindowPlan | null {
  const category = normalizeActivityTypeKey(type)
  if (!activityPagesInMemory(category, action)) return null
  const depth = activityWindowDepth(offset + limit)
  return {
    key: `explorer:activity-window:${category}:${from ?? ''}:${to ?? ''}:${filterKey(filters)}:${action ?? ''}:${depth}`,
    depth,
    // A window may drop the head only when it can no longer GAIN rows. A dated
    // window still reaching today keeps growing, so it stays head-keyed however
    // long its TTL is — reading "has a date filter" as "is historical" froze it
    // for the whole freshness period instead.
    //
    // The exact-value condition is a COST rule rather than a correctness one: a
    // sparse floor widens every source, and a reader who can re-read the page
    // loses nothing by seeing it a minute old. A forward-only reader can lose
    // everything — see `forwardOnly` on ActivityPageOptions — so it overrides
    // that rule and pays one build per block for a page complete when read.
    //
    // The depth rule is neither and stands unconditionally: a deeper bucket is a
    // different window, and only the page that owns offset 0 may claim this one.
    live: depth === activityWindowDepth(limit)
      && !(timeWindow(from, to) && datedWindowIsClosed(to))
      && (forwardOnly || !activityExactValueFiltered(category, filters)),
  }
}

// Which categories build a page by slicing rows held in memory. Classification, an
// action filter and a multi-source merge are all decided on built rows, so those
// pages are slices of one ordering the request assembles; the rest carry their
// offset into SQL, where the read is the page. This is the predicate the builder
// pages by, so a window may only be shared across offsets where it holds.
export function activityPagesInMemory(type: string, action?: string): boolean {
  const category = normalizeActivityTypeKey(type)
  if (category === 'all' || category === 'trade' || category === 'transfer') return true
  if (action) return true
  return category === 'liquidity' || category === 'xcm'
}

// Whether a value floor is sparse enough that the classified builder skips the
// cheap unfiltered probe and goes straight to bounded exact source reads. That is
// also the line between a window one small recent read fills (0.2 s unfiltered,
// 0.2 s at min=10) and one that widens every source until it can prove a cutoff
// (3.4 s at min=1000, ~30 s at min=95000), so it decides whether the window can
// keep tracking the chain.
export function activityExactValueFiltered(type: string, filters: ValueListFilters): boolean {
  return filters.min != null
    && filters.unit !== 'token'
    && !(normalizeActivityTypeKey(type) === 'trade' && !!filters.token)
    && filters.min >= 1_000
}

async function buildActivityWindow(limit: number, from: string | undefined, to: string | undefined, offset: number, type: string, filters: ValueListFilters, action?: string): Promise<ActivityWindow> {
  const want = offset + limit
  const classified = type === 'all' || type === 'trade' || type === 'transfer'
  // Categories assembled from multiple sources page only after merging, so
  // every source must cover the requested offset as well as the page size.
  const locallyMerged = classified || !!action || type === 'xcm' || type === 'liquidity'
  let fetchN = locallyMerged
    ? Math.max(want * 5, limit + 50)
    : Math.max(limit * 5, limit + 50)
  const toTransferRow = (t: TransferRow): ActivityRow => ({
    type: 'transfer', blockHeight: t.blockHeight, timestamp: t.timestamp, eventIndex: t.eventIndex, extrinsicIndex: t.extrinsicIndex,
    who: t.from, to: t.to, asset: t.asset, assetIn: null, assetOut: null, amount: t.amount, amountIn: null, amountOut: null, valueUsd: t.valueUsd,
  })
  const toTradeRow = (t: TradeRow): ActivityRow => ({
    type: 'trade', blockHeight: t.blockHeight, timestamp: t.timestamp, eventIndex: t.eventIndex, extrinsicIndex: t.extrinsicIndex,
    who: t.who, to: null, asset: null, assetIn: t.assetIn, assetOut: t.assetOut, amount: null, amountIn: t.amountIn, amountOut: t.amountOut, valueUsd: t.valueUsd,
    linkBlock: t.linkBlock, linkIndex: t.linkIndex,
  })
  // Whether the collective (Council / Technical Committee) votes join this
  // window's vote source. Decided on the caller's OWN filters, not on the
  // possibly value-stripped source filters, because a row the real predicate
  // rejects must not be read at all (see collectiveVotesAdmitted).
  const withCollective = collectiveVotesAdmitted(filters)

  let rows: ActivityRow[]
  // Where this window's page starts. Decided by the same predicate the window
  // cache keys on, so a shared window can never be sliced at an offset the
  // branch below already applied in SQL.
  const locallyPaged = activityPagesInMemory(type, action)
  let sourceSaturated = false
  let plumbingApplied = false
  if (type === 'transfer') {
    // Pull only transfer candidates, then resolve semantic ownership by their
    // exact identities. Widening the swap/liquidity/XCM/etc. feeds alongside
    // a sparse transfer filter made a 25-row page enumerate >100k unrelated
    // rows and could never complete under the ClickHouse result guard.
    const deferredValueFilter = filters.min != null && filters.unit !== 'token'
    const sourceFilters = deferredValueFilter ? { ...filters, min: undefined, unit: undefined } : filters
    for (;;) {
      const transfers = await getRecentTransfers(fetchN, from, to, 0, true, sourceFilters)
      const classifiedTransfers = await suppressTransferCandidates(transfers)
      rows = await suppressDustTransferRows(classifiedTransfers.map(toTransferRow))
      plumbingApplied = true
      sourceSaturated = transfers.length >= fetchN
      if (deferredValueFilter && filters.unit !== 'token') await applyHistoricalUsd(rows, activityHistPick)
      const visibleRows = rows
        .filter(row => activityRowMatchesFilters(row, filters) && activityRowMatchesAction(row, action))
        .sort((left, right) => right.blockHeight - left.blockHeight || (right.eventIndex ?? -1) - (left.eventIndex ?? -1))
      const cutoff = completeActivityPageCutoff(visibleRows, want)
      const oldest = transfers.reduce<{ blockHeight: number; eventIndex: number } | null>((current, row) => {
        const candidate = { blockHeight: row.blockHeight, eventIndex: row.eventIndex }
        return current == null || candidate.blockHeight < current.blockHeight ||
          (candidate.blockHeight === current.blockHeight && candidate.eventIndex < current.eventIndex)
          ? candidate : current
      }, null)
      const complete = cutoff
        ? activitySourceCoversCutoff(transfers.length, fetchN, oldest, cutoff)
        : transfers.length < fetchN
      if (complete) break
      if (fetchN >= MAX_ACTIVITY_SOURCE_ROWS) throw activityQueryTooBroad()
      fetchN = Math.min(fetchN * 4, MAX_ACTIVITY_SOURCE_ROWS)
    }
  } else if (classified) {
    // Transfers, trades and the merged feed share ONE classification pass so a
    // row never appears in a category the merged feed assigned elsewhere.
    // The Trade-only view needs liquidity context to reject share-token router
    // legs, plus DCA/OTC rows, but it cannot display transfers, rewards, MM,
    // XCM, staking or votes. Avoid that unrelated fan-out on its hot path.
    const needsFullClassification = type !== 'trade'
    // Historical-price ASOF joins make a sparse minimum-value query scan the
    // entire raw table before LIMIT can help. Fetch recent candidates without
    // the threshold, value them in batches, and widen only sources that have
    // not yet produced a complete page of qualifying rows.
    // Asset-keyed swap reads can apply the exact event-time USD predicate
    // before LIMIT more cheaply than repeatedly widening a sparse candidate
    // window. Other activity families still defer USD filtering until their
    // bounded candidates have been classified and valued below.
    const deferredValueFilter = filters.min != null
      && filters.unit !== 'token'
      && !(type === 'trade' && filters.token)
    // A four-figure USD floor is sparse enough that the cheap unfiltered
    // probe cannot normally fill a page; go straight to bounded exact source
    // reads. Lower/default floors retain the recent probe, which usually wins.
    // Shared with the window cache, which needs the same line to decide whether
    // this shape is cheap enough to keep tracking the chain.
    const directExactValueFilter = activityExactValueFiltered(type, filters)
    let sourceValueFiltered = directExactValueFilter
    let sourceFilters = sourceValueFiltered
      ? filters
      : deferredValueFilter ? { ...filters, min: undefined, unit: undefined } : filters
    type ClassifiedSourceKey = 'transfer' | 'trade' | 'dca' | 'reward' | 'liquidity' | 'mm' | 'otc' | 'xcm' | 'xcmIn' | 'xcmOutRemote' | 'xcmExecuted' | 'nttOut' | 'nttIn' | 'staking' | 'vote'
    const classifiedSourceKeys: ClassifiedSourceKey[] = [
      'transfer', 'trade', 'dca', 'reward', 'liquidity', 'mm', 'otc',
      'xcm', 'xcmIn', 'xcmOutRemote', 'xcmExecuted', 'nttOut', 'nttIn', 'staking', 'vote',
    ]
    const exactSeedSize = activitySourceSeedSize(want)
    const exactSourceLimits = Object.fromEntries(classifiedSourceKeys.map(key => [key, sourceValueFiltered ? exactSeedSize : fetchN])) as Record<ClassifiedSourceKey, number>
    const exactSourceCache = new Map<ClassifiedSourceKey, unknown[]>()
    let exactSourceFrom = from
    const loadClassifiedSource = <T>(
      key: ClassifiedSourceKey,
      load: (sourceLimit: number, sourceFrom: string | undefined) => Promise<T[]>,
    ): Promise<T[]> => {
      if (!sourceValueFiltered) return load(fetchN, from)
      const previous = exactSourceCache.get(key)
      if (previous) return Promise.resolve(previous as T[])
      return load(exactSourceLimits[key], exactSourceFrom).then(sourceRows => {
        exactSourceCache.set(key, sourceRows)
        return sourceRows
      })
    }
    for (;;) {
      const [transfers, trades, liquidity, xcm, xcmIn, xcmOutRemote, xcmExecuted, votes] = await Promise.all([
        needsFullClassification
          ? loadClassifiedSource('transfer', (sourceLimit, sourceFrom) => getRecentTransfers(sourceLimit, sourceFrom, to, 0, true, sourceFilters))
          : Promise.resolve([] as TransferRow[]),
        loadClassifiedSource('trade', (sourceLimit, sourceFrom) => getRecentTrades(sourceLimit, sourceFrom, to, 0, sourceFilters)),
        needsFullClassification
          ? loadClassifiedSource('liquidity', (sourceLimit, sourceFrom) => getRecentLiquidity(sourceLimit, sourceFrom, to, 0, sourceFilters))
          : Promise.resolve([] as ActivityRow[]),
        needsFullClassification
          ? loadClassifiedSource('xcm', (sourceLimit, sourceFrom) => getRecentXcm(sourceLimit, sourceFrom, to, undefined, 0, sourceFilters))
          : Promise.resolve([] as ActivityRow[]),
        needsFullClassification
          ? loadClassifiedSource('xcmIn', (sourceLimit, sourceFrom) => getRecentXcmIn(sourceLimit, sourceFrom, to, undefined, 0, sourceFilters))
          : Promise.resolve([] as ActivityRow[]),
        needsFullClassification
          ? loadClassifiedSource('xcmOutRemote', (sourceLimit, sourceFrom) => getRecentXcmOutRemote(sourceLimit, sourceFrom, to, undefined, 0, sourceFilters))
          : Promise.resolve([] as ActivityRow[]),
        needsFullClassification
          ? loadClassifiedSource('xcmExecuted', (sourceLimit, sourceFrom) => getRecentXcmExecuted(sourceLimit, sourceFrom, to, undefined, 0, sourceFilters))
          : Promise.resolve([] as ActivityRow[]),
        needsFullClassification
          ? loadClassifiedSource('vote', (sourceLimit, sourceFrom) => getVoteFeedRows(sourceLimit, sourceFrom, to, 0, sourceFilters, withCollective))
          : Promise.resolve([] as VoteRow[]),
      ])
      const sourceFilteredTransfers = sourceValueFiltered
        ? await suppressTransferCandidates(transfers)
        : transfers
      const liquidityExtrinsics = needsFullClassification && !sourceValueFiltered
        ? activityExtrinsicSet(liquidity)
        : new Set([
            ...activityExtrinsicSet(liquidity),
            ...await liquidityExtrinsicsForShareTrades(trades),
          ])
      const userTrades = dropShareRoutedTrades(trades, liquidityExtrinsics)
      // Drop swap-internal transfer legs: any transfer in a trade's extrinsic, or
      // touching a pallet/pool account (hops, fees).
      const tradeExtrinsics = new Set(trades.filter(t => t.extrinsicIndex != null).map(t => `${t.blockHeight}:${t.extrinsicIndex}`))
      const userTransfers = sourceFilteredTransfers.filter(t =>
        !(t.extrinsicIndex != null && tradeExtrinsics.has(`${t.blockHeight}:${t.extrinsicIndex}`)) &&
        !isModuleAcct(t.from) && !isModuleAcct(t.to))
      type SourceCursor = { blockHeight: number; eventIndex: number }
      type SourcePage = { key: ClassifiedSourceKey; fetchSize: number; rawSize: number; rows: ActivityRow[]; oldest: SourceCursor | null; valueIrrelevant?: boolean }
      const oldestOf = <T extends { blockHeight: number; eventIndex?: number | null }>(source: T[]): SourceCursor | null => {
        let oldest: SourceCursor | null = null
        for (const row of source) {
          const candidate = { blockHeight: row.blockHeight, eventIndex: row.eventIndex ?? -1 }
          if (oldest == null || candidate.blockHeight < oldest.blockHeight ||
            (candidate.blockHeight === oldest.blockHeight && candidate.eventIndex < oldest.eventIndex)) oldest = candidate
        }
        return oldest
      }
      const sourceFetchSize = (key: ClassifiedSourceKey): number => sourceValueFiltered ? exactSourceLimits[key] : fetchN
      const allSources: SourcePage[] = [
        { key: 'transfer', fetchSize: sourceFetchSize('transfer'), rawSize: transfers.length, rows: userTransfers.map(toTransferRow), oldest: oldestOf(transfers) },
        { key: 'trade', fetchSize: sourceFetchSize('trade'), rawSize: trades.length, rows: userTrades.map(toTradeRow), oldest: oldestOf(trades) },
        { key: 'liquidity', fetchSize: sourceFetchSize('liquidity'), rawSize: liquidity.length, rows: liquidity, oldest: oldestOf(liquidity) },
        { key: 'vote', fetchSize: sourceFetchSize('vote'), rawSize: votes.length, rows: votes.map(voteActivityRow), oldest: oldestOf(votes) },
        { key: 'xcm', fetchSize: sourceFetchSize('xcm'), rawSize: xcm.length, rows: xcm, oldest: oldestOf(xcm) },
        { key: 'xcmIn', fetchSize: sourceFetchSize('xcmIn'), rawSize: xcmIn.length, rows: xcmIn, oldest: oldestOf(xcmIn) },
        { key: 'xcmOutRemote', fetchSize: sourceFetchSize('xcmOutRemote'), rawSize: xcmOutRemote.length, rows: xcmOutRemote, oldest: oldestOf(xcmOutRemote) },
        { key: 'xcmExecuted', fetchSize: sourceFetchSize('xcmExecuted'), rawSize: xcmExecuted.length, rows: xcmExecuted, oldest: oldestOf(xcmExecuted) },
      ]
      const sourcePages = type === 'trade'
        ? [allSources[1]]
        : type === 'transfer' ? [allSources[0]] : allSources
      sourceSaturated = sourcePages.some(source => source.rawSize >= source.fetchSize)
      // A transfer-only result still needs the other categories as
      // classification context. Otherwise the transfer leg of an LP action,
      // reward claim, vote, or XCM journey can reappear merely because the
      // caller selected `type=transfer`.
      const classificationPages = type === 'trade' ? sourcePages : allSources
      rows = await suppressActivityPlumbing(classificationPages.flatMap(source => source.rows))
      plumbingApplied = true
      if (type !== 'all') rows = rows.filter(r => activityTypeMatchesFamily(r.type, type))
      if (deferredValueFilter && filters.unit !== 'token') await applyHistoricalUsd(rows, activityHistPick)
      const visibleRows = rows.filter(r => activityRowMatchesFilters(r, filters) && activityRowMatchesAction(r, action))
        .sort((a, b) => b.blockHeight - a.blockHeight || (b.eventIndex ?? -1) - (a.eventIndex ?? -1))
      const cutoff = completeActivityPageCutoff(visibleRows, want)
      const coveragePages = type === 'transfer' ? allSources : sourcePages
      const incompletePages = activitySourcesNeedingMore(
        cutoff ? coveragePages : sourcePages,
        cutoff,
        deferredValueFilter,
      )
      const complete = incompletePages.length === 0
      if (complete) break
      // A low USD threshold usually completes from the first small unfiltered
      // window and avoids an ASOF join below every source LIMIT. A sparse
      // threshold is the opposite: repeatedly widening every family can cross
      // the client's 100k row guard before finding 25 qualifying rows. After
      // the first incomplete window, let each source apply its exact event-time
      // predicate and resolve transfer/share-token ownership only for those
      // bounded candidates. This retains complete-history classification while
      // avoiding an all-family raw-history walk.
      if (deferredValueFilter && !sourceValueFiltered) {
        sourceValueFiltered = true
        sourceFilters = filters
        // Start each exact source at a fraction of the merged target. The
        // common case fills the union from several activity families; sources
        // that have not crossed the resulting cutoff are deepened separately.
        fetchN = exactSeedSize
        for (const key of classifiedSourceKeys) exactSourceLimits[key] = fetchN
        exactSourceCache.clear()
        exactSourceFrom = from
        continue
      }
      if (sourceValueFiltered) {
        if (!incompletePages.length) throw activityQueryTooBroad()
        exactSourceFrom = cutoff ? activityCutoffFromDate(from, visibleRows, want) : from
        for (const source of incompletePages) {
          if (source.fetchSize >= MAX_ACTIVITY_SOURCE_ROWS) throw activityQueryTooBroad()
          exactSourceLimits[source.key] = Math.min(source.fetchSize * 4, MAX_ACTIVITY_SOURCE_ROWS)
          exactSourceCache.delete(source.key)
        }
        fetchN = Math.max(...Object.values(exactSourceLimits))
        continue
      }
      if (fetchN >= MAX_ACTIVITY_SOURCE_ROWS) throw activityQueryTooBroad()
      fetchN = Math.min(fetchN * 4, MAX_ACTIVITY_SOURCE_ROWS)
    }
  } else if (action) {
    // Sub-type filtering breaks SQL paging — fetch a window and page locally.
    if (type === 'liquidity') rows = await getRecentLiquidity(fetchN, from, to, 0, filters, action)
    else if (type === 'xcm') rows = (await Promise.all([getRecentXcm(fetchN, from, to, undefined, 0, filters), getRecentXcmIn(fetchN, from, to, undefined, 0, filters), getRecentXcmOutRemote(fetchN, from, to, undefined, 0, filters), getRecentXcmExecuted(fetchN, from, to, undefined, 0, filters)])).flat()
    else rows = (await getVoteFeedRows(fetchN, from, to, 0, filters, withCollective)).map(voteActivityRow)
  } else if (type === 'liquidity') {
    rows = await getRecentLiquidity(fetchN, from, to, 0, filters)
  } else if (type === 'xcm') {
    rows = (await Promise.all([getRecentXcm(fetchN, from, to, undefined, 0, filters), getRecentXcmIn(fetchN, from, to, undefined, 0, filters), getRecentXcmOutRemote(fetchN, from, to, undefined, 0, filters), getRecentXcmExecuted(fetchN, from, to, undefined, 0, filters)])).flat()
  } else {
    rows = (await getVoteFeedRows(limit, from, to, offset, filters, withCollective)).map(voteActivityRow)
  }
  if (locallyPaged && !classified) sourceSaturated = rows.length >= fetchN
  if (!plumbingApplied) rows = await suppressActivityPlumbing(rows)
  if (type !== 'all') rows = rows.filter(r => activityTypeMatchesFamily(r.type, type))
  if (filters.min != null && filters.unit !== 'token') await applyHistoricalUsd(rows, activityHistPick)
  rows = rows.filter(r => activityRowMatchesFilters(r, filters) && activityRowMatchesAction(r, action))
  rows.sort(compareActivityRowsNewestFirst)
  if (locallyPaged && rows.length < want && sourceSaturated) throw activityQueryTooBroad()
  return { rows, locallyPaged }
}

// How long the chain-wide Activity feed is under exactly the filters the page is
// showing, so its pager numbers real pages and its last page is one jump away.
//
// Only a category whose page IS its sources' rows, ordered and offset without
// classification, can be counted this way: the count is those sources' own
// predicates, so it cannot drift from the rows. `vote` qualifies. vote_activity is
// read newest-first under SQL LIMIT/OFFSET; its row builder turns every event it
// returns into exactly one feed row; neither plumbing rule can remove one (both
// only ever drop transfer rows); and its value filter is the same exact
// event-time predicate `rowMeetsExactUsdMinimum` re-applies to the built rows, so
// a filtered total matches the filtered feed.
//
// The vote feed is TWO such sources — vote_activity plus the collective (Council /
// Technical Committee) votes out of raw_events — so the total is their union,
// counted under exactly the conditions the feed reads them under: each source's
// own distinct (block, event) count, and the collective side omitted precisely
// when `collectiveVotesAdmitted` kept it out of the feed (any value floor, or a
// token filter that excludes BSX). Both sources are read newest-first with no
// cross-source classification, so no row can be counted in one and dropped in the
// other; getVoteFeedRows' rank translation only decides WHICH rows a page shows,
// never how many the feed holds.
//
// Nothing else does, for two different reasons. Staking is read the same way, but
// its row builder discards source events three ways — suppressGigaCompanionEvents
// drops the GigaHdx.Staked/Staking.ForceUnstaked companion of a migration or reward
// claim, stakingRowFromEvent returns null for an event carrying no amount in the
// requested asset, and repeats of one (block, extrinsic, event, who, asset, amount)
// collapse to a single row — so a source count is not its feed's length. OTC's row builder
// discards nothing: all three branches of otcRowFromEvent return a row, and a
// missing Placed leg only leaves the asset legs and amounts null. OTC is excluded
// because its FILTERS are not predicates over the rows being counted: a
// Cancelled/Filled event carries no asset identity or order amounts of its own,
// only the order's Placed event does, which is why getRecentOtc resolves legs
// after the fetch and then walks history in Node (`fetchFilteredDeep`) for a token
// or min filter. An unfiltered OTC count would in fact match its feed, so
// reporting no total for it is conservative rather than required. It stays
// excluded deliberately: a total that exists only when no filter is applied
// disappears the moment the user filters, which reads as a broken pager, and the
// depth-walking pager it falls back to is honest in both cases.
//
// The merged, trade, transfer, liquidity, money-market and cross-chain feeds are
// assembled from up to twelve sources and paged in Node after classification, so
// counting them means classifying chain-wide history — 78.5M transfer and 55.8M
// XCM candidates — which no request may do. An action filter is decided on built
// rows, never in SQL, so it takes any category out of the countable set.
// Those all report no total, and their pager walks by the servable depth instead.
export async function getGlobalActivityTotal(
  type: string,
  action: string | undefined,
  filters: ValueListFilters,
  from?: string,
  to?: string,
): Promise<ScopedListTotal> {
  if (normalizeActivityTypeKey(type) !== 'vote' || action) return { total: null, complete: false }
  // The identity filter is decided on the built row's actor, which this count
  // cannot see: it counts vote EVENTS in SQL. Reporting the unfiltered total
  // would have the pager offer pages the filtered list cannot fill, so it
  // reports no total and the pager walks a page at a time — the same honest
  // fallback every uncounted category already uses.
  if (filters.identity) return { total: null, complete: false }
  const tw = timeWindow(from, to)
  return cachedSwr(`explorer:activity-total:vote:${filterKey(filters)}:${from ?? ''}:${to ?? ''}`,
    LIST_TOTAL_FRESH_MS, LIST_TOTAL_STALE_MS, async (): Promise<ScopedListTotal> => {
      const prices = await ensurePrices()
      const tokenIds = assetIdsForToken(filters.token)
      // Votes lock BSX only, so any other token filter selects nothing.
      if (tokenIds != null && !tokenIds.includes(0)) return { total: 0, complete: true }
      const amountFilter = eventValueFilterSql('0', voteAmountSqlExpr(), 'block_timestamp', filters, prices, 'vote_price')
      const [res, collective] = await Promise.all([
        client.query({
          query: `SELECT toString(uniqExact((block_height, event_index))) AS c
                  FROM price_data.vote_activity FINAL
                  ${amountFilter.joinSql}
                  WHERE ${tw ?? '1'}
                    AND event_name IN ('ConvictionVoting.Voted','Democracy.Voted')
                    ${amountFilter.predicateSql}`,
          format: 'JSONEachRow',
        }),
        collectiveVotesAdmitted(filters) ? countCollectiveVotes(from, to) : 0,
      ])
      return { total: Number((await res.json<{ c: string }>())[0]?.c ?? 0) + collective, complete: true }
    })
}

export interface FailureReason { label: string; docs: string | null }

// camelCase → "spaced lower" (BuyLimitNotReached → "buy limit not reached").
function humanizeKind(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
}

// A pallet index, from either Module shape's `index`. Anything that is not a
// non-negative integer is absent, never 0 — 0 is the System pallet.
function dispatchPalletIndex(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  const index = Number(value)
  return Number.isInteger(index) && index >= 0 ? index : null
}

// An error index, from either Module shape's `error`: the low byte of the modern
// 4-byte little-endian hex array, or the flat shape's integer as it stands. An
// unreadable value is absent, never 0 — 0 is a real error index in every pallet.
function dispatchErrorIndex(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? value : null
  if (typeof value !== 'string') return null
  if (/^0x[0-9a-fA-F]{2,}$/.test(value)) {
    const low = parseInt(value.slice(2, 4), 16)
    return Number.isInteger(low) ? low : null
  }
  const index = Number(value)
  return Number.isInteger(index) && index >= 0 ? index : null
}

// Shared DispatchError → human reason. `resolve` names Module errors from the
// runtime_error_names lookup (spec-version keyed); a miss yields an honest
// `pallet <i> · error #<j>` label rather than a fabricated name. Named kinds
// (Token/Arithmetic/BadOrigin/…) are self-describing and carry no docs.
//
// A Module error states its pallet and error indices in one of TWO shapes, and
// both are live in `raw_extrinsics`:
//
//  * MODERN (blocks 1,476,029 →): `{__kind, value: {index, error}}`, where
//    `error` is a 4-byte little-endian array rendered as hex whose FIRST byte is
//    the error index inside the pallet.
//  * FLAT (blocks 692,900 … 1,475,949, 2022-07-06 … 2022-11-29, 601 rows):
//    `{__kind, index, error}` with both at the top level and `error` a plain
//    integer — no byte array to slice.
//
// The nested shape is read first so it stays authoritative wherever it exists.
// A Module error in neither shape reports nothing, because 0 is both a real
// pallet index (System) and a real error index, so defaulting either would name
// a triple the row never stated.
export function dispatchErrorReason(
  error: unknown,
  specVersion: number,
  resolve: (specVersion: number, palletIndex: number, errorIndex: number) => { pallet: string; name: string; docs: string } | null,
): FailureReason | null {
  const err = (typeof error === 'string' ? safeJson(error) : error) as Record<string, unknown> | null
  const kind = typeof err?.__kind === 'string' ? err.__kind : null
  if (!kind) return null
  if (kind === 'Module') {
    const nested = err?.value as { index?: unknown; error?: unknown } | undefined
    const source = dispatchPalletIndex(nested?.index) != null ? nested : err
    const palletIndex = dispatchPalletIndex(source?.index)
    const errorIndex = dispatchErrorIndex(source?.error)
    if (palletIndex == null || errorIndex == null) return null
    const hit = resolve(specVersion, palletIndex, errorIndex)
    return hit
      ? { label: `${hit.pallet}.${hit.name}`, docs: hit.docs || null }
      : { label: `pallet ${palletIndex} · error #${errorIndex}`, docs: null }
  }
  const value = err?.value as Record<string, unknown> | undefined
  const sub = typeof value?.__kind === 'string' ? value.__kind : null
  const label = sub ? `${kind} · ${humanizeKind(sub)}` : kind === 'Other' ? 'runtime error' : humanizeKind(kind)
  return { label, docs: null }
}

export async function getExtrinsicActivity(height: number, index: number): Promise<ActivityRow[]> {
  return cached(`explorer:extrinsic-activity:${height}:${index}`, 10000, async () => {
    const prices = await ensurePrices()
    const evRes = await client.query({
      query: `SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name, ifNull(call_address, '') AS call_address, args_json
              FROM price_data.raw_events
              WHERE block_height = {h:UInt32} AND extrinsic_index = {i:UInt32}
              ORDER BY event_index ASC`,
      query_params: { h: height, i: index },
      format: 'JSONEachRow',
    })
    const events = await evRes.json<{ block_height: number; ts: string; event_index: number; extrinsic_index: number | null; event_name: string; call_address: string; args_json: string }>()
    if (!events.length) return []

    const signerMap = await actorsFor([[height, index]])
    const signer = signerMap.get(`${height}:${index}`) ?? null
    const rows: ActivityRow[] = []
    const bsx = asset(0)

    const transferRows: RawTransferEventRow[] = []
    const withdrawnByAmount = new Map<string, number>()
    for (const e of events) {
      const args = (safeJson(e.args_json) ?? {}) as Record<string, unknown>
      if (e.event_name === 'Balances.Transfer' || e.event_name === 'Tokens.Transfer' || e.event_name === 'Currencies.Transferred') {
        transferRows.push({
          block_height: e.block_height,
          ts: e.ts,
          event_index: e.event_index,
          extrinsic_index: e.extrinsic_index,
          event_name: e.event_name,
          from_acc: argStr(args, 'from'),
          to_acc: argStr(args, 'to'),
          amount: argStr(args, 'amount'),
          asset_id: e.event_name === 'Balances.Transfer' ? 0 : argInt(args, 'currencyId', 'currency_id', 'assetId', 'asset_id'),
        })
      }
      if (e.event_name === 'Currencies.Withdrawn') {
        withdrawnByAmount.set(argStr(args, 'amount'), argInt(args, 'currencyId', 'currency_id', 'assetId', 'asset_id'))
      }
    }

    const swapEvents = events.filter(e => SWAP_EVENTS.includes(e.event_name))
    // A batch dispatching several routes is several trades. Keeping only the first
    // route hid the rest — a proxied multisig batch showed one leg and dropped the
    // other, on the very page that lists what the extrinsic did.
    for (const route of routeGroups(swapEvents)) {
      const rep = route.find(e => isRouterNet(e.event_name)) ?? route[route.length - 1]
      const args = (safeJson(rep.args_json) ?? {}) as Record<string, unknown>
      const aIn = asset(Number(args.assetIn ?? 0))
      const aOut = asset(Number(args.assetOut ?? 0))
      rows.push({
        type: 'trade',
        blockHeight: rep.block_height,
        timestamp: rep.ts,
        eventIndex: rep.event_index,
        extrinsicIndex: rep.extrinsic_index,
        who: signer ? accountRef(signer) : null,
        to: null,
        asset: null,
        assetIn: aIn,
        assetOut: aOut,
        amount: null,
        amountIn: argStr(args, 'amountIn'),
        amountOut: argStr(args, 'amountOut'),
        valueUsd: usdValue(prices, aOut.assetId, argStr(args, 'amountOut'), aOut.decimals),
        linkBlock: rep.block_height,
        linkIndex: rep.extrinsic_index,
      })
    }

    // Outbound XCM in either shape; when an extrinsic emits both (XTokens routed
    // through pallet_xcm) the legacy event wins so the transfer isn't doubled.
    const xcmEvents = events.filter(e => isXTokensSentEvent(e.event_name) || e.event_name === 'PolkadotXcm.Sent')
    const xcmLegacyExts = new Set(xcmEvents.filter(e => isXTokensSentEvent(e.event_name)).map(e => `${e.block_height}:${e.extrinsic_index}`))
    for (const e of xcmEvents) {
      if (e.event_name === 'PolkadotXcm.Sent' && xcmLegacyExts.has(`${e.block_height}:${e.extrinsic_index}`)) continue
      const parsed = parseOutboundXcm(safeJson(e.args_json))
      if (!parsed) continue
      for (const amount of parsed.amounts) {
        const cid = withdrawnByAmount.get(amount)
        if (cid == null) continue
        rows.push(outboundXcmRow(e, parsed.sender, cid, amount, parsed.dest, prices))
      }
    }

    // Executor-dispatched outbound XCM (PolkadotXcm.execute, or a RuntimeCall through the
    // EVM dispatch precompile): the message leaves via XcmpQueue.XcmpMessageSent with no
    // Sent/TransferredAssets event, so the user's withdrawal events are the only trace of
    // what left. Emit them as xcm-out rows (the arbitrary program isn't parsed —
    // destination stays unknown, per the "keep unresolved XCM explicit" rule). Skipped only
    // when an xcm row already exists; see emitsExecutedOutboundXcm for why a trade row must
    // NOT suppress it.
    const sentExecutedXcm = events.some(e => e.event_name === XCM_EXECUTED_SEND_EVENT)
    if (emitsExecutedOutboundXcm(sentExecutedXcm, rows.map(r => r.type))) {
      // Same fold, same key, same order as the feed arm (xcmExecutedRowsForBlocks): a send is
      // one activity, and the surfaces must not disagree about how many rows it is.
      const legs = events
        .filter(e => e.event_name === 'Currencies.Withdrawn')
        .map(e => {
          const args = (safeJson(e.args_json) ?? {}) as Record<string, unknown>
          return { e, who: argStr(args, 'who'), amount: argStr(args, 'amount'), cid: argInt(args, 'currencyId', 'currency_id') }
        })
        .filter(leg => admitsExecutedXcmWithdrawal(leg.who, leg.amount))
      for (const { e, who, amount, cid } of executedXcmPayloadLegs(
        legs,
        leg => `${executedXcmExtrinsicKey(leg.e.block_height, leg.e.extrinsic_index)}:${leg.who}`,
        leg => leg.e.event_index,
      )) {
        const a = asset(cid)
        rows.push({
          type: 'xcm', blockHeight: e.block_height, timestamp: e.ts, eventIndex: e.event_index, extrinsicIndex: e.extrinsic_index,
          who: accountRef(who), to: null, asset: a, assetIn: null, assetOut: null,
          amount, amountIn: null, amountOut: null, valueUsd: usdValue(prices, a.assetId, amount, a.decimals),
          xcmDir: 'out', xcmExecuted: true, linkBlock: e.block_height, linkIndex: e.extrinsic_index,
        })
      }
      // The bridge is the user's highest-level action here, so the swap beside it is the
      // delivery-fee purchase that funded it, not a trade they made. Drop it once the send
      // has a row — the same extrinsic-keyed ownership suppressActivityPlumbing applies to
      // transfer legs, which cannot express this because it only ever removes transfers.
      if (isBridgePlumbingSwap(sentExecutedXcm) && rows.some(r => r.type === 'xcm')) {
        for (let i = rows.length - 1; i >= 0; i--) if (rows[i].type === 'trade') rows.splice(i, 1)
      }
    }

    const liqRows = events
      .filter(e => LIQUIDITY_EVENTS.includes(e.event_name))
      .map(e => {
        const args = (safeJson(e.args_json) ?? {}) as Record<string, unknown>
        return {
          block_height: e.block_height,
          extrinsic_index: e.extrinsic_index,
          event_name: e.event_name,
          ...liquidityCandidateArgs(e.event_name, args),
          ts: e.ts,
          event_index: e.event_index,
        }
      })
    await fillMissingLiquidityAmounts(liqRows)
    const createCands: { row: ActivityRow; pool: string; assetB: number }[] = []
    for (const r of liqRows) {
      const a = asset(r.asset_id)
      const row: ActivityRow = {
        type: 'liquidity', blockHeight: r.block_height, timestamp: r.ts, eventIndex: r.event_index, extrinsicIndex: r.extrinsic_index,
        who: r.who ? accountRef(r.who) : null, to: null, asset: a, assetIn: null, assetOut: null,
        ...liquidityRowAmount(r.event_name, prices, a.assetId, r.amount, a.decimals), amountIn: null, amountOut: null,
        liqAction: liqActionFor(r.event_name),
        linkBlock: r.block_height, linkIndex: r.extrinsic_index,
      }
      if (r.event_name === 'XYK.PoolCreated') createCands.push({ row, pool: r.pool_acc, assetB: r.asset_b })
      rows.push(row)
    }
    // Pool creations render both seed legs + their combined block-time value.
    await enrichPoolCreations(createCands)

    const voteEvents = events.filter(e => e.event_name === 'ConvictionVoting.Voted' || e.event_name === 'Democracy.Voted')
    const convictionCalls = new Map<string, { ref: string | null; details: VoteDetails }>()
    const convictionCallInfos: { ref: string | null; details: VoteDetails }[] = []
    if (voteEvents.some(e => e.event_name === 'ConvictionVoting.Voted')) {
      const calls = await client.query({
        query: `SELECT call_address, call_name, args_json
                FROM price_data.raw_calls
                WHERE block_height = {h:UInt32} AND extrinsic_index = {i:UInt32}
                  AND call_name IN ('ConvictionVoting.vote', 'MultiTransactionPayment.dispatch_permit', ${VOTE_WRAPPER_CALLS})`,
        query_params: { h: height, i: index },
        format: 'JSONEachRow',
      })
      const callRows = await calls.json<{ call_address: string; call_name: string; args_json: string }>()
      for (const c of callRows) {
        const args = (safeJson(c.args_json) ?? {}) as Record<string, unknown>
        // Gasless votes: the vote call hides SCALE-encoded in the permit payload.
        const info = c.call_name === 'MultiTransactionPayment.dispatch_permit'
          ? voteFromPermitData(args.data)
          : c.call_name === 'ConvictionVoting.vote'
            ? (() => { const ref = argStr(args, 'pollIndex'); return ref ? { ref, details: voteDetails(args) } : null })()
            : null
        if (!info) continue
        convictionCalls.set(c.call_address, info)
        convictionCallInfos.push(info)
      }
      // Wrapper fallback for votes whose nested call row is unavailable.
      if (!convictionCallInfos.length) {
        for (const c of callRows) {
          if (c.call_name === 'ConvictionVoting.vote' || c.call_name === 'MultiTransactionPayment.dispatch_permit') continue
          convictionCallInfos.push(...nestedVoteInfos(safeJson(c.args_json)))
        }
      }
    }
    for (const e of voteEvents) {
      const args = (safeJson(e.args_json) ?? {}) as Record<string, unknown>
      const account = argStr(args, e.event_name === 'Democracy.Voted' ? 'voter' : 'who')
      const onlyCall = convictionCallInfos.length === 1 ? convictionCallInfos[0] : undefined
      const callInfo = e.event_name === 'ConvictionVoting.Voted' ? (convictionCalls.get(e.call_address) ?? onlyCall) : undefined
      const details = mergeVoteDetails(voteDetails(args), callInfo?.details)
      rows.push({
        type: 'vote', blockHeight: e.block_height, timestamp: e.ts, eventIndex: e.event_index, extrinsicIndex: e.extrinsic_index,
        who: account && ACCOUNT_RE.test(account) ? accountRef(account) : null, to: null,
        asset: bsx, assetIn: null, assetOut: null, amount: details.amount, amountIn: null, amountOut: null,
        valueUsd: details.amount ? usdValue(prices, bsx.assetId, details.amount, bsx.decimals) : null,
        votePallet: e.event_name.split('.')[0], voteAction: 'Voted',
        voteRef: e.event_name === 'Democracy.Voted' ? argStr(args, 'refIndex') || null : callInfo?.ref ?? null,
        ...referendumRefFields(e.event_name.split('.')[0], e.event_name === 'Democracy.Voted' ? argStr(args, 'refIndex') || null : callInfo?.ref ?? null),
        voteSide: details.side, voteConviction: details.conviction,
        linkBlock: e.block_height, linkIndex: e.extrinsic_index,
      })
    }

    // Collective (Council / Technical Committee) votes, through the same builder
    // the merged feed reads them with — so /vote/<block>-e<index> resolves for one
    // of them and says exactly what the feed said. No hook variant: a collective
    // vote needs a member origin, so it always has an extrinsic (the same reason
    // getBlockHookActivity has no vote arm for the conviction pallets either).
    for (const e of events.filter(ev => COLLECTIVE_VOTE_EVENTS.includes(ev.event_name))) {
      rows.push(voteActivityRow(collectiveVoteRow(e, bsx)))
    }

    const semanticExtrinsic = rows.length > 0
    const createdPools = new Set(liqRows.filter(r => r.event_name === 'XYK.PoolCreated').map(r => r.pool_acc).filter(Boolean))
    const pools = ammPoolAccounts()
    for (const t of dedupeTransferEvents(transferRows)) {
      if (!t.from_acc || !t.to_acc || !t.amount) continue
      const moduleLeg = /^0x(6d6f646c|7369626c|70617261|506172656e74)/.test(t.from_acc) || /^0x(6d6f646c|7369626c|70617261|506172656e74)/.test(t.to_acc)
      const poolLeg = pools.has(t.from_acc.toLowerCase()) || pools.has(t.to_acc.toLowerCase())
      if (semanticExtrinsic && (moduleLeg || poolLeg || createdPools.has(t.to_acc) || createdPools.has(t.from_acc))) continue
      const a = asset(t.asset_id)
      rows.push({
        type: 'transfer', blockHeight: t.block_height, timestamp: t.ts, eventIndex: t.event_index, extrinsicIndex: t.extrinsic_index,
        who: accountRef(t.from_acc), to: accountRef(t.to_acc), asset: a, assetIn: null, assetOut: null,
        amount: t.amount, amountIn: null, amountOut: null, valueUsd: usdValue(prices, a.assetId, t.amount, a.decimals),
        linkBlock: t.block_height, linkIndex: t.extrinsic_index,
      })
    }

    const seen = new Set<string>()
    const deduped = await suppressActivityPlumbing(rows.filter(r => {
      const key = `${r.type}:${r.blockHeight}:${r.extrinsicIndex ?? ''}:${r.asset?.assetId ?? r.assetIn?.assetId ?? ''}:${r.who?.accountId ?? ''}:${r.to?.accountId ?? ''}:${r.amount ?? r.amountIn ?? ''}:${r.amountOut ?? ''}:${r.voteRef ?? ''}:${r.liqAction ?? ''}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).filter((r, _i, all) => {
      // Consolidate liquidity-routed mechanics: when this extrinsic carries a liquidity
      // add/remove, routing into or out of the pool share is that action's own mechanics
      // rather than a separate trade — the mirror of dropShareRoutedTrades.
      if (!all.some(x => x.type === 'liquidity')) return true
      return !(r.type === 'trade' && ((r.assetIn && isShareAssetId(r.assetIn.assetId)) || (r.assetOut && isShareAssetId(r.assetOut.assetId))))
    }))
    await applyHistoricalUsd(deduped, activityHistPick)
    return deduped
  })
}

export async function getBlockActivity(height: number): Promise<ActivityRow[]> {
  return cached(`explorer:block-activity:${height}`, 10000, async () => {
    const extRes = await client.query({
      query: `SELECT DISTINCT extrinsic_index
              FROM price_data.raw_extrinsics
              WHERE block_height = {h:UInt32}
              ORDER BY extrinsic_index`,
      query_params: { h: height },
      format: 'JSONEachRow',
    })
    const extIndices = (await extRes.json<{ extrinsic_index: number }>())
      .map(r => r.extrinsic_index)
      .filter(i => Number.isInteger(i))

    const [extRows, hookRows] = await Promise.all([
      Promise.all(extIndices.map(i => getExtrinsicActivity(height, i))).then(parts => parts.flat()),
      getBlockHookActivity(height),
    ])

    const seen = new Set<string>()
    const merged = (await suppressActivityPlumbing([...extRows, ...hookRows]
      .filter(r => {
        const key = `${r.type}:${r.blockHeight}:${r.extrinsicIndex ?? ''}:${r.eventIndex ?? ''}:${r.asset?.assetId ?? r.assetIn?.assetId ?? ''}:${r.assetOut?.assetId ?? ''}:${r.who?.accountId ?? ''}:${r.to?.accountId ?? ''}:${r.amount ?? r.amountIn ?? ''}:${r.amountOut ?? ''}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })))
      .sort((a, b) => {
        const ax = a.extrinsicIndex ?? Number.MAX_SAFE_INTEGER
        const bx = b.extrinsicIndex ?? Number.MAX_SAFE_INTEGER
        if (ax !== bx) return ax - bx
        return (a.eventIndex ?? 0) - (b.eventIndex ?? 0)
      })
    await applyHistoricalUsd(merged, activityHistPick)
    return merged
  })
}

async function getBlockHookActivity(height: number): Promise<ActivityRow[]> {
  const prices = await ensurePrices()
  const names = SWAP_EVENTS.map(n => `'${n}'`).join(',')
  const transferPlumbing = [...ammPoolAccounts()]
  const transferPlumbingList = transferPlumbing.length ? transferPlumbing.map(a => `'${a}'`).join(',') : "''"
  const [swapRes, xcmInRows, xcmOutRemoteRows, transferRes, liquidityRes] = await Promise.all([
    client.query({
      query: `SELECT event_index, event_name, args_json, toString(block_timestamp) AS ts
              FROM price_data.raw_events
              WHERE block_height = {h:UInt32}
                AND extrinsic_index IS NULL
                AND event_name IN (${names})
                ${NOT_ROUTER_HOP}
              ORDER BY event_index`,
      query_params: { h: height },
      format: 'JSONEachRow',
    }),
    xcmInRowsForBlocks([height], prices),
    xcmOutRemoteRowsForBlocks([height], prices),
    // Extrinsic-less transfers (hook-driven treasury/vesting/reward payouts and
    // user↔user moves). Classified with the shared non-plumbing leg filter — NOT
    // a blanket module exclusion — so genuine pallet-pot payouts stay visible and
    // resolve on their detail page, mirroring the account feed. Cross-event-name
    // de-dup (a single transfer often emits both Currencies.Transferred and a
    // Tokens.Transfer/Balances.Transfer) is handled afterwards by the shared
    // dedupeTransferEvents helper.
    client.query({
      query: `SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name,
                JSONExtractString(args_json, 'from') AS from_acc,
                JSONExtractString(args_json, 'to') AS to_acc,
                JSONExtractString(args_json, 'amount') AS amount,
                ${transferAssetIdSql()} AS asset_id
              FROM price_data.raw_events
              WHERE block_height = {h:UInt32} AND extrinsic_index IS NULL
                AND event_name IN (${sqlEventNameList(TRANSFER_EVENTS)})
                ${nonPlumbingTransferLegSql("JSONExtractString(args_json,'from')", "JSONExtractString(args_json,'to')", transferPlumbingList)}
              ORDER BY event_index`,
      query_params: { h: height },
      format: 'JSONEachRow',
    }),
    // Extrinsic-less liquidity (an add/remove dispatched by a runtime hook or the
    // scheduler rather than a signed call) — same event list + module-account
    // exclusion as getRecentLiquidity (source of truth).
    client.query({
      query: `SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name,
                if(JSONHas(args_json,'who'), JSONExtractString(args_json,'who'), JSONExtractString(args_json,'owner')) AS who,
                multiIf(JSONHas(args_json,'rewardCurrency'), JSONExtractInt(args_json,'rewardCurrency'),
                  JSONHas(args_json,'assetId'), JSONExtractInt(args_json,'assetId'),
                  JSONHas(args_json,'poolId'), JSONExtractInt(args_json,'poolId'),
                  JSONHas(args_json,'assetA'), JSONExtractInt(args_json,'assetA'),
                  JSONHas(args_json,'asset'), JSONExtractInt(args_json,'asset'),
                  JSONExtractInt(args_json,'asset_id')) AS asset_id,
                multiIf(JSONHas(args_json,'claimed'), JSONExtractString(args_json,'claimed'), JSONHas(args_json,'amount'), JSONExtractString(args_json,'amount'), JSONExtractString(args_json,'shares')) AS amount
              FROM price_data.raw_events
              WHERE block_height = {h:UInt32} AND extrinsic_index IS NULL
                AND event_name IN (${sqlEventNameList(LIQUIDITY_EVENTS)})
                AND who NOT LIKE '0x6d6f646c%'
              ORDER BY event_index`,
      query_params: { h: height },
      format: 'JSONEachRow',
    }),
  ])
  const swaps = await swapRes.json<{ event_index: number; event_name: string; args_json: string; ts: string }>()
  const rows: ActivityRow[] = []

  const swapCandidates = swaps.map(s => {
    const args = (safeJson(s.args_json) ?? {}) as Record<string, unknown>
    return { row: s, args, amounts: swapEventAmounts(s.event_name, args) }
  })
  for (const s of swapCandidates) {
    const aOut = asset(s.amounts.assetOut)
    const who = argStr(s.args, 'who')
    rows.push({
      type: 'trade',
      blockHeight: height,
      timestamp: s.row.ts,
      eventIndex: s.row.event_index,
      extrinsicIndex: null,
      who: who && ACCOUNT_RE.test(who) && who !== ROUTER_PALLET_ACCT ? accountRef(who) : null,
      to: null,
      asset: null,
      assetIn: asset(s.amounts.assetIn),
      assetOut: aOut,
      amount: null,
      amountIn: s.amounts.amountIn,
      amountOut: s.amounts.amountOut,
      valueUsd: usdValue(prices, aOut.assetId, s.amounts.amountOut, aOut.decimals),
      linkBlock: height,
      linkIndex: null,
    })
  }
  await attachHookSwapActors(rows)

  rows.push(...xcmInRows)
  rows.push(...xcmOutRemoteRows)

  // Extrinsic-less transfers — same shape as toTransferRow in getRecentActivity,
  // collapsed across event names by the shared dedupeTransferEvents helper (the
  // same one getExtrinsicActivity uses for its per-extrinsic transfer legs).
  const transferEvents = dedupeTransferEvents(
    await transferRes.json<RawTransferEventRow>())
  for (const t of transferEvents) {
    if (!t.from_acc || !t.to_acc || !t.amount) continue
    const a = asset(t.asset_id)
    rows.push({
      type: 'transfer', blockHeight: t.block_height, timestamp: t.ts, eventIndex: t.event_index, extrinsicIndex: t.extrinsic_index,
      who: accountRef(t.from_acc), to: accountRef(t.to_acc), asset: a, assetIn: null, assetOut: null,
      amount: t.amount, amountIn: null, amountOut: null, valueUsd: usdValue(prices, a.assetId, t.amount, a.decimals),
    })
  }

  // Extrinsic-less liquidity — mirrors getRecentLiquidity's construction
  // (including its fillMissingLiquidityAmounts backfill, a no-op here since it
  // only applies to extrinsic-scoped rows).
  const liqRows = await liquidityRes.json<LiquidityAmountCandidate & { ts: string }>()
  await fillMissingLiquidityAmounts(liqRows)
  const seenLiquidity = new Set<string>()
  for (const r of liqRows) {
    const key = `${r.block_height}:${r.event_index}`
    if (seenLiquidity.has(key)) continue
    seenLiquidity.add(key)
    const a = asset(r.asset_id)
    rows.push({
      type: 'liquidity', blockHeight: r.block_height, timestamp: r.ts, eventIndex: r.event_index, extrinsicIndex: r.extrinsic_index,
      who: r.who ? accountRef(r.who) : null, to: null, asset: a, assetIn: null, assetOut: null,
      ...liquidityRowAmount(r.event_name, prices, a.assetId, r.amount, a.decimals), amountIn: null, amountOut: null,
      liqAction: liqActionFor(r.event_name),
    })
  }

  return rows
}

// ── A pool's own swaps ────────────────────────────────────────────────────────
//
// What traded IN this pool, which is not what any other feed shows. Everywhere
// else a routed swap is one row — its Router.Executed net summary, attributed
// to the person, with the hops collapsed and rows whose `who` is the router pot
// filtered out. That is right for a reader following an account or an asset,
// and wrong for a pool: pool 690's vDOT/aDOT swaps are hops of routes whose net
// legs name neither pool member nor its share token, so the pool page (which
// asks for the SHARE token's activity) could only ever show trades of the share
// token itself, and the swaps that actually happened in the pool appeared
// nowhere.
//
// So this reads the hops deliberately, scoped to the pool: both legs are pool
// members and the venue is the pool's own pallet. `asset_swap_activity` is
// ORDER BY (asset_id, block_height, event_index), so pinning one member makes
// it an index-prefix read — 8ms on pool 690. The actor still comes from the
// extrinsic's signer, so a hop names the person who caused it rather than the
// router pot that executed it.
const POOL_VENUE_EVENTS: Record<string, string[]> = {
  xyk: ['XYK.SellExecuted', 'XYK.BuyExecuted'],
}
export async function getPoolSwaps(poolId: number, members: number[], kind: string, limit = 25): Promise<ActivityRow[]> {
  const events = POOL_VENUE_EVENTS[kind]
  if (!events || members.length < 2) return []
  return cached(`explorer:pool-swaps:${poolId}:${limit}:${await liveHeadTag()}`, LIVE_CACHE_MS, async () => {
    const prices = await ensurePrices()
    const res = await client.query({
      query: `
        SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name,
               who, asset_in, asset_out, amount_in, amount_out
        FROM price_data.asset_swap_activity
        WHERE asset_id = {pin:UInt32}
          AND event_name IN (${events.map(n => `'${n}'`).join(',')})
          AND asset_in IN {members:Array(UInt32)} AND asset_out IN {members:Array(UInt32)}
        ORDER BY block_height DESC, event_index DESC
        LIMIT {n:UInt32}`,
      query_params: { pin: members[0], members, n: limit }, format: 'JSONEachRow',
    })
    const rows = await res.json<RawSwapEventRow>()
    if (!rows.length) return []
    // Two pools could hold the same pair, so the venue is confirmed against the
    // pool id the event itself carries — a bounded lookup over these rows only.
    const keys = rows.map(r => `(${r.block_height},${r.event_index})`).join(',')
    const idRes = await client.query({
      query: `SELECT block_height, event_index FROM price_data.raw_events
              WHERE (block_height, event_index) IN (${keys})
                AND JSONExtractInt(args_json, 'poolId') = {poolId:UInt32}`,
      query_params: { poolId }, format: 'JSONEachRow',
    })
    const mine = new Set((await idRes.json<{ block_height: number; event_index: number }>())
      .map(r => `${r.block_height}:${r.event_index}`))
    const own = rows.filter(r => mine.has(`${r.block_height}:${r.event_index}`))
    if (!own.length) return []
    const signers = await actorsFor(own.map(r => [r.block_height, r.extrinsic_index] as [number, number | null]))
    return own.map(r => {
      const aIn = asset(r.asset_in), aOut = asset(r.asset_out)
      const actor = (r.extrinsic_index != null ? signers.get(`${r.block_height}:${r.extrinsic_index}`) : undefined)
        ?? (r.who && ACCOUNT_RE.test(r.who) ? r.who : null)
      return {
        type: 'trade' as const,
        blockHeight: r.block_height, timestamp: r.ts, eventIndex: r.event_index, extrinsicIndex: r.extrinsic_index,
        who: actor ? accountRef(actor) : null, to: null, asset: null,
        assetIn: aIn, assetOut: aOut, amount: null, amountIn: r.amount_in, amountOut: r.amount_out,
        valueUsd: usdValue(prices, r.asset_out, r.amount_out, aOut.decimals)
          ?? usdValue(prices, r.asset_in, r.amount_in, aIn.decimals),
        assetRefs: [r.asset_in, r.asset_out],
        dca: false,
        linkBlock: r.block_height, linkIndex: r.extrinsic_index,
      }
    })
  })
}

// asset-scoped activity (asset detail page)
// A per-asset activity feed built SERVER-SIDE so it works regardless of how
// recent the asset's activity is. Each category is filtered by the asset at the SQL level
// (asset_id = id for transfers/liquidity/xcm/mm; assetIn = id OR assetOut = id
// for trades) over the full block range, then merged and sliced. The `type` chip
// selects a single category server-side so rare types aren't starved by the slice.
// Literal assetId match only — no aToken/share-token expansion.
export async function getAssetActivity(assetId: number, type = 'all', limit = 40, offset = 0, action?: string, filters: ValueListFilters = {}, from?: string, to?: string): Promise<ActivityRow[]> {
  try {
    return await assetActivityPage(assetId, type, limit, offset, action, filters, from, to)
  } catch (error) {
    throw activityReadFailure(error)
  }
}

async function assetActivityPage(assetId: number, type = 'all', limit = 40, offset = 0, action?: string, filters: ValueListFilters = {}, from?: string, to?: string): Promise<ActivityRow[]> {
  const tw = timeWindow(from, to)
  return cached(`explorer:asset-activity:${assetId}:${type}:${limit}:${offset}:${action ?? ''}:${filterKey(filters)}:${from ?? ''}:${to ?? ''}`, tw ? 30000 : 8000, async () => {
    const prices = await ensurePrices()
    const bound = tw ?? '1'
    const want = offset + limit
    // Sources either push value predicates below LIMIT or cursor-walk enriched
    // rows. This count is therefore pagination/classification capacity, never
    // probabilistic headroom for a post-filter.
    const fetchN = Math.max(want * 5, 1000)
    // Event-time USD filters are exact post-filters over bounded, asset-indexed
    // candidates. Pushing the ASOF price join below each source LIMIT makes a
    // cold asset page value its complete source history before it can stop.
    // Token-unit thresholds remain safe and selective in the source query.
    const queryFilters = filters.min != null && filters.unit !== 'token'
      ? { ...filters, min: undefined, unit: undefined }
      : filters
    const fixedAssetFilters: ValueListFilters = { ...queryFilters, token: undefined }

    // Transfers: filter by asset and user-facing accounts in SQL before limiting,
    // otherwise busy module/pool activity can fill a page and hide real transfers.
    type = normalizeActivityTypeKey(type)
    const wantTransfers = type === 'all' || type === 'transfer'
    // Classification context: the Transfers view must exclude trade/staking/MM
    // legs, and Trades must yield share-routed legs to Liquidity — so those
    // categories are fetched whenever their exclusion sets are needed.
    const wantTrades = type === 'all' || type === 'trade' || wantTransfers
    const wantLiquidity = type === 'all' || type === 'liquidity' || wantTrades
    const wantXcm = type === 'all' || type === 'xcm' || wantTransfers
    const wantVotes = (type === 'all' || type === 'vote' || wantTransfers) && assetId === 0

    const transfersP: Promise<ActivityRow[]> = wantTransfers ? (async () => {
      const useTransferReadModel = true
      const transferAssetExpr = useTransferReadModel ? 'asset_id' : transferAssetIdSql()
      const transferValueFilter = eventValueFilterSql('{assetId:UInt32}', useTransferReadModel ? 'amount' : `JSONExtractString(args_json,'amount')`, 'block_timestamp', queryFilters, prices, 'asset_transfer_price')
      const nttExclusion = ''
      const res = await client.query({
        query: useTransferReadModel ? `
          SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name,
            from_account AS from_acc, to_account AS to_acc, amount
          FROM price_data.transfer_activity
          ${transferValueFilter.joinSql}
          WHERE ${bound} AND asset_id = {assetId:UInt32}
            AND from_account NOT LIKE '0x6d6f646c%'
            AND to_account NOT LIKE '0x6d6f646c%'
            ${nttExclusion}
            ${transferValueFilter.predicateSql}
          ORDER BY block_height DESC, event_index DESC
          LIMIT {n:UInt32}` : `
          SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name,
            JSONExtractString(args_json,'from') AS from_acc,
            JSONExtractString(args_json,'to') AS to_acc,
            JSONExtractString(args_json,'amount') AS amount
          FROM price_data.raw_events
          ${transferValueFilter.joinSql}
          WHERE ${bound}
            AND event_name IN ('Balances.Transfer','Tokens.Transfer','Currencies.Transferred')
            AND ${transferAssetExpr} = {assetId:UInt32}
            AND JSONExtractString(args_json,'from') NOT LIKE '0x6d6f646c%'
            AND JSONExtractString(args_json,'to') NOT LIKE '0x6d6f646c%'
            ${transferValueFilter.predicateSql}
          ORDER BY block_height DESC, event_index DESC
          LIMIT {n:UInt32}`,
        query_params: { n: fetchN, assetId }, format: 'JSONEachRow',
      })
      const rows = dedupeTransferEvents((await res.json<{ block_height: number; ts: string; event_index: number; extrinsic_index: number | null; event_name: string; from_acc: string; to_acc: string; amount: string }>())
        .map(r => ({ ...r, asset_id: assetId })))
      const a = asset(assetId)
      const seen = new Set<string>()
      const out: ActivityRow[] = []
      for (const r of rows) {
        const key = `${r.block_height}:${r.event_index}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({
          type: 'transfer', blockHeight: r.block_height, timestamp: r.ts, eventIndex: r.event_index, extrinsicIndex: r.extrinsic_index,
          who: accountRef(r.from_acc), to: accountRef(r.to_acc), asset: a, assetIn: null, assetOut: null,
          amount: r.amount, amountIn: null, amountOut: null, valueUsd: usdValue(prices, a.assetId, r.amount, a.decimals),
          linkBlock: r.block_height, linkIndex: r.extrinsic_index,
        })
      }
      return out
    })() : Promise.resolve([])

    // Trades: swaps where the asset is either leg. Grouped per ROUTE, preferring the
    // Router.Executed net summary that touches this asset. A `LIMIT 1 BY` per extrinsic
    // used to collapse the rows before `swapRouteReps` could split them, so a batch
    // dispatching two routes over this asset showed only the last.
    const tradesP: Promise<ActivityRow[]> = wantTrades ? (async () => {
      const names = SWAP_EVENTS.map(n => `'${n}'`).join(',')
      const useAssetSwapReadModel = true
      const tradeValueFilter = eventValueFilterSql(useAssetSwapReadModel ? 'asset_out' : `JSONExtractInt(args_json,'assetOut')`, useAssetSwapReadModel ? 'amount_out' : `JSONExtractString(args_json,'amountOut')`, 'block_timestamp', fixedAssetFilters, prices, 'asset_trade_price')
      const res = await client.query({
        query: useAssetSwapReadModel ? `
          SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name,
            who, asset_in, asset_out, amount_in, amount_out
          FROM price_data.asset_swap_activity
          ${tradeValueFilter.joinSql}
          WHERE ${bound} AND asset_id = {assetId:UInt32}
            AND who != '${ROUTER_PALLET_ACCT}'
            ${tradeValueFilter.predicateSql}
          ORDER BY block_height DESC, extrinsic_index DESC, event_name IN (${ROUTER_NET_EVENTS_SQL}) DESC, event_index DESC
          LIMIT {n:UInt32}` : `
          SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name,
            JSONExtractString(args_json,'who') AS who,
            JSONExtractInt(args_json,'assetIn') AS asset_in,
            JSONExtractInt(args_json,'assetOut') AS asset_out,
            JSONExtractString(args_json,'amountIn') AS amount_in,
            JSONExtractString(args_json,'amountOut') AS amount_out
          FROM price_data.raw_events
          ${tradeValueFilter.joinSql}
          WHERE ${bound}
            AND event_name IN (${names}) ${NOT_ROUTER_HOP}
            AND (JSONExtractInt(args_json,'assetIn') = ${assetId} OR JSONExtractInt(args_json,'assetOut') = ${assetId})
            ${tradeValueFilter.predicateSql}
          ORDER BY block_height DESC, extrinsic_index DESC, event_name IN (${ROUTER_NET_EVENTS_SQL}) DESC, event_index DESC
          LIMIT {n:UInt32}`,
        query_params: { n: fetchN, assetId }, format: 'JSONEachRow',
      })
      const rows = await res.json<RawSwapEventRow>()
      if (!rows.length) return []
      const pairs = rows.map(r => [r.block_height, r.extrinsic_index] as [number, number | null])
      const signers = await actorsFor(pairs)
      const out: ActivityRow[] = []
      // Prefer each route's Router.Executed net summary, but only if it touches the
      // asset (a multi-hop route's net legs may not include it even when a hop does).
      for (const rep of swapRouteReps(rows, r => r.asset_in === assetId || r.asset_out === assetId)) {
        const signer = rep.extrinsic_index != null ? signers.get(`${rep.block_height}:${rep.extrinsic_index}`) : undefined
        const actor = signer ?? (rep.who && ACCOUNT_RE.test(rep.who) ? rep.who : null)
        const aOut = asset(rep.asset_out)
        out.push({
          type: 'trade', blockHeight: rep.block_height, timestamp: rep.ts, eventIndex: rep.event_index, extrinsicIndex: rep.extrinsic_index,
          who: actor ? accountRef(actor) : null, to: null, asset: null, assetIn: asset(rep.asset_in), assetOut: aOut,
          amount: null, amountIn: rep.amount_in, amountOut: rep.amount_out,
          valueUsd: usdValue(prices, aOut.assetId, rep.amount_out, aOut.decimals),
          linkBlock: rep.extrinsic_index != null ? rep.block_height : null, linkIndex: rep.extrinsic_index,
        })
      }
      await attachHookSwapActors(out)
      return out
    })() : Promise.resolve([])

    // Liquidity: add/remove where the provided/pool asset matches.
    const liquidityP: Promise<ActivityRow[]> = wantLiquidity ? (async () => {
      const fetchPage = async (pageBound: string, pageLimit: number): Promise<ActivityRow[]> => {
        const res = await client.query({
          query: `
          SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name,
            who AS who,
            amount AS amount,
            asset_b AS asset_b,
            pool_account AS pool_acc
          FROM price_data.liquidity_activity
          WHERE ${pageBound}
            AND event_name IN (${sqlEventNameList(LIQUIDITY_EVENTS)})
            AND who NOT LIKE '0x6d6f646c%'
            AND has(asset_refs, {assetId:UInt32})
          ORDER BY block_height DESC, event_index DESC
          LIMIT {n:UInt32}`,
          query_params: { n: pageLimit, assetId }, format: 'JSONEachRow',
        })
        const rows = (await res.json<{ block_height: number; ts: string; event_index: number; extrinsic_index: number | null; event_name: string; who: string; amount: string; asset_b: number; pool_acc: string }>())
          .map(r => ({ ...r, asset_id: assetId }))
        await fillMissingLiquidityAmounts(rows)
        const a = asset(assetId)
        const seen = new Set<string>()
        const out: ActivityRow[] = []
        const createCands: { row: ActivityRow; pool: string; assetB: number }[] = []
        for (const r of rows) {
          const key = `${r.block_height}:${r.event_index}`
          if (seen.has(key)) continue
          seen.add(key)
          const row: ActivityRow = {
            type: 'liquidity', blockHeight: r.block_height, timestamp: r.ts, eventIndex: r.event_index, extrinsicIndex: r.extrinsic_index,
            who: r.who ? accountRef(r.who) : null, to: null, asset: a, assetIn: null, assetOut: null,
            ...liquidityRowAmount(r.event_name, prices, a.assetId, r.amount, a.decimals), amountIn: null, amountOut: null,
            liqAction: liqActionFor(r.event_name),
            linkBlock: r.block_height, linkIndex: r.extrinsic_index,
          }
          // Enrich only from the assetA side — this builder pins asset_id to the
          // page's asset, so on the assetB page both legs would collapse into B.
          if (r.event_name === 'XYK.PoolCreated' && r.asset_b !== assetId) createCands.push({ row, pool: r.pool_acc, assetB: r.asset_b })
          out.push(row)
        }
        await enrichPoolCreations(createCands)
        await applyHistoricalUsd(out, activityHistPick)
        return out
      }
      if (fixedAssetFilters.min != null) {
        return fetchFilteredDeep(tw, want, fetchPage,
          row => activityRowMatchesFilters(row, fixedAssetFilters),
          row => row.blockHeight, row => row.eventIndex ?? -1,
          row => `${row.blockHeight}:${row.eventIndex}`)
      }
      return fetchPage(bound, fetchN)
    })() : Promise.resolve([])

    // XCM outbound: transfers whose recovered substrate currencyId matches the asset.
    // Start from the asset's matching withdrawals, then decode the same-extrinsic
    // outbound event (either shape) so low-volume assets page through their full
    // XCM history. An extrinsic emitting both events joins twice but collapses in
    // the block:ext:amount:sender dedup below.
    const xcmP: Promise<ActivityRow[]> = wantXcm ? (async () => {
      const cidExpr = 'w.asset_id'
      const withdrawalAmountExpr = 'w.amount'
      const xcmValueFilter = eventValueFilterSql('{assetId:UInt32}', withdrawalAmountExpr, 'w.block_timestamp', fixedAssetFilters, prices, 'asset_xcm_price')
      const res = await client.query({
        query: `
          SELECT w.block_height, toString(w.block_timestamp) AS ts, w.extrinsic_index,
            x.event_index, x.args_json AS x_args, ${withdrawalAmountExpr} AS amount
          FROM ${xcmEventActivityTable('w')}
          INNER JOIN ${xcmEventActivityTable('x')}
            ON x.block_height = w.block_height
           AND x.extrinsic_index = w.extrinsic_index
           AND x.event_name IN (${XCM_SENT_EVENTS_SQL})
          ${xcmValueFilter.joinSql}
          WHERE ${tw ? tw.replaceAll('block_timestamp', 'w.block_timestamp') : '1'}
            AND w.event_name = 'Currencies.Withdrawn'
            AND ${cidExpr} = {assetId:UInt32}
            AND position(x.args_json, concat('"value":"', ${withdrawalAmountExpr}, '"')) > 0
            ${xcmValueFilter.predicateSql}
          ORDER BY w.block_height DESC, x.event_index DESC
          LIMIT {n:UInt32}`,
        query_params: { n: fetchN, assetId }, format: 'JSONEachRow',
      })
      const rows = await res.json<{ block_height: number; ts: string; extrinsic_index: number | null; event_index: number; x_args: string; amount: string }>()
      const a = asset(assetId)
      const seen = new Set<string>()
      const out: ActivityRow[] = []
      for (const r of rows) {
        const parsed = parseOutboundXcm(safeJson(r.x_args))
        if (!parsed || !parsed.amounts.includes(r.amount)) continue
        const key = `${r.block_height}:${r.extrinsic_index}:${r.amount}:${parsed.sender}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({
          type: 'xcm', blockHeight: r.block_height, timestamp: r.ts, eventIndex: r.event_index, extrinsicIndex: r.extrinsic_index,
          who: accountRef(parsed.sender), to: null, asset: a, assetIn: null, assetOut: null,
          amount: r.amount, amountIn: null, amountOut: null, valueUsd: usdValue(prices, a.assetId, r.amount, a.decimals),
          xcmDir: 'out', ...parsed.dest, linkBlock: r.block_height, linkIndex: r.extrinsic_index,
        })
      }
      return out
    })() : Promise.resolve([])

    // XCM inbound: hook-context deposits of this asset seed the candidate blocks;
    // the barrier walk-back keeps only genuine inbound-message credits.
    const xcmInP: Promise<ActivityRow[]> = wantXcm ? (async () => {
      const depositAmountExpr = 'amount'
      const xcmInValueFilter = eventValueFilterSql('{assetId:UInt32}', depositAmountExpr, 'block_timestamp', fixedAssetFilters, prices, 'asset_xcm_in_price')
      return fetchDecodedXcmDeep(
        bound,
        fetchN,
        async (pageBound, pageLimit) => {
          const res = await client.query({
            query: `SELECT DISTINCT block_height FROM ${xcmEventActivityTable()}
                    ${xcmInValueFilter.joinSql}
                    WHERE ${pageBound}
                      AND event_name IN ('Currencies.Deposited','Tokens.Deposited') AND extrinsic_index IS NULL
                      AND asset_id = {assetId:UInt32}
                      AND NOT match(who, '${RESERVED_ACCOUNT_RE.source}')
                      ${xcmInValueFilter.predicateSql}
                    ORDER BY block_height DESC LIMIT {n:UInt32}`,
            query_params: { n: pageLimit, assetId }, format: 'JSONEachRow',
          })
          return res.json<{ block_height: number }>()
        },
        async blocks => (await xcmInRowsForBlocks(blocks, prices)).filter(row => row.asset?.assetId === assetId),
        row => activityRowMatchesFilters(row, fixedAssetFilters),
        `asset-xcmin:${assetId}:${filterKey(fixedAssetFilters)}`,
      )
    })() : Promise.resolve([])

    // Remote-origin messages can withdraw assets from Basilisk without a local
    // extrinsic. Include the same decoded rows used by global, block and account
    // activity so an economic action does not disappear on the asset surface.
    const xcmOutRemoteP: Promise<ActivityRow[]> = wantXcm
      ? getRecentXcmOutRemote(fetchN, from, to, undefined, 0, { ...fixedAssetFilters, token: String(assetId) })
        .then(rows => rows.filter(row => row.asset?.assetId === assetId))
      : Promise.resolve([])

    // Executor-dispatched sends of this asset — the bridge legs that leave with no
    // PolkadotXcm.Sent/XTokens event at all, so no other arm on this surface can see them.
    const xcmExecutedP: Promise<ActivityRow[]> = wantXcm
      ? getRecentXcmExecuted(fetchN, from, to, undefined, 0, { ...fixedAssetFilters, token: String(assetId) })
        .then(rows => rows.filter(row => row.asset?.assetId === assetId))
      : Promise.resolve([])

    // Votes reach an asset feed only for BSX (`wantVotes` requires assetId 0),
    // which is what governance capital is denominated in. Both vote sources join
    // it, through the same builder every other feed uses, so the BSX page and the
    // chain-wide vote tab classify a collective vote identically.
    const votesP: Promise<ActivityRow[]> = wantVotes
      ? getVoteFeedRows(fetchN, from, to, 0, queryFilters, collectiveVotesAdmitted(queryFilters)).then(rows => rows.map(voteActivityRow))
      : Promise.resolve([])

    const [transfers, trades, liquidity, xcm, xcmIn, xcmOutRemote, xcmExecuted, votes] = await Promise.all([transfersP, tradesP, liquidityP, xcmP, xcmInP, xcmOutRemoteP, xcmExecutedP, votesP])
    // Drop transfer legs of the asset's own trades (hops/fee legs share the extrinsic).
    const tradeExtrinsics = new Set(trades.filter(t => t.extrinsicIndex != null).map(t => `${t.blockHeight}:${t.extrinsicIndex}`))
    const userTransfers = transfers.filter(t =>
      !(t.extrinsicIndex != null && tradeExtrinsics.has(`${t.blockHeight}:${t.extrinsicIndex}`)))
    const userTrades = dropShareRoutedTrades(trades, activityExtrinsicSet(liquidity))
    let rows = await suppressActivityPlumbing([...userTransfers, ...userTrades, ...liquidity, ...votes, ...xcm, ...xcmIn, ...xcmOutRemote, ...xcmExecuted])
    if (type !== 'all') rows = rows.filter(r => activityTypeMatchesFamily(r.type, type))
    rows = rows.filter(r => activityRowMatchesAction(r, action))
    // The token key is meaningless here (the asset IS fixed); min applies the
    // same way the account/global feeds filter by row value.
    if (filters.min != null && filters.unit !== 'token') await applyHistoricalUsd(rows, activityHistPick)
    rows = rows.filter(r => activityRowMatchesFilters(r, { ...filters, token: undefined }))
    rows.sort(compareActivityRowsNewestFirst)
    const saturationSources = type === 'all' ? [transfers, trades, liquidity, votes, xcm, xcmIn, xcmOutRemote, xcmExecuted]
      : type === 'transfer' ? [transfers]
        : type === 'trade' ? [trades]
          : type === 'liquidity' ? [liquidity]
            : type === 'xcm' ? [xcm, xcmIn, xcmOutRemote, xcmExecuted]
              : [votes]
    if (rows.length < want && saturationSources.some(source => source.length >= fetchN)) throw activityQueryTooBroad()
    return rows.slice(offset, offset + limit)
  })
}

// Account balance + portfolio history. Balances and prices are bucketed by the
// same block-range buckets (≈180 across the indexed window) so the portfolio is
// valued with period prices, and each asset gets a downsampled balance series.
export interface AssetBalancePoint { ts: string; blockHeight: number; balance: number }
export interface AssetBalanceHistory { asset: AssetRef; current: number; points: AssetBalancePoint[]; availableFrom?: string }

interface HistoryBalanceRow { account_id: string; asset_id: string; b: number; bal: string }
export interface ScaledBalanceBucket { b: number; value: string }

// TS mirror of the `least(intDiv(block_height - minb, bucketSize), lastBucket)`
// bucket expression every history query shares. The clamp puts the whole ragged
// tail above minb + lastBucket·bucketSize into the last bucket.
export function bucketOfHeight(height: number, minBlock: number, bucketSize: number, lastBucket: number): number {
  return Math.min(Math.floor((height - minBlock) / bucketSize), lastBucket)
}

// The one height whose timestamp is each bucket's end: the last height the bucket
// covers, plus maxBlock for the clamped tail bucket. Heights past maxBlock are
// dropped so a bucket the account's range never reaches stays absent — exactly as
// it was under a `block_height BETWEEN minBlock AND maxBlock` scan.
export function bucketEndHeightsForRange(minBlock: number, maxBlock: number, bucketSize: number, lastBucket: number): number[] {
  return [...new Set(
    Array.from({ length: lastBucket }, (_, b) => minBlock + (b + 1) * bucketSize - 1)
      .concat(maxBlock)
      .filter(height => height >= minBlock && height <= maxBlock))]
}

// MM positions are re-snapshotted periodically by the raw indexer (every N
// blocks, every borrower — not just on the borrower's own MM events), so the
// stored net is dense and the series forward-fills only across a short gap before
// the caller pins the final point to the live net worth.
async function getAccountHistory(accounts: string[]): Promise<{ portfolioSeries: number[]; portfolioDates: string[]; portfolioBlocks: number[]; balanceHistory: AssetBalanceHistory[] }> {
  const list = sqlAccountList(accounts)
  if (list === "''") return { portfolioSeries: [], portfolioDates: [], portfolioBlocks: [], balanceHistory: [] }
  // Single ordinary accounts are already selective in the account-first exact
  // history and avoid the merge overhead of the hourly model. Multi-member tags
  // and dense structural accounts are the shapes for which hourly compaction is
  // materially smaller.
  const useAccountBalanceHourly =
    (accounts.length > 4 || accounts.some(account => /^0x(6d6f646c|7369626c|70617261)/.test(account)))
  const prices = await ensurePrices()
  const rangeRes = await client.query({
    query: useAccountBalanceHourly
      ? `SELECT minMerge(first_block_state) AS minb, maxMerge(last_block_state) AS maxb,
          toUnixTimestamp(minMerge(first_timestamp_state)) AS mint,
          toUnixTimestamp(maxMerge(last_timestamp_state)) AS maxt
        FROM price_data.account_balance_hourly WHERE account_id IN (${list})`
      : `SELECT min(block_height) AS minb, max(block_height) AS maxb,
          toUnixTimestamp(min(block_timestamp)) AS mint, toUnixTimestamp(max(block_timestamp)) AS maxt
        FROM price_data.account_balance_history
        WHERE account_id IN (${list})`,
    format: 'JSONEachRow',
  })
  const rng = (await rangeRes.json<{ minb: number; maxb: number; mint: number; maxt: number }>())[0]
  if (!rng || !rng.maxb || rng.maxb <= rng.minb) return { portfolioSeries: [], portfolioDates: [], portfolioBlocks: [], balanceHistory: [] }
  const N = 180
  const BUCKET = Math.max(1, Math.floor((rng.maxb - rng.minb) / N))
  // Real end-of-bucket timestamps from the blocks table. Block time changed from
  // 12s to 6s over the chain's life, so interpolating between the range endpoints
  // mislabels mid-range buckets by months (block 7.19M: real 2025-03, interpolated
  // 2024-09) — wrong hover dates and wrong perf windows. Interpolation remains
  // only as the fallback for buckets with no indexed block.
  //
  // Read just the one height that decides each bucket rather than the account's
  // whole block range: block_timestamp is monotone in block_height and `blocks` is
  // complete (uniqExact(block_height) = max - min + 1), so a bucket's max timestamp
  // is the timestamp AT its last height and every boundary height exists. 181 point
  // lookups touch 180 marks / 11.8 MiB where the range GROUP BY touched 1,526 marks
  // / 96.4 MiB, and this runs once per account history, per sparkline and per tag
  // chart — enough executions to make the range scan one of the API's largest reads.
  const bucketEndHeights = bucketEndHeightsForRange(rng.minb, rng.maxb, BUCKET, N)
  const tsRes = await client.query({
    query: `SELECT toUInt32(least(intDiv(block_height - ${rng.minb}, ${BUCKET}), ${N})) AS b, toString(max(block_timestamp)) AS ts
            FROM price_data.blocks WHERE block_height IN (${bucketEndHeights.join(',')})
            GROUP BY b`,
    format: 'JSONEachRow',
  })
  const tsByBucket = new Map<number, string>()
  for (const r of await tsRes.json<{ b: number; ts: string }>()) tsByBucket.set(r.b, r.ts)
  // On a complete `blocks` every requested height resolves, so a gap means the table
  // has holes and the interpolated fallback is about to relabel buckets by months.
  // Say so rather than letting a plausible date hide a broken source table.
  const wantedBuckets = new Set(bucketEndHeights.map(height => bucketOfHeight(height, rng.minb, BUCKET, N)))
  if (tsByBucket.size < wantedBuckets.size) {
    console.error(`[Explorer] account history: ${wantedBuckets.size - tsByBucket.size}/${wantedBuckets.size} bucket-end heights missing from price_data.blocks over ${rng.minb}-${rng.maxb}; those dates fall back to interpolation`)
  }
  const tsInterpolated = (b: number) => { const frac = N > 0 ? b / N : 0; const sec = rng.mint + frac * (rng.maxt - rng.mint); return new Date(sec * 1000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '') }
  const tsAt = (b: number) => tsByBucket.get(b) ?? tsInterpolated(b)

  // An hourly close is sufficient unless a dynamic block bucket boundary splits
  // that hour. Fetch the exact block span of only those boundary hours; the
  // balance query below unions their raw observations with hourly closes, so the
  // winner of every original block bucket remains bit-for-bit identical.
  let boundaryBalancePredicate = '0'
  if (useAccountBalanceHourly) {
    const boundaryHeights = Array.from({ length: N }, (_, i) => rng.minb + (i + 1) * BUCKET)
      .filter(height => height <= rng.maxb)
    if (boundaryHeights.length) {
      const boundaryRes = await client.query({
        query: `WITH boundary_hours AS (
            SELECT DISTINCT toStartOfHour(block_timestamp) AS hour FROM price_data.blocks
            WHERE block_height IN (${boundaryHeights.join(',')})
          )
          SELECT min(block_height) AS first,max(block_height) AS last
          FROM price_data.blocks WHERE toStartOfHour(block_timestamp) IN boundary_hours
          GROUP BY toStartOfHour(block_timestamp) ORDER BY first`,
        format: 'JSONEachRow',
      })
      const ranges = await boundaryRes.json<{ first: number; last: number }>()
      if (ranges.length) boundaryBalancePredicate = ranges
        .map(range => `(block_height>=${range.first} AND block_height<=${range.last})`)
        .join(' OR ')
    }
  }

  // Bucket per (account, asset): for a multi-account tag each account's balance
  // must be forward-filled INDEPENDENTLY and only THEN summed per bucket. A single
  // argMax(total) across the whole account list would pick just one account's
  // total per bucket (the one observed latest in that bucket) and drop the others,
  // making the combined series sawtooth as the "winning" account flips bucket to
  // bucket. (For the single-account case this collapses to the original behaviour.)
  const balRes = await client.query({
    query: useAccountBalanceHourly
      ? `SELECT account_id, asset_id,
          toUInt32(least(intDiv(candidate_block - ${rng.minb}, ${BUCKET}), ${N})) AS b,
          toString(argMax(balance, candidate_block)) AS bal
        FROM (
          SELECT account_id, asset_id, interval_start,
            argMaxMerge(balance_state) AS balance,
            argMaxMerge(block_state) AS candidate_block
          FROM price_data.account_balance_hourly
          WHERE account_id IN (${list})
          GROUP BY account_id, asset_id, interval_start
          UNION ALL
          SELECT account_id,asset_id,toDateTime(0) AS interval_start,
            toString(argMax(toUInt256OrZero(total),tuple(block_height,observation_id,ingested_at))) AS balance,
            argMax(block_height,tuple(block_height,observation_id,ingested_at)) AS candidate_block
          FROM price_data.account_balance_history
          WHERE account_id IN (${list}) AND (${boundaryBalancePredicate})
          GROUP BY account_id,asset_id,
            toUInt32(least(intDiv(block_height - ${rng.minb}, ${BUCKET}), ${N}))
        )
        GROUP BY account_id, asset_id, b ORDER BY asset_id, account_id, b`
      : `SELECT account_id, asset_id, toUInt32(least(intDiv(block_height - ${rng.minb}, ${BUCKET}), ${N})) AS b,
          toString(argMax(toUInt256OrZero(total), tuple(block_height, observation_id, ingested_at))) AS bal
        FROM price_data.account_balance_history
        WHERE account_id IN (${list})
        GROUP BY account_id, asset_id, b ORDER BY asset_id, account_id, b`,
    format: 'JSONEachRow',
  })
  // Each asset keeps its own series: nothing folds one asset's balance into
  // another's (see explorerAssets), so the id the query returns is the id charted.
  const balRows: HistoryBalanceRow[] = await balRes.json<{ account_id: string; asset_id: string; b: number; bal: string }>()
  const assetIds = [...new Set(balRows.map(r => r.asset_id))]
  if (!assetIds.length) return { portfolioSeries: [], portfolioDates: [], portfolioBlocks: [], balanceHistory: [] }
  // Historical XYK LP principal (direct wallet shareToken balances + farm
  // deposits) valued at pool NAV. Loaded before the price query so both pool assets are priced.
  const xykHist = await loadXykPrincipalHistory(accounts, assetIds.map(Number), rng.minb, BUCKET, N)
  // Asset ids arrive as strings from two sources — the balance rows and the price
  // query's `toString(asset_id)` — so normalise both sides through one map rather
  // than trusting the two text forms to be byte-identical.
  const priceIdFor = new Map(assetIds.map(id => [id, String(Number(id))]))
  const lpPriceIds: string[] = []
  const xykPriceIds = xykHist ? xykHist.underlyingAssetIds.map(id => String(id)) : []
  const priceIds = [...new Set([...priceIdFor.values(), ...lpPriceIds, ...xykPriceIds])]
  // The daily close states are a replay-safe compact projection of prices. The
  // raw table contains a row for every asset at every indexed block; grouping it
  // here used to read hundreds of millions of rows for a single account/tag
  // history.  Use only candles which have fully closed by the bucket timestamp,
  // so a chart point can never see a future price.  This differs by at most one
  // UTC day from the latest raw observation and retains historical (never current)
  // valuation for every bucket.
  const pxRes = await client.query({
    query: `SELECT toString(asset_id) AS asset_id, toString(interval_start) AS ts,
              toFloat64(argMaxMerge(close_state)) AS px
            FROM price_data.ohlc_1d
            WHERE asset_id IN (${priceIds.join(',')})
              AND interval_start >= toStartOfDay({priceStart:DateTime})
              AND interval_start <= toStartOfDay({priceEnd:DateTime})
            GROUP BY asset_id, interval_start ORDER BY asset_id, interval_start`,
    query_params: { priceStart: tsAt(0), priceEnd: tsAt(N) },
    format: 'JSONEachRow',
  })
  const pxRows = await pxRes.json<{ asset_id: string; ts: string; px: number }>()
  const pxByPriceId = new Map<string, Map<number, number>>()
  const dailyByPriceId = new Map<string, { closedAt: number; px: number }[]>()
  const utcMillis = (ts: string) => Date.parse(`${ts.replace(' ', 'T')}Z`)
  for (const r of pxRows) {
    if (!dailyByPriceId.has(r.asset_id)) dailyByPriceId.set(r.asset_id, [])
    dailyByPriceId.get(r.asset_id)!.push({ closedAt: utcMillis(r.ts) + 86_400_000, px: Number(r.px) })
  }
  for (const id of priceIds) {
    const candles = dailyByPriceId.get(id) ?? []
    const byBucket = new Map<number, number>()
    let cursor = 0
    let lastPrice: number | undefined
    for (let b = 0; b <= N; b++) {
      const bucketEnd = utcMillis(tsAt(b))
      while (cursor < candles.length && candles[cursor].closedAt <= bucketEnd) {
        lastPrice = candles[cursor].px
        cursor++
      }
      if (lastPrice != null && lastPrice > 0) byBucket.set(b, lastPrice)
    }
    pxByPriceId.set(id, byBucket)
  }
  // Key the per-bucket price series back by the id the balance rows carry.
  const pxByAsset = new Map<string, Map<number, number>>()
  for (const id of assetIds) pxByAsset.set(id, pxByPriceId.get(priceIdFor.get(id)!) ?? new Map())
  // The prices table doesn't reach as far back as the balance range (the feed
  // started after the account's first observation), so leading buckets have no
  // historical price. Back-fill from the earliest known historical price, then
  // carry it forward across interior gaps. Assets with no historical price stay
  // unvalued instead of borrowing a current price.
  const earliestPxByAsset = new Map<string, number>()
  for (const id of assetIds) {
    const m = pxByAsset.get(id)!
    let earliest = 0
    for (let b = 0; b <= N; b++) if (m.has(b)) { earliest = m.get(b)!; break }
    earliestPxByAsset.set(id, earliest)
  }
  // Per (asset, account) bucketed balances — forward-filled per account, summed
  // across accounts per bucket (see balRes comment).
  const balByAcctAsset = new Map<string, Map<string, Map<number, string>>>()
  for (const r of balRows) {
    if (!balByAcctAsset.has(r.asset_id)) balByAcctAsset.set(r.asset_id, new Map())
    const byAcct = balByAcctAsset.get(r.asset_id)!
    if (!byAcct.has(r.account_id)) byAcct.set(r.account_id, new Map())
    const m = byAcct.get(r.account_id)!
    // Two folded ids (a share token + its underlying) can land in the same bucket
    // for one account — sum rather than overwrite so neither balance is dropped.
    m.set(r.b, m.has(r.b) ? (BigInt(m.get(r.b)!) + BigInt(r.bal)).toString() : r.bal)
  }

  // Per asset: forward-fill each account's balance, sum across accounts per bucket,
  // value with the period (back-/forward-filled historical) price, add to portfolio.
  const portfolio = new Array(N + 1).fill(0)
  const balanceHistory: AssetBalanceHistory[] = []
  for (const id of assetIds) {
    const a = asset(id)
    const byAcct = balByAcctAsset.get(id) ?? new Map<string, Map<number, string>>()
    const pxMap = pxByAsset.get(id) ?? new Map<number, number>()
    const earliestPx = earliestPxByAsset.get(id) ?? 0
    // XYK LP token: its balance is decomposed to underlying NAV below, so it must not also
    // contribute a token price to portfolio value (no double count). Still charted for display.
    const suppressPortfolioValue = xykHist?.lpAssetIds.has(Number(id)) ?? false
    // Combined (summed) forward-filled balance per bucket, and a flag for whether
    // ANY account had an observation in that bucket (drives the downsampled points).
    const combined = new Array(N + 1).fill(0)
    const portfolioCombined = new Array(N + 1).fill(0)
    const observedBucket = new Array(N + 1).fill(false)
    for (const [accountId, balMap] of byAcct) {
      let lastBal = 0
      for (let b = 0; b <= N; b++) {
        if (balMap.has(b)) { lastBal = Number(balMap.get(b)) / 10 ** a.decimals; observedBucket[b] = true }
        combined[b] += lastBal
        // Supplied MM reserves are already present in the aggregate collateral
        // snapshots added below; these pseudo-accounts are display-history only.
        if (!accountId.includes('#mm:')) portfolioCombined[b] += lastBal
      }
    }
    let lastPx = earliestPx
    const points: AssetBalancePoint[] = []
    for (let b = 0; b <= N; b++) {
      if (pxMap.has(b)) lastPx = pxMap.get(b)!
      if (!suppressPortfolioValue) portfolio[b] += portfolioCombined[b] * (lastPx || 0)
      // Plot every observed bucket, plus the final bucket so the line is forward-
      // filled to "now" (the balance persists after its last change). This also
      // gives sparsely-observed assets a 2nd point, so they render a real line.
      if (observedBucket[b] || b === N) points.push({ ts: tsAt(b), blockHeight: rng.minb + b * BUCKET, balance: combined[b] })
    }
    // Collapse to one point per calendar day (keep the day's last observation),
    // matching the portfolio series' downsampleDaily so a short window (fewer days
    // than buckets) never plots multiple points on the same date.
    if (points.length) {
      const dailyPoints = downsampleDailyPoints(points)
      if (hasNonZeroVisibleBalance(dailyPoints)) balanceHistory.push({
        asset: a,
        current: combined[N],
        points: dailyPoints,
      })
    }
  }

  // XYK LP principal on the historical curve, valued at pool NAV: combine the account's
  // direct wallet shareToken balance and its farm-deposit principal per
  // bucket, decompose to underlying reserve legs (integer), value at the bucket's closed
  // price. Replaces the (null) direct-token contribution suppressed above — no double count.
  if (xykHist && xykHist.lpAssetIds.size) {
    const earliestPrice = (m: Map<number, number> | undefined) => { if (m) for (let b = 0; b <= N; b++) if (m.has(b)) return m.get(b)!; return 0 }
    for (const lp of xykHist.lpAssetIds) {
      const state = xykHist.stateByLp.get(lp)
      if (!state) continue
      const farm = xykHist.farmSharesByLp.get(lp) ?? new Array<bigint>(N + 1).fill(0n)
      // Direct wallet shares per bucket: forward-fill the raw shareToken balance across the
      // account's own (non-MM-pseudo) balance series, summed.
      const directRaw = new Array<bigint>(N + 1).fill(0n)
      for (const [accountId, balMap] of balByAcctAsset.get(String(lp)) ?? new Map<string, Map<number, string>>()) {
        if (accountId.includes('#mm:')) continue
        let last = 0n
        for (let b = 0; b <= N; b++) { const v = balMap.get(b); if (v !== undefined) last = BigInt(v); directRaw[b] += last }
      }
      for (let b = 0; b <= N; b++) {
        const st = state[b]
        if (!st) continue
        const shares = directRaw[b] + farm[b]
        if (shares <= 0n) continue
        const { amountA, amountB } = xykShareLegs(shares, st.reserveA, st.reserveB, st.totalShares)
        const pxA = pxByPriceId.get(String(st.assetA))
        const pxB = pxByPriceId.get(String(st.assetB))
        const priceA = pxA?.get(b) ?? earliestPrice(pxA)
        const priceB = pxB?.get(b) ?? earliestPrice(pxB)
        portfolio[b] += (Number(amountA) / 10 ** asset(st.assetA).decimals) * priceA + (Number(amountB) / 10 ** asset(st.assetB).decimals) * priceB
      }
    }
  }

  // The portfolio curve is wallet balances + XYK LP principal; Basilisk has no
  // lending market to fold in on top of them.

  // Drop leading zero buckets, keep a clean series.
  let start = 0; while (start < portfolio.length - 1 && portfolio[start] === 0) start++
  const alignedBalanceHistory = alignBalanceHistoryDailyPoints(balanceHistory)
  alignedBalanceHistory.sort((x, y) => (y.current * (prices.get(y.asset.assetId)?.price ?? 0)) - (x.current * (prices.get(x.asset.assetId)?.price ?? 0)))
  const rawSeries = portfolio.slice(start).map(v => +v.toFixed(2))
  const rawDates = Array.from({ length: portfolio.length - start }, (_, k) => tsAt(start + k))
  // End-of-bucket block per point: bucket b covers [minb + b·BUCKET, minb + (b+1)·BUCKET)
  // (the final bucket absorbs the tail to maxb), so the events a point-to-point
  // delta reflects live in the half-open block span between the two end blocks.
  const rawBlocks = Array.from({ length: portfolio.length - start }, (_, k) => {
    const b = start + k
    return b >= N ? rng.maxb : rng.minb + (b + 1) * BUCKET - 1
  })
  // Collapse to one point per calendar day (keep the latest of each day) so the
  // chart never shows the same date on adjacent points when the window spans
  // fewer days than buckets. Long windows (≫70 days) are unaffected.
  const { series: portfolioSeries, dates: portfolioDates, blocks: portfolioBlocks } = downsampleDaily(rawSeries, rawDates, rawBlocks)
  // Return every asset that has a historical balance (sorted by current value),
  // not just the top N — the per-asset chip list should be complete.
  return { portfolioSeries, portfolioDates, portfolioBlocks, balanceHistory: alignedBalanceHistory }
}

// One point per calendar day (the last bucket of each day), preserving order.
function downsampleDaily(series: number[], dates: string[], blocks: number[]): { series: number[]; dates: string[]; blocks: number[] } {
  const outS: number[] = [], outD: string[] = [], outB: number[] = []
  for (let i = 0; i < series.length; i++) {
    const day = (dates[i] ?? '').slice(0, 10)
    if (outD.length && outD[outD.length - 1].slice(0, 10) === day) {
      outS[outS.length - 1] = series[i]; outD[outD.length - 1] = dates[i]; outB[outB.length - 1] = blocks[i]
    } else {
      outS.push(series[i]); outD.push(dates[i]); outB.push(blocks[i])
    }
  }
  return { series: outS, dates: outD, blocks: outB }
}

// One bucketed value-series reconstruction per scope (`addr:<id>` / `tag:<id>`),
// shared by the value-history chart, the value-event jump detection and the
// accounts-directory sparkline so the heavy per-asset walk runs once per consumer
// set rather than once per consumer. It is the instance's largest reader — the
// directory prewarm alone drives ~340 reconstructions per pass, and their whole
// query tree measured 49% of all ClickHouse CPU and 41% of its bytes over a clean
// 70-minute window — so how long one entry lives is what that cost is divided by.
//
// The key deliberately does NOT carry the account-value generation. The
// reconstruction never reads that generation: every bucket is valued at ohlc_1d
// candles that had already closed by the bucket's own timestamp (see
// getAccountHistory), never at the pinned current-price map, so a generation
// change cannot alter a single value here and using it as the invalidation
// dimension only threw the work away. What each consumer takes from the series is
// also insensitive to its age: getAddressHistory, getTag and enrichAccountSparklines
// all overwrite the final point with the row's own authoritative current value, and
// getAccountValueEvents skips the last delta for exactly that reason. So nothing
// served is ever a mix of two generations — the live point belongs to the caller's
// generation and the buckets behind it belong to no generation at all.
//
// Half an hour is then bounded by what is left: the interior buckets. They are
// weekly on the sparkline's grid and (max-min)/180 blocks — days, for any account
// the directory ranks — on the detail chart, and only blocks older than the last
// bucket boundary are affected at all, since everything newer collapses into the
// pinned final bucket.
const ACCOUNT_HISTORY_TTL_MS = 30 * 60_000

// The account set is part of the key, not just the scope: the directory sparkline
// covers a row's members without their module/sovereign forms while the detail page
// covers every related account, and the two must never be served each other's series.
function accountSetFingerprint(accounts: string[]): string {
  return createHash('sha1').update([...accounts].map(a => a.toLowerCase()).sort().join(',')).digest('hex').slice(0, 12)
}

function getAccountHistoryShared(accounts: string[], scopeKey: string): Promise<Awaited<ReturnType<typeof getAccountHistory>>> {
  const key = `explorer:account-history:${scopeKey}:${accountSetFingerprint(accounts)}`
  return cached(key, ACCOUNT_HISTORY_TTL_MS, () => getAccountHistory(accounts))
}

// Per-asset analogue of downsampleDaily: one balance point per calendar day (the
// day's last observation), preserving order, so the per-asset balance chart matches
// the portfolio series' one-point-per-day cadence.
function downsampleDailyPoints(points: AssetBalancePoint[]): AssetBalancePoint[] {
  const out: AssetBalancePoint[] = []
  for (const p of points) {
    const day = p.ts.slice(0, 10)
    if (out.length && out[out.length - 1].ts.slice(0, 10) === day) out[out.length - 1] = p
    else out.push(p)
  }
  return out
}

export function hasNonZeroVisibleBalance(points: AssetBalancePoint[]): boolean {
  return points.some(p => Number.isFinite(p.balance) && p.balance > 0)
}

export function alignBalanceHistoryDailyPoints(history: AssetBalanceHistory[]): AssetBalanceHistory[] {
  const visible = history.filter(h => hasNonZeroVisibleBalance(h.points))
  if (!visible.length) return []

  const axisByDay = new Map<string, AssetBalancePoint>()
  for (const h of visible) {
    for (const p of h.points) {
      const day = p.ts.slice(0, 10)
      const existing = axisByDay.get(day)
      if (!existing || p.ts > existing.ts) axisByDay.set(day, p)
    }
  }

  const axis = [...axisByDay.values()].sort((a, b) => a.ts.localeCompare(b.ts))
  let start = 0
  while (
    start < axis.length - 1 &&
    !visible.some(h => h.points.some(p => p.ts.slice(0, 10) === axis[start].ts.slice(0, 10) && Number.isFinite(p.balance) && p.balance > 0))
  ) {
    start++
  }
  const trimmedAxis = axis.slice(start)

  return visible.map(h => {
    const byDay = new Map<string, AssetBalancePoint>()
    for (const p of h.points) byDay.set(p.ts.slice(0, 10), p)

    let lastBalance = 0
    const points = trimmedAxis.map(axisPoint => {
      const p = byDay.get(axisPoint.ts.slice(0, 10))
      if (p) lastBalance = p.balance
      return {
        ts: axisPoint.ts,
        blockHeight: axisPoint.blockHeight,
        balance: lastBalance,
      }
    })

    return { ...h, points }
  }).filter(h => hasNonZeroVisibleBalance(h.points))
}

// ─── Locating a page inside a feed too large to assemble ──────────────────────
//
// The candidate window below answers "the newest N rows of each source", which is
// what stops an account with a million activities from ever being paged to its end:
// its total says "exact for the prefix I cover" and the pages stop at that prefix.
// This path answers the question directly instead — SQL COUNTS the feed and LOCATES
// the blocks a page's ranks sit in, and the classifier then runs over just those
// blocks, with no per-source limit to saturate.
//
// It is sound because every cross-source decision the feed makes is block-local (the
// same property the frontier relies on — see activityWindowFrontier). A block covered
// by every source therefore classifies exactly as it would with the whole history in
// hand, the feed's row count is a sum over blocks, and a page is a slice inside the
// ≤ `limit` blocks holding its ranks. Because `above` counts WHOLE BLOCKS, SQL and
// the classifier never have to agree on the order WITHIN a block — only on how many
// rows each block holds.
//
// Two kinds of source feed it, and which kind a source is decides whether its
// classification has to be re-expressed in SQL at all:
//
//   * ENUMERATED — a source whose entire per-account history fits under
//     EXACT_SMALL_SOURCE_ROWS is read in full by its own normal builder. Its
//     per-block counts are then the classified rows themselves, so there is no SQL
//     mirror to drift: the staking hierarchy folding, the OTC signer resolution, the
//     incentive-claim call confirmation and the DCA failure legs all stay exact
//     without being restated. A source that does NOT fit refuses the exact path
//     rather than guessing.
//
//   * COUNTED — a source running to hundreds of thousands of rows per account gets a
//     SQL expression for its per-block row count. Only four do, and each one's rule
//     is a row-per-source-row or a row-per-extrinsic rule SQL can state exactly. The
//     runtime metadata two of them need (pool-share asset ids, the configured
//     money-market pools) is interpolated from the live registry on every request
//     rather than baked into a column, so a newly registered share token or reserve
//     changes the answer immediately instead of silently going stale.
//
// The two halves are reconciled per block before a page is served: SQL's count for
// each located block must equal the number of rows the classifier built in it. That
// compares row identities per block rather than one grand total, which is the only
// kind of check that can see a read returning the right NUMBER of wrong rows.

// How many rows one source may hold for an account before this path stops claiming it
// can enumerate it. Every enumerated source is read in full for every count and every
// page, so this is what bounds that cost. The largest per-account histories in the
// enumerated sources are far below it (staking 192k rows in total across all
// accounts, votes 121k, OTC 4.5k, referral claims 10k, incentive claims 51k), so in
// practice the cap only ever refuses a genuinely new shape.
const EXACT_SMALL_SOURCE_ROWS = 20_000
// XCM gets its own, higher cap. Its three legs are the one family whose classification
// genuinely cannot be restated in SQL — the outbound row set is the multilocation
// payload's asset legs matched against the block's withdrawals, and the inbound one is
// a backwards walk through a block's deposit events from the MessageQueue barrier —
// so enumerating is not a shortcut here, it is the only way to be exact. The busiest
// XCM account holds 59,392 rows (98,124 inbound deposit events and 42,310 outbound
// anchors) and reads in ~4.7s; the cap sits above it and refuses anything larger rather
// than letting one account's page block on an unbounded walk.
const EXACT_XCM_SOURCE_ROWS = 80_000
// Long enough that clicking through pages does not re-read the enumerated sources each
// time, short enough that a feed's head is never minutes behind. Safe to hold because
// the same cached rows feed the count and the page (see enumeratedActivityRows).
const ENUMERATED_SOURCE_CACHE_MS = 60_000
// How long a snapshot may still be SERVED after it stops being fresh. Past the fresh
// window a reader gets the previous snapshot immediately while the refresh runs behind it
// (cachedSwr), so the multi-second read is paid once per window by a background pass
// rather than once per visit by whoever arrives first. Measured on the account that holds
// the most cross-chain history, that read is 6.2s of an 8.6s cold page.
//
// Set to the stale bound the list total on the same page already publishes
// (LIST_TOTAL_STALE_MS — asserted equal by test, since that constant is declared further
// down and cannot be referenced here). The pager's total and the rows under it may not
// disagree about how old the feed is allowed to be, and a snapshot is a COMPLETE feed of
// a slightly earlier chain state rather than a prefix of the current one, so serving one
// costs recency at the head and nothing else.
const ENUMERATED_SOURCE_STALE_MS = 900_000
// How many bytes of interpolated account literals an arm may carry (see the budget
// note where it is enforced).
const MAX_EXACT_ACCOUNT_LIST_BYTES = 150_000
// The per-source row ceiling on a located page. The closed block set already bounds
// every read; this is only the backstop that keeps a pathological block from being
// unbounded, and the per-block reconciliation refuses the page if it ever binds.
const MAX_LOCATED_BLOCK_SOURCE_ROWS = 500_000
// How many candidate transfer events the transfer arm will take on. Its subordination
// and dust tests are hash sets over the account's OWN history, so the cost is that
// history's size: the busiest trader's 3.0M candidates count in 3.0s, while the
// structural pots (routerex 22.1M, treasury 13.4M, referrals 14.5M, Omnipool 45.8M)
// exceed the query memory ceiling. They are recognised here, from a sort-key-prefix
// count that costs ~0.2s, rather than by spending 16s to fail — the arm would fall back
// to the window either way, and this way the fallback is not preceded by a wasted pass.
const MAX_EXACT_TRANSFER_CANDIDATES = 6_000_000

// The asset ids `isShareAssetId` recognises, as a SQL list. Pool-share membership is
// runtime asset-registry state that ClickHouse does not hold, which is precisely why
// it is interpolated per request: a `kind` column baked at ingest could not learn
// that a newly registered share token now routes its trade legs to liquidity.
function shareAssetIdsSql(): string {
  const ids = new Set<number>()
  for (const registered of allExplorerAssets()) if (isShareAssetId(registered.assetId)) ids.add(registered.assetId)
  // A share token can be traded before its registry row is loaded, and an empty IN
  // list would silently widen the arm rather than narrow it.
  return ids.size ? [...ids].join(',') : '0'
}

// One block of the feed and how many rows it holds. Arms are UNIONed and summed per
// block, so a source contributes rows to a block without knowing about the others.
type ActivityCountArm = string

// ── Filters inside an arm ─────────────────────────────────────────────────────
//
// An arm's row count is only exact under a filter if it selects EXACTLY the rows the
// classifier keeps, so every predicate below is the SQL mirror of the TypeScript one
// applied to the built row — `activityRowMatchesFilters` for the token and
// `activityRowMatchesAction` for the action — expressed over the columns that row's
// fields were built from. Mirroring the SOURCE column instead of the RENDERED field is
// how a count starts numbering pages of rows the feed does not hold: the money-market
// filter below matches on the asset the row displays rather than on the reserve address
// the request's token maps to, because an aToken and its underlying share the reserve
// and only one of them is the row's asset.
//
// A filter belongs on the CANDIDATE side only. The transfer arm's suppression sets
// (semanticExtrinsicSql, hookOwnerSql) are classification CONTEXT, not rows: narrowing
// them would let a trade the filter excludes stop owning its transfer legs, and those
// legs would surface as transfers of their own. The page pass makes the same split —
// under an exact plan its context reads run unfiltered and the predicate is applied to
// the assembled rows — so the two halves select one set.
//
// `undefined` = no token requested; an empty list = a token no asset in the registry
// answers to, which matches nothing rather than everything.
function armTokenFilter(tokenIds: number[] | undefined, predicate: (ids: string) => string): string {
  if (tokenIds == null) return ''
  if (!tokenIds.length) return 'AND 0'
  return `AND ${predicate(tokenIds.join(','))}`
}

// A source the request's filters exclude entirely. It still has to BE an arm, because
// the arms are UNIONed into one per-block sum and dropping one silently would make the
// plan's shape depend on the filter rather than on the type.
function emptyActivityCountArm(): ActivityCountArm {
  return `SELECT toUInt32(0) AS block_height, toUInt64(0) AS rows WHERE 0`
}

// What collects an account's swap events before their routes are split out. An
// extrinsic's own events are considered together, because a route's hops and the
// summary closing them are one trade; a hook-dispatched swap has no extrinsic, so its
// own event is its identity — three Treasury swaps have shared a block, and collecting
// them all under a null extrinsic would render one and count one. Extrinsic indices
// are non-negative, so the negative space cannot collide with them.
const SWAP_GROUP_KEY_SQL = 'ifNull(toInt64(extrinsic_index), -toInt64(event_index) - 1)'

// The account's signed swaps, counted the way the builder groups them: one trade row
// per ROUTE, minus the two extrinsics the classifier hands to another category. A
// liquidation's internal collateral→debt swap belongs to its mm row, and a share-asset
// leg routed through a pool inside an add/remove belongs to the liquidity row — the
// second needs the representative row's assets.
//
// Counting per extrinsic instead undercounted every batch that dispatched more than one
// route: an arbitrage bot whose every trade is a batch_all of two Router sells reported
// 953 trades, complete, against 1,784 real routes — and the page it sized rendered only
// the closing leg of each loop.
//
// The routes are derived from the collected events exactly as `swapRouteReps` derives
// them: a net summary closes the run of hops before it and represents that route, and a
// trailing run with no summary is one more route represented by its highest event. So
// the count and the page cannot disagree about how many trades an extrinsic held.
//
// The token filter reads the SAME representative the page renders, so a multi-hop route
// is matched on its NET assets in both halves and an intermediate asset the user never
// named does not pull the route in on one side only.
function accountSwapTradeArm(list: string, bound: string, tokenIds?: number[]): ActivityCountArm {
  const tokenFilter = armTokenFilter(tokenIds, ids => `(rep_in IN (${ids}) OR rep_out IN (${ids}))`)
  return `SELECT block_height, count() AS rows FROM (
      SELECT block_height, ext_index, route.1 AS rep_in, route.2 AS rep_out
      FROM (
        SELECT block_height, ext_index, evs, nets,
               -- Events past the last summary have nothing to close them: one further
               -- route, represented by its highest event (the builder's leading row).
               arrayFilter(x -> length(nets) = 0 OR x.1 > nets[-1].1, evs) AS tail,
               arrayMap(x -> tuple(x.3, x.4), nets) AS net_routes,
               if(empty(tail), net_routes, arrayPushBack(net_routes, tuple(tail[-1].3, tail[-1].4))) AS routes
        FROM (
          SELECT block_height,
                 -- Null for a hook swap, which owns no extrinsic; the share-leg
                 -- exclusion below is extrinsic-scoped and skips it for free, since a
                 -- tuple holding NULL matches nothing on either side.
                 any(extrinsic_index) AS ext_index,
                 arraySort(x -> x.1, groupArray(tuple(event_index, event_name IN (${ROUTER_NET_EVENTS_SQL}), asset_in, asset_out))) AS evs,
                 arrayFilter(x -> x.2, evs) AS nets
          FROM price_data.account_swap_activity FINAL
          WHERE ${bound} AND account IN (${list})
          GROUP BY block_height, ${SWAP_GROUP_KEY_SQL}
        )
      )
      ARRAY JOIN routes AS route
    )
    WHERE 1 ${tokenFilter}
      AND NOT ((rep_in IN (${shareAssetIdsSql()}) OR rep_out IN (${shareAssetIdsSql()}))
        AND (block_height, ext_index) IN (
          SELECT block_height, extrinsic_index FROM price_data.liquidity_activity
          WHERE ${bound} AND who IN (${list}) AND event_name IN (${sqlEventNameList(LIQUIDITY_EVENTS)})
            AND extrinsic_index IS NOT NULL))
    GROUP BY block_height`
}

// A pool account never appears as `who` on its own lifecycle events — the creator
// does — so matching only `who` leaves every XYK pair account's Liquidity tab
// empty. `who` and `pool_account` are never equal (verified across all
// XYK.PoolCreated rows), so the OR cannot double-emit. The `pool_account` arm is
// itself confined to POOL_LIFECYCLE_EVENTS regardless of the caller's own event
// list: a viewed account should only ever be admitted through `pool_account` for
// pool creation/destruction, never for an ordinary LP's add/remove on that pool,
// even if a future runtime upgrade started populating `pool_account` more widely.
// Shared verbatim by every liquidity_activity read that needs this admission test
// — accountLiquidityArm, semanticExtrinsicSql, and the liquidity page read in
// collectAccountActivity — so the three cannot drift into classifying differently.
function liquidityWhoOrPoolSql(list: string): string {
  return `(who IN (${list}) OR (pool_account IN (${list}) AND event_name IN (${sqlEventNameList([...POOL_LIFECYCLE_EVENTS])})))`
}

// Liquidity provision/removal/mining claims: one row per source row, exactly the
// event list the page read uses, narrowed to the events whose action label the request
// asked for.
//
// `asset_refs` is the canonical multi-asset match: it holds every asset the event
// references — the Stableswap pool's nested assets, both sides of an XYK pair — and
// always contains the representative `asset_id` the row displays (verified: no row in
// liquidity_activity has an asset_id outside its own asset_refs), so this is exactly
// the `[row.asset, …row.assetRefs]` test the classifier applies.
//
// Both the count arm and the page read carry the same liquidityWhoOrPoolSql
// predicate: if they diverge the tab counts rows it will not render, which is the
// exact failure the liquidityActionEventNames comment warns of.
function accountLiquidityArm(list: string, bound: string, eventNames: readonly string[], tokenIds?: number[]): ActivityCountArm {
  if (!eventNames.length) return emptyActivityCountArm()
  const tokenFilter = armTokenFilter(tokenIds, ids => `hasAny(asset_refs, [${ids}])`)
  return `SELECT block_height, count() AS rows FROM price_data.liquidity_activity
    WHERE ${bound} AND ${liquidityWhoOrPoolSql(list)}
      AND event_name IN (${sqlEventNameList([...eventNames])})
      ${tokenFilter}
    GROUP BY block_height`
}

// ── The transfer family ───────────────────────────────────────────────────────
//
// Transfers are the one family whose row set depends on the OTHER families, because
// suppressSubordinateActivityRows only ever removes transfer rows: a transfer that is
// the plumbing of a higher-level action is owned by that action and never rendered on
// its own. So this arm is the classifier's whole transfer chain restated once —
// candidate dedup, pot/pool/money-market/sibling filters, the treasury
// donation-versus-fee call test, subordination to a semantic sibling, and the dust
// cleanup pair — and nothing else in the feed needs restating for it.
//
// Every decision below is either a predicate on the candidate row, a set membership
// the page read already computes with the same SQL, or a bound array of the
// enumerated sources' own identities. There is no place left where a "usually"
// applies; where a rule cannot be stated the type keeps its window instead.
//
// Each source arm carries `${bound}` so a from/to request prunes partitions. The two
// subqueries WITHOUT one are driven by a primary-key predicate instead — the money-market
// extrinsic lookup in semanticExtrinsicSql and the treasury call test both restrict
// raw_events/raw_extrinsics to blocks the bounded candidate set already named — so a
// timestamp filter there would be redundant, not missing.

// The equivalence between an account's forms, as SQL. suppressSubordinateActivityRows
// and the dust match compare `accountRef(x).accountId`, which folds a truncated-H160
// id back to the substrate account it stands for — a mapping that lives in the
// runtime's EVM bindings, tags and reserved-address rules, not in ClickHouse. Only the
// REQUEST's own accounts can ever be on both sides of those comparisons (every
// non-transfer source is already filtered to them), so folding exactly those forms is
// exact, and any other id compares as itself just as `accountRef` leaves it.
function resolvedAccountIdSql(column: string, accounts: string[]): string {
  const forms = [...new Set(accounts.map(a => a.toLowerCase()))]
  const resolved = forms.map(form => accountRef(form).accountId.toLowerCase())
  if (!forms.length) return `lower(${column})`
  return `transform(lower(${column}), [${forms.map(f => `'${f}'`).join(',')}], [${resolved.map(r => `'${r}'`).join(',')}], lower(${column}))`
}

// Which counterparties make a transfer plumbing rather than the account's own
// activity, over the transfer read model's columns. Every exclusion has the same
// shape — a leg whose other side is protocol machinery is that machinery's, UNLESS the
// viewed account IS that machinery, in which case those legs are the only activity it
// has. Shared by the page read and the count arm so the two cannot select differently.
async function transferCandidatePotFiltersSql(accCond: string[]): Promise<string> {
  const parts: string[] = []
  if (!accCond.some(a => NOISY_TRANSFER_POTS.includes(a))) {
    parts.push(`AND from_account NOT IN (${noisyPotList()}) AND to_account NOT IN (${noisyPotList()})`)
  }
  // Sibling/relay/parachain sovereign accounts are the XCM feed's counterparties; a
  // transfer leg against one is that message, not a transfer.
  parts.push(`AND NOT match(from_account, '^0x(7369626c|70617261|506172656e74)')`)
  parts.push(`AND NOT match(to_account, '^0x(7369626c|70617261|506172656e74)')`)
  const poolAccs = ammPoolAccounts()
  if (poolAccs.size && !accCond.some(a => poolAccs.has(a))) {
    const list = [...poolAccs].map(a => `'${a}'`).join(',')
    parts.push(`AND from_account NOT IN (${list}) AND to_account NOT IN (${list})`)
  }
  return parts.join('\n                ')
}

// Whether this account's transfer history is larger than the arm will take on.
// `account` is the read model's sort-key prefix, so this is a marks read.
async function transferCandidatesExceedExactBudget(accCond: string[]): Promise<boolean> {
  const res = await client.query({
    query: `SELECT count() AS c FROM price_data.account_transfer_activity
            WHERE account IN (${accCond.map(a => `'${a}'`).join(',')})`,
    format: 'JSONEachRow',
  })
  return Number((await res.json<{ c: string }>())[0]?.c ?? 0) > MAX_EXACT_TRANSFER_CANDIDATES
}

// The candidate transfer events of an account, deduplicated exactly as
// dedupeTransferEvents does it: one identity is (block, extrinsic, asset, from, to,
// amount), and the pallet that reports it most specifically wins
// (Currencies.Transferred over Tokens.Transfer over Balances.Transfer). Rows that tie
// on priority all survive, which is why this is a window maximum and not an argMax.
// The read model holds one row per (account, block, event), so the account set can
// report the same event twice — DISTINCT collapses that and the ReplacingMergeTree's
// unmerged replays in one step.
//
// A token filter belongs INSIDE the candidate read: `asset_id` is the transfer row's
// displayed asset and the dedup window already partitions by it, so selecting one
// asset's candidates first cannot change which of them wins its priority tie.
function transferCandidateSql(accList: string, bound: string, potFilters: string, tokenFilter: string): string {
  return `SELECT block_height, event_index, xi, from_account, to_account, asset_id, amount
    FROM (
      SELECT *, max(prio) OVER (PARTITION BY block_height, xi, asset_id, lower(from_account), lower(to_account), amount) AS top_prio
      FROM (
        SELECT block_height, event_index, ifNull(extrinsic_index, 4294967295) AS xi,
               from_account, to_account, asset_id, amount,
               multiIf(event_name = 'Currencies.Transferred', 3, event_name = 'Tokens.Transfer', 2, 1) AS prio
        FROM (
          SELECT DISTINCT block_height, event_index, extrinsic_index, event_name, from_account, to_account, amount, asset_id
          FROM price_data.account_transfer_activity
          WHERE ${bound} AND account IN (${accList})
            AND (from_account IN (${accList}) OR to_account IN (${accList}))
            ${potFilters}
            ${tokenFilter}
        )
      )
    ) WHERE prio = top_prio`
}

// Every (block, extrinsic) the feed gives to a NON-transfer row, so a transfer sharing
// it is that row's plumbing. Three sources state it in SQL; the enumerated sources
// hand theirs over as a bound array.
//
// The swap and liquidity arms are deliberately the SOURCE sets rather than the row
// sets: a liquidation's internal swap and a share-routed pool leg produce no trade row
// yet still own their extrinsic's transfer legs, which is exactly the distinction the
// builder draws with `tradeExt` before it drops those rows.
function semanticExtrinsicSql(list: string, bound: string, enumeratedExtrinsics: [number, number][]): string {
  const arms = [
    `SELECT block_height, assumeNotNull(extrinsic_index) AS extrinsic_index FROM price_data.account_swap_activity FINAL
       WHERE ${bound} AND account IN (${list}) AND extrinsic_index IS NOT NULL`,
    `SELECT block_height, assumeNotNull(extrinsic_index) AS extrinsic_index FROM price_data.liquidity_activity
       WHERE ${bound} AND ${liquidityWhoOrPoolSql(list)} AND event_name IN (${sqlEventNameList(LIQUIDITY_EVENTS)})
         AND extrinsic_index IS NOT NULL`,
  ]
  if (enumeratedExtrinsics.length) {
    arms.push(`SELECT tupleElement(pair, 1) AS block_height, tupleElement(pair, 2) AS extrinsic_index
       FROM (SELECT arrayJoin(${sortedBlockPairsSql(enumeratedExtrinsics)}) AS pair)`)
  }
  return arms.join('\n      UNION DISTINCT\n      ')
}

// (block, owner) for every non-transfer row the feed places in a block WITHOUT an
// extrinsic. A hook transfer has no extrinsic to be owned by, so it is subordinate to
// a hook sibling that names the same account — a block-and-account rule, never a
// block-only one, so an unrelated transfer in a busy block is not swallowed.
function hookOwnerSql(list: string, accounts: string[], bound: string, enumeratedOwners: [number, string][]): string {
  const who = (column: string) => resolvedAccountIdSql(column, accounts)
  const arms = [
    // Bare `who IN (${list})` here, not liquidityWhoOrPoolSql's who-OR-pool_account —
    // safe only because this arm is confined to extrinsic_index IS NULL and no
    // lifecycle row has one: no XYK.PoolCreated/PoolDestroyed row carries a null
    // extrinsic_index. If a hook-dispatched pool destruction ever produces one it
    // would own no hook sibling here, so its withdrawal legs would surface on the
    // pool's page as raw transfers instead of folding behind the liquidity row.
    `SELECT block_height, ${who('who')} AS owner FROM price_data.liquidity_activity
       WHERE ${bound} AND who IN (${list}) AND event_name IN (${sqlEventNameList(LIQUIDITY_EVENTS)})
         AND extrinsic_index IS NULL`,
  ]
  if (enumeratedOwners.length) {
    // Owners are account ids, so they are interned: an inbound-XCM-heavy account has
    // tens of thousands of hook rows but a handful of distinct owners, and repeating the
    // 66-character id per row is what pushed this payload over a megabyte.
    const dictionary = [...new Set(enumeratedOwners.map(([, owner]) => owner))]
    const index = new Map(dictionary.map((owner, at) => [owner, at + 1]))
    const pairs = enumeratedOwners.map(([block, owner]) => [block, index.get(owner) as number] as [number, number])
    arms.push(`SELECT tupleElement(pair, 1) AS block_height,
              arrayElement([${dictionary.map(owner => `'${owner}'`).join(',')}], tupleElement(pair, 2)) AS owner
       FROM (SELECT arrayJoin(${sortedBlockPairsSql(pairs)}) AS pair)`)
  }
  return arms.join('\n      UNION DISTINCT\n      ')
}

// One transfer row per surviving candidate, per block. `tokenFilter` narrows the
// CANDIDATES only — `sem_ext` and `hook_owner` stay whole, because a trade the filter
// excludes still owns its transfer legs and a narrowed context would republish them.
function accountTransferArm(args: {
  accounts: string[]
  accList: string
  list: string
  bound: string
  potFilters: string
  tokenFilter: string
  viewingTreasury: boolean
  enumeratedExtrinsics: [number, number][]
  enumeratedOwners: [number, string][]
}): ActivityCountArm {
  const { accounts, accList, list, bound, potFilters, tokenFilter, viewingTreasury } = args
  // A transfer INTO the treasury pot is a fee or a deposit unless the extrinsic that
  // emitted it is itself a token-transfer call — only then is it a donation the account
  // made. Bounded to the candidates' own blocks so the 32.3M-row extrinsic table is
  // read by primary key rather than scanned for a call name.
  const treasuryFilter = viewingTreasury ? '' : `
    AND NOT (to_account = '${TREASURY_POT}' AND (block_height, xi) NOT IN (
      SELECT block_height, ifNull(extrinsic_index, 4294967295) FROM price_data.raw_extrinsics
      WHERE block_height IN (SELECT block_height FROM cand WHERE to_account = '${TREASURY_POT}')
        AND call_name IN (${sqlEventNameList([...TRANSFER_CALL_NAMES])})))`
  return `SELECT block_height, count() AS rows FROM (
      WITH cand AS (${transferCandidateSql(accList, bound, potFilters, tokenFilter)}),
           sem_ext AS (${semanticExtrinsicSql(list, bound, args.enumeratedExtrinsics)}),
           hook_owner AS (${hookOwnerSql(list, accounts, bound, args.enumeratedOwners)})
      SELECT block_height FROM cand
      WHERE (xi = 4294967295 OR (block_height, xi) NOT IN (SELECT block_height, extrinsic_index FROM sem_ext))
        AND (xi != 4294967295 OR (
          (block_height, ${resolvedAccountIdSql('from_account', accounts)}) NOT IN (SELECT block_height, owner FROM hook_owner)
          AND (block_height, ${resolvedAccountIdSql('to_account', accounts)}) NOT IN (SELECT block_height, owner FROM hook_owner)))
        ${treasuryFilter}
        AND (block_height, event_index + 1, ${resolvedAccountIdSql('from_account', accounts)}, asset_id, amount) NOT IN (
          -- Read whole and without FINAL: this is the right side of a NOT IN, which is
          -- set-semantic, so an unmerged replacement duplicate cannot change the answer.
          SELECT block_height, event_index, who, asset_id, amount FROM price_data.dust_lost_events)
    )
    GROUP BY block_height`
}

// The enumerated sources travel in the query TEXT, not as bound parameters. The client
// sends query_params in the request URI, and one heavy-XCM account's 59k per-block
// counts overran the server's URI limit ("HTTP request URI invalid or too long") long
// before they would trouble max_query_size — which applies to the body ClickHouse reads
// as a stream, and is a setting this path raises deliberately.
//
// Blocks are delta-encoded against their sorted order so the digits stay small: a feed
// dense in blocks pays ~4 bytes a block instead of ~9. arrayCumSum puts them back.
function sortedBlockPairsSql(pairs: [number, number][]): string {
  const sorted = [...pairs].sort((a, b) => a[0] - b[0])
  const deltas: number[] = []
  let previous = 0
  for (const [block] of sorted) { deltas.push(block - previous); previous = block }
  return `arrayZip(arrayCumSum([${deltas.join(',')}]), [${sorted.map(([, v]) => v).join(',')}])`
}

function enumeratedArm(pairs: [number, number][]): ActivityCountArm {
  if (!pairs.length) return emptyActivityCountArm()
  return `SELECT tupleElement(pair, 1) AS block_height, toUInt64(tupleElement(pair, 2)) AS rows
    FROM (SELECT arrayJoin(${sortedBlockPairsSql(pairs)}) AS pair)`
}

// Where a page's ranks live: the blocks holding them, how many rows the feed holds in
// strictly newer blocks (`above`), and the feed's exact total.
interface ExactActivityLocation {
  total: number
  blocks: number[]
  perBlock: Map<number, number>
  above: number
}

// Everything needed to count and locate one (account set, type, filters) feed.
interface ExactActivityPlan {
  arms: ActivityCountArm[]
  // Handed to the page pass so it renders the same enumerated rows the total counted,
  // rather than reading them a second time at a different depth.
  enumerated: EnumeratedActivity
}

function perBlockSql(plan: ExactActivityPlan): string {
  return `WITH per_block AS (
    SELECT block_height, sum(rows) AS rows
    FROM (${plan.arms.join('\n    UNION ALL\n    ')})
    GROUP BY block_height)`
}

// The interpolated enumerated data can reach a few hundred KB on the account with the
// most cross-chain history, well past the 256 KiB default. Raised only for these two
// queries, which is where the literals live.
const EXACT_ACTIVITY_QUERY_SETTINGS = { max_query_size: '33554432' }

async function countExactActivity(plan: ExactActivityPlan): Promise<number> {
  const res = await client.query({
    query: `${perBlockSql(plan)} SELECT toString(sum(rows)) AS total FROM per_block`,
    clickhouse_settings: EXACT_ACTIVITY_QUERY_SETTINGS, format: 'JSONEachRow',
  })
  return Number((await res.json<{ total: string }>())[0]?.total ?? 0)
}

// The blocks holding ranks [offset, offset+limit). `cum` is the feed's running row
// count newest-block-first, so a block overlaps the requested ranks exactly when it
// ends after the first one and starts before the last. `sum(rows) OVER ()` takes the
// total from the same single pass — a scalar subquery over `per_block` made
// ClickHouse compute the whole aggregation twice (1.9s -> 0.5s on the deepest page of
// the largest account).
async function locateExactActivity(plan: ExactActivityPlan, offset: number, limit: number): Promise<ExactActivityLocation> {
  const res = await client.query({
    query: `${perBlockSql(plan)},
      ranked AS (
        SELECT block_height, rows,
               sum(rows) OVER (ORDER BY block_height DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum,
               sum(rows) OVER () AS total
        FROM per_block)
      SELECT block_height, toUInt32(rows) AS block_rows, toString(cum) AS cum_rows, toString(total) AS total_rows
      FROM ranked
      WHERE cum > {off:UInt64} AND cum - rows < {off:UInt64} + {lim:UInt64}
      ORDER BY block_height DESC`,
    query_params: { off: offset, lim: limit },
    clickhouse_settings: EXACT_ACTIVITY_QUERY_SETTINGS, format: 'JSONEachRow',
  })
  const rows = await res.json<{ block_height: number; block_rows: number; cum_rows: string; total_rows: string }>()
  // No block overlaps the requested ranks: the offset is past the end of the feed.
  // The total still has to be reported, so take it from its own pass.
  if (!rows.length) return { total: await countExactActivity(plan), blocks: [], perBlock: new Map(), above: 0 }
  return {
    total: Number(rows[0].total_rows),
    blocks: rows.map(r => r.block_height),
    perBlock: new Map(rows.map(r => [r.block_height, r.block_rows])),
    above: Number(rows[0].cum_rows) - rows[0].block_rows,
  }
}

// The classified rows the classifier is asked to reconcile against, and the blocks it
// may read. `perBlock` is the contract: every located block must come back holding
// exactly this many rows.
interface ExactActivityBound {
  blocks: number[]
  perBlock: Map<number, number>
  enumerated: EnumeratedActivity
}

// A vote as the activity feed renders it. Shared so the enumerating pass and the
// classifier's own pass cannot describe the same vote differently.
function voteActivityRow(v: VoteRow): ActivityRow {
  return {
    type: 'vote', blockHeight: v.blockHeight, timestamp: v.timestamp, eventIndex: v.eventIndex, extrinsicIndex: v.extrinsicIndex,
    who: v.account, to: null, asset: v.asset, assetIn: null, assetOut: null, amount: v.amount, amountIn: null, amountOut: null, valueUsd: v.valueUsd,
    votePallet: v.pallet, voteAction: v.action, voteRef: v.referendum, voteSide: v.side, voteConviction: v.conviction,
    ...referendumRefFields(v.pallet, v.referendum),
    linkBlock: v.blockHeight, linkIndex: v.extrinsicIndex,
  }
}

// The enumerated sources' whole per-account contribution, or null when one of them
// holds more rows than this path is willing to read in full.
//
// Each source is asked for its cap + 1 rows, so coming back short IS the proof that the
// read reached the end of that source — nothing has to be counted separately to
// establish it. The builders are the same ones the page pass calls with the same
// arguments, so their classification is never restated here; the per-block
// reconciliation would catch it if the two call sites ever drifted.
//
// Kept per source rather than flattened, because the page pass takes its enumerated
// rows from HERE instead of reading them again: the same array supplies the per-block
// counts the total is built from and the rows the page renders, so the two cannot be
// different sets — and each source still lands in the slot the classifier expects
// (referral claims and incentive claims both render under other families' types, so a
// flat list could not tell them from the liquidity and mm reads).
interface EnumeratedActivity {
  votes: ActivityRow[]
  xcm: ActivityRow[]
}

// Every enumerated row. All of them are non-transfer, so a transfer feed needs each
// one's extrinsic or hook owner to decide which transfers are its plumbing.
function enumeratedActivityAll(e: EnumeratedActivity): ActivityRow[] {
  return [...e.votes, ...e.xcm]
}

// Which enumerated sources one type's feed needs. Exactly the `want*` flags
// collectAccountActivity derives, so the two passes read the same sources for the same
// type. A transfer feed pulls all of them, because every one of them can own a transfer
// leg.
//
// The builders below take NO type argument, so the rows depend on which sources are read
// and not on which type asked for them: `all` and `transfer` both need all six and
// therefore produce the same array, as do `liquidity` and `mm` with their one. That is
// why the cache key names the SOURCE SET rather than the type — two types that read the
// same history share one entry instead of reading it twice under two names.
const ENUMERATED_SOURCE_NAMES = ['votes', 'xcm'] as const
type EnumeratedSourceName = typeof ENUMERATED_SOURCE_NAMES[number]
function enumeratedSourceNeed(type: string): Record<EnumeratedSourceName, boolean> {
  const wantTransfers = type === 'all' || type === 'transfer'
  return {
    votes: type === 'all' || type === 'vote' || wantTransfers,
    xcm: type === 'all' || type === 'xcm' || wantTransfers,
  }
}

// Deliberately keyed on the source set, the account set and the date bound ALONE. These
// rows are read UNFILTERED (see below), so an action or a token cannot change them — and
// keying on the filter would only split the cache and read the same history again for
// every chip the user tries.
//
// One key, one snapshot: the reader and the background pass that refreshes it both build
// it here, so the pass cannot warm an entry nothing reads.
export function enumeratedActivityKey(accounts: string[], type: string, from?: string, to?: string): string {
  const need = enumeratedSourceNeed(type)
  const sources = ENUMERATED_SOURCE_NAMES.filter(name => need[name]).join('+')
  return `explorer:exact-small:${sources}:${[...accounts].sort().join(',')}:${from ?? ''}:${to ?? ''}`
}

async function enumeratedActivityRows(
  accounts: string[],
  type: string,
  from?: string,
  to?: string,
): Promise<EnumeratedActivity | null> {
  // A count and every page of it want the same whole-history read, and the sources are
  // read in full whether or not the account has rows in them — the OTC read alone costs
  // ~300ms for an account with no OTC at all (Placed/Cancelled ownership is a signer
  // scan) and the three XCM legs cost ~6.2s on the account that holds the most of them.
  // Hold the assembled rows for a window so a page burst pays for them once, and serve
  // the previous snapshot while a lapsed one is re-read so no reader waits on it twice.
  //
  // Staleness here is consistency-safe rather than merely tolerable: one awaited snapshot
  // supplies BOTH the per-block counts the locate query is built from and the rows the
  // page renders, so the two always describe the same set however old it is. It costs
  // freshness at the head, which is what every cached total on this page already costs.
  return cachedSwr(enumeratedActivityKey(accounts, type, from, to),
    ENUMERATED_SOURCE_CACHE_MS, ENUMERATED_SOURCE_STALE_MS,
    () => enumeratedActivityRowsUncached(accounts, type, from, to))
}

// Re-read the snapshot 92% of activity requests share — the unfiltered, undated
// `all`/`transfer` source set — and install it under the key those requests read.
//
// `cacheRefresh` rather than a bare call or `enumeratedActivityRows`: a pass that OWNS a
// key must never be satisfied by the value it exists to replace, and it must still share
// the reader's single flight so a prewarm and a reader's own revalidation collapse into
// one computation instead of racing.
function refreshEnumeratedActivitySnapshot(accounts: string[]): Promise<EnumeratedActivity | null> {
  return cacheRefresh(enumeratedActivityKey(accounts, 'all'),
    ENUMERATED_SOURCE_CACHE_MS, ENUMERATED_SOURCE_STALE_MS,
    () => enumeratedActivityRowsUncached(accounts, 'all'))
}

// Every enumerated source, read with NO action and NO token filter.
//
// That is not an oversight, it is the requirement. These rows play two parts at once:
// they are the counted rows of their own families AND the suppression context that
// decides which transfer legs the feed hides. An OTC fill filtered away by token still
// owns its settlement legs, and a staking claim filtered away by action still owns its
// payout leg — narrow the read and those legs reappear as transfers of their own. So
// the read stays whole and BOTH consumers apply the predicate to the assembled rows:
// planExactActivity when it counts them per block, collectAccountActivity when it
// filters the merged feed. Under an exact plan the page even renders literally this
// array, so the two cannot describe different sets.
async function enumeratedActivityRowsUncached(
  accounts: string[],
  type: string,
  from?: string,
  to?: string,
): Promise<EnumeratedActivity | null> {
  const depth = EXACT_SMALL_SOURCE_ROWS + 1
  const xcmDepth = EXACT_XCM_SOURCE_ROWS + 1
  const need = enumeratedSourceNeed(type)
  const [voteLegs, xcmLegs] = await Promise.all([
    // Two vote sources, each read to its own cap and landing in the one `votes`
    // slot the classifier expects: the indexed conviction/Democracy rows, and the
    // collective (Council / Technical Committee) votes out of raw_events. The
    // collective read is keyed on the real VOTER account — account_activity_v3
    // indexes a 32-byte proposal hash as if it were an account, so an arm built on
    // that index would hand a hash-shaped "account" its own votes.
    need.votes ? Promise.all([
      getRecentVotes(depth, from, to, 0, {}, accounts, {}).then(rows => rows.map(voteActivityRow)),
      getCollectiveVotes(accounts, depth, from, to).then(rows => rows.map(voteActivityRow)),
    ]) : [],
    // The four XCM legs each have their own limit, so saturation is per leg: the
    // concatenation reaching a cap says nothing about whether one leg was exhausted.
    need.xcm ? Promise.all([
      getRecentXcm(xcmDepth, from, to, accounts, 0, {}),
      getRecentXcmIn(xcmDepth, from, to, accounts, 0, {}),
      getRecentXcmOutRemote(xcmDepth, from, to, accounts, 0, {}),
      getRecentXcmExecuted(xcmDepth, from, to, accounts, 0, {}),
    ]) : [],
  ])
  const capped: [ActivityRow[], number][] = [
    ...voteLegs.map(leg => [leg, depth] as [ActivityRow[], number]),
    ...xcmLegs.map(leg => [leg, xcmDepth] as [ActivityRow[], number]),
  ]
  if (capped.some(([rows, cap]) => rows.length >= cap)) return null
  return { votes: voteLegs.flat(), xcm: xcmLegs.flat() }
}

// Which types this path can count exactly, in the order the reasoning above splits
// them: `trade`, `liquidity` and `mm` mix a counted source with enumerated ones,
// while `vote`, `staking` and `otc` are enumerated end to end.
//
// `xcm` is enumerated end to end too, at its own higher cap; `transfer` is the one
// family whose arm has to state another family's decisions, because subordination only
// ever removes transfer rows; and `all` is simply every arm and every enumerated source
// at once, which is sound because the families are disjoint — a row belongs to exactly
// one of them.
const EXACTLY_COUNTABLE_ACTIVITY_TYPES = new Set([
  'all', 'transfer', 'trade', 'liquidity', 'mm', 'xcm', 'vote', 'staking', 'otc',
])

// Whether this request is paged by locating its ranks rather than by widening a
// candidate window — the same test planExactActivity applies, minus the per-account
// parts it can only answer with the account in hand. The route's offset bound depends
// on it: a located page costs what its FEED costs, not what its offset costs, so it is
// servable to the end of any total it publishes, while a windowed one is still bounded
// by the depth one candidate window reaches.
//
// The action is deliberately not a parameter: every action a category offers is
// mirrored by the arms, so it can no longer decide how a request is paged, and leaving
// it out is what keeps a caller from reintroducing that fallback. A min-USD floor still
// can, because no arm holds the row's event-time valuation (see planExactActivity).
export function isLocatedActivityRequest(type: string, filters: ValueListFilters = {}): boolean {
  if (!EXACTLY_COUNTABLE_ACTIVITY_TYPES.has(normalizeActivityTypeKey(type))) return false
  return filters.min == null
}

// A plan for counting and locating one feed, or null when the request's shape has no
// exact mirror. A refusal is not a failure: the caller falls back to the candidate
// window, which reports what it covers.
async function planExactActivity(
  accounts: string[],
  type: string,
  action: string | undefined,
  filters: ValueListFilters,
  from?: string,
  to?: string,
): Promise<ExactActivityPlan | null> {
  // A min-USD floor is the one filter with no exact mirror, and the obstacle is the
  // BASIS rather than the join: valuing 843k candidate rows at their event-time prices
  // costs +0.15s, but the amount to value is not in the read models for a large part of
  // the feed. 642,559 liquidity rows (12.8%, including every Omnipool.LiquidityRemoved
  // and XYK.LiquidityAdded) carry `amount = ''` and recover the displayed figure from a
  // stateful match against the paired pool↔who transfer leg (fillMissingLiquidityAmounts);
  // an XYK.PoolCreated row is the SUM of two legs, which activityHistPick deliberately
  // declines to value at all; and OTC and XCM legs take their amounts from outside their
  // own row. A SQL predicate over the stored column would therefore filter on a blank
  // for one row in eight and disagree with the page on exactly the rows the threshold is
  // meant to select. So a min request keeps the candidate window, which values the rows
  // it assembled and says how far it reached.
  // `identity` joins `min` as a filter with no exact SQL mirror: it is decided
  // on the built row's actor, so an exact count over the read models would
  // count rows the list then drops.
  if (!EXACTLY_COUNTABLE_ACTIVITY_TYPES.has(type) || filters.min != null || filters.identity) return null
  const tokenIds = assetIdsForToken(filters.token)
  const list = sqlAccountList(accounts)
  if (list === "''") return null
  // The counted arms interpolate the account list up to twice, and a tag's members are
  // 68 bytes each — the largest today is 729 accounts, so a big tag's arms already
  // carry ~100 KB of literals against ClickHouse's 256 KB query ceiling. Past this
  // budget the window answers instead of the request failing on query size.
  if (list.length * 2 > MAX_EXACT_ACCOUNT_LIST_BYTES) return null
  const enumerated = await enumeratedActivityRows(accounts, type, from, to)
  if (!enumerated) return null

  const bound = timeWindow(from, to) ?? '1'
  const wantTrades = type === 'all' || type === 'trade'
  const wantTransfers = type === 'all' || type === 'transfer'
  // Money-market rows are indexed under the account's truncated-H160 form. A module
  // account's rows are protocol internals the feed never shows, so one that only HAS a
  // module form contributes no mm rows — but its transfer legs are still owned by those
  // extrinsics, which is why the suppression side below keeps every form. The exclusion
  // is the builder's own `isModuleAcct(accountRef(account_id))`, applied to the same
  // account_id values the arm restricts to: a truncated `modl…` H160 resolves back to
  // its substrate module account, which a prefix test on the H160 would miss.

  const all = enumeratedActivityAll(enumerated)
  const perBlock = new Map<number, number>()
  for (const row of all) {
    // `all` asks for no family filter at all, exactly as the classifier's own
    // `type !== 'all'` guard does — otherwise every enumerated row would be counted out
    // of the merged feed and the total would fall short of the chips that make it up.
    if (type !== 'all' && !activityTypeMatchesFamily(row.type, type)) continue
    // The action and token tests are the classifier's OWN predicates over the SAME
    // array the page will render (see enumeratedActivityRowsUncached), so these
    // families need no SQL mirror at all and cannot be counted under a rule the page
    // then applies differently. `filters` can only carry a token here — a min floor
    // refused the plan above.
    if (!activityRowMatchesAction(row, action)) continue
    if (!activityRowMatchesFilters(row, filters)) continue
    perBlock.set(row.blockHeight, (perBlock.get(row.blockHeight) ?? 0) + 1)
  }

  // Which COUNTED arms an action admits. A trade action selects the swap arm
  // outright; liquidity instead narrows its event list, through the inverse of the
  // mapping that labels the row.
  const swapArmAction = !action || action === 'swap'
  const arms: ActivityCountArm[] = [enumeratedArm([...perBlock])]
  if (wantTrades) {
    arms.push(swapArmAction ? accountSwapTradeArm(list, bound, tokenIds) : emptyActivityCountArm())
  }
  // The action applies whatever the TYPE is. `type=all&action=swap` keeps only the
  // trade rows that are swaps, so the liquidity arm must select nothing for it — the
  // page's activityRowMatchesAction drops those rows, and an arm that ignored the
  // action because the type is not its own would count a feed the page never renders.
  if (type === 'all' || type === 'liquidity') {
    arms.push(accountLiquidityArm(list, bound, liquidityActionEventNames(action), tokenIds))
  }
  const accCond = [...new Set(accounts.map(a => a.toLowerCase()))].filter(a => ACCOUNT_RE.test(a))
  if (wantTransfers && accCond.length) {
    if (await transferCandidatesExceedExactBudget(accCond)) return null
    // A transfer feed needs the enumerated sources' suppression identities too. Only
    // their SIGNED rows contribute extrinsics and only their HOOK rows contribute owners,
    // which is exactly the split suppressSubordinateActivityRows makes.
    const signed = new Set(all.filter(row => row.extrinsicIndex != null)
      .map(row => `${row.blockHeight}:${row.extrinsicIndex}`))
    const owners = new Set(all.filter(row => row.extrinsicIndex == null && hookActivityOwnsBlockTransfers(row))
      .flatMap(row => [row.who?.accountId, row.to?.accountId]
        .filter((id): id is string => !!id)
        .map(id => `${row.blockHeight}:${id.toLowerCase()}`)))
    arms.push(accountTransferArm({
      accounts, accList: accCond.map(a => `'${a}'`).join(','), list, bound,
      potFilters: await transferCandidatePotFiltersSql(accCond),
      // A transfer carries no action of its own, so every action keeps every transfer —
      // exactly what activityRowMatchesAction's default arm says.
      tokenFilter: armTokenFilter(tokenIds, ids => `asset_id IN (${ids})`),
      viewingTreasury: accCond.includes(TREASURY_POT),
      enumeratedExtrinsics: [...signed].map(key => {
        const at = key.indexOf(':')
        return [Number(key.slice(0, at)), Number(key.slice(at + 1))] as [number, number]
      }),
      enumeratedOwners: [...owners].map(key => {
        const at = key.indexOf(':')
        return [Number(key.slice(0, at)), key.slice(at + 1)] as [number, string]
      }),
    }))
  }
  return { arms, enumerated }
}

// Which block's count SQL and the classifier disagree on, or null when they agree.
// Compared per block rather than in total: the failure this guards against — a read
// that returns the right number of rows for the wrong blocks — leaves the total
// intact, so nothing counting the whole page can see it.
export function exactActivityMismatch(
  builtBlocks: Iterable<number>,
  perBlock: Map<number, number>,
): string | null {
  const built = new Map<number, number>()
  for (const block of builtBlocks) built.set(block, (built.get(block) ?? 0) + 1)
  for (const [block, counted] of perBlock) {
    const actual = built.get(block) ?? 0
    if (actual !== counted) return `block ${block} counted ${counted}, built ${actual}`
  }
  for (const [block, actual] of built) {
    if (!perBlock.has(block)) return `block ${block} counted 0, built ${actual}`
  }
  return null
}

// Thrown, never swallowed: the count and the page disagree, so this request has no
// answer from the exact path and the caller re-reads it through the candidate window.
class ExactActivityDisagreement extends Error {}
function exactActivityDisagreement(detail: string): Error {
  return new ExactActivityDisagreement(detail)
}

// One assembled, classified and filtered account feed. `rows` is always an EXACT
// prefix of that feed — every row it holds above `frontierBlock` and nothing else —
// and `complete` (frontier absent) says that prefix is the whole history. So a total
// is exact whether or not it is complete, and every page the total numbers renders
// the rows the feed really holds there.
interface AccountActivityWindow { rows: ActivityRow[]; complete: boolean; frontierBlock: number | null }

// One source's contribution to the window's frontier: it read `fetched` candidates
// newest-first under `limit`, the oldest of them in block `oldestBlock`.
interface ActivitySourceWindow { fetched: number; limit: number; oldestBlock: number | null }

// The block below which the window stops being the feed. Every source is read
// newest-first under its own LIMIT, so a source that filled its window has
// complete coverage only down to the block its oldest candidate sits in; above
// max(that block) over the saturated sources, EVERY source returned every
// candidate it has.
//
// A block — not a (block, event) — boundary is what makes the rows above it
// classifiable: every cross-source decision the feed makes is block-local
// (transfer suppression and the liquidation/share-routed exclusions key on
// (block, extrinsic), dust pairing on the neighbouring event index, DCA leg
// matching and the XCM in-block walks on the block), so a block covered by every
// source classifies exactly as it would with the whole history in hand. An
// event-level boundary would leave a suppressing sibling one event too old to have
// been fetched, and the row it should have hidden would be counted and rendered.
//
// null = no source saturated: the window IS the account's whole feed.
export function activityWindowFrontier(sources: ActivitySourceWindow[]): number | null {
  let frontier: number | null = null
  for (const source of sources) {
    if (source.fetched < source.limit || source.oldestBlock == null) continue
    if (frontier == null || source.oldestBlock > frontier) frontier = source.oldestBlock
  }
  return frontier
}

// Drop what the window cannot account for. Rows below the frontier are missing
// their older siblings, so paging or counting them would publish a feed with
// gaps; above it the rows are the feed itself.
export function activityRowsAboveFrontier<T extends { blockHeight: number }>(rows: T[], frontierBlock: number | null): T[] {
  return frontierBlock == null ? rows : rows.filter(row => row.blockHeight > frontierBlock)
}

// A candidate window holds the newest N rows per source, so its frontier advances as
// blocks are indexed — roughly one block per block for a steady account, faster for
// one whose recent history is denser than its older history. A cached total counted
// right at the frontier would therefore number a last page that the window no longer
// reaches by the time it is fetched. So a PUBLISHED prefix stops a margin of blocks
// above the frontier: 3x the blocks the chain produces inside a partial total's
// stale bound, which costs well under a tenth of the counted prefix even on the
// busiest structural pot. Pages are not held back — the feed genuinely continues
// past a published prefix, which is what `complete: false` tells the page to say.
//
// The margin is a DURATION, so it is derived from the chain's pace rather than
// pinned as a block count: ~966 blocks at today's measured ~5.6s, ~2 700 after
// the planned 2s upgrade, where the old fixed 1 000 would have covered 11
// minutes instead of 90 and let the last page outrun its own total.
//
// This one takes the MEASURED pace, not the resolved slot time: how far the
// frontier runs while a total sits in cache is pure throughput — it is blocks
// the chain actually produced, not a duration a runtime constant encodes. The
// resulting few-percent wobble between polls is immaterial next to the frontier
// advancing under the same cached total, which is what `complete: false`
// already tells the page about.
const ACTIVITY_PARTIAL_TOTAL_STALE_MS = 30 * 60_000
export function activityFrontierMarginBlocks(paraBlockMs: number): number {
  return Math.max(1, Math.round((3 * ACTIVITY_PARTIAL_TOTAL_STALE_MS) / Math.max(1, paraBlockMs)))
}
export function publishedActivityFrontier(frontierBlock: number | null, marginBlocks: number): number | null {
  return frontierBlock == null ? null : frontierBlock + marginBlocks
}

function oldestWindowBlock<T>(rows: T[], blockOf: (row: T) => number): number | null {
  let oldest: number | null = null
  for (const row of rows) {
    const block = blockOf(row)
    if (!Number.isFinite(block)) continue
    if (oldest == null || block < oldest) oldest = block
  }
  return oldest
}

// Account-scoped activity: the account's own trades (summarized per extrinsic) +
// genuine transfers (from balance observations, excluding swap legs / pool
// counterparties). Used on the account & tag pages instead of raw per-asset
// balance-change rows.
//
// Returns the WHOLE classified feed above the window's frontier rather than a
// page: the page slice and the exact row total are both taken from this one
// result, so the number the pager sizes itself from is by construction the number
// of rows the feed renders.
//
// Given an `exact` bound it instead assembles precisely the located blocks: the
// per-source bound becomes a closed block set that no source can saturate, so the
// frontier is absent by construction and the result is the whole feed inside those
// blocks. It is the same assembly either way — one classifier, one set of
// suppression rules, for every surface.
async function collectAccountActivity(accounts: string[], type: string, catFetch: number, action?: string, filters: ValueListFilters = {}, from?: string, to?: string, exact?: ExactActivityBound): Promise<AccountActivityWindow> {
  type = normalizeActivityTypeKey(type)
  const tw = timeWindow(from, to)
  const bound = exact ? `block_height IN (${exact.blocks.join(',') || '0'})` : tw ?? '1'
  const list = sqlAccountList(accounts)
  if (list === "''") return { rows: [], complete: true, frontierBlock: null }
  const related = new Set(accounts.map(a => a.toLowerCase()))
  const prices = await ensurePrices()
  // Under an exact plan the token predicate is applied to the ASSEMBLED rows instead of
  // being pushed into each source read, and that is a correctness rule rather than a
  // preference. Every source below is also the classification CONTEXT the transfer feed
  // is suppressed against — a trade owns its swap legs, a liquidity add owns its pool
  // deposits, an OTC fill owns its settlement — so a source narrowed to the requested
  // token would stop owning the legs of everything it excluded, and those legs would
  // surface as transfers the count never counted. (That is what makes the windowed
  // path's `swapTokenFilter` wrong and why the located path does not inherit it.)
  //
  // It is also free of the usual hazard of filtering late: an exact bound is a CLOSED
  // BLOCK SET, not a recency window, so there is no LIMIT for the unfiltered rows to
  // crowd a rare match out of. The window path keeps its push-downs for exactly that
  // reason — there, filtering after the LIMIT is what loses older matches.
  const tokenIds = exact ? undefined : assetIdsForToken(filters.token)
  // Joining hourly prices below each source's LIMIT forces ClickHouse to value
  // the entire account history. Pull bounded account-first candidates first;
  // applyHistoricalUsd then records the same exact Decimal/BigInt value used by
  // activityRowMatchesFilters.
  const queryFilters = filters.min != null && filters.unit !== 'token'
    ? { ...filters, min: undefined, unit: undefined }
    : filters
  // Window saturation is recorded per source AT FETCH TIME, with the block its
  // oldest candidate sits in. A built array can be shorter than the window it came
  // from (a liquidation's internal swap is dropped, reward claims fold into other
  // categories) or longer (the three XCM legs are concatenated), so measuring the
  // built rows would either miss a filled window or invent one — and both the
  // frontier and an exact total stand or fall on knowing whether older candidates
  // remain.
  //
  // Every source read below is either a source of this type's rows or the
  // classification context they are suppressed against, so any of them filling its
  // window bounds how far the feed is known.
  const sourceWindows: ActivitySourceWindow[] = []
  const noteSource = (fetched: number, oldestBlock: number | null): void => {
    sourceWindows.push({ fetched, limit: catFetch, oldestBlock })
  }
  const wantTransfers = type === 'all' || type === 'transfer'
  // Classification context: Transfers excludes trade legs, Trades yields
  // share-routed legs to Liquidity — fetch what the exclusions need.
  const wantTrades = type === 'all' || type === 'trade' || wantTransfers
  const wantLiquidity = type === 'all' || type === 'liquidity' || wantTrades
  const wantXcm = type === 'all' || type === 'xcm' || wantTransfers
  const wantVotes = type === 'all' || type === 'vote' || wantTransfers
  // 1. The account's signed swaps. Signer scope and value predicates are joined
  // before LIMIT so a rare token/value match cannot sit beyond a signer window.
  // Extrinsics that actually emitted a swap — their transfer legs (hops/fee) are
  // swap noise and get dropped from the transfer feed. Built from the swap events
  // below, NOT from every signed extrinsic: a plain Balances.transfer_allow_death
  // signed by the account (incl. member→member within a tag) is a genuine transfer
  // and must NOT be filtered out.
  const tradeExt = new Set<string>()
  const trades: ActivityRow[] = []
  if (wantTrades || wantTransfers) {
    const swapTokenFilter = tokenIds == null ? '' : tokenIds.length
      ? `AND (asset_in IN (${tokenIds.join(',')}) OR asset_out IN (${tokenIds.join(',')}))`
      : 'AND 0'
    const swapAssetExpr = 'asset_out'
    const swapAmountExpr = 'amount_out'
    const swapTimeExpr = 'block_timestamp'
    const swapAmountFilter = eventValueFilterSql(swapAssetExpr, swapAmountExpr, swapTimeExpr, queryFilters, prices, 'account_trade_price')
    const swapRes = await client.query({
      query: `SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name,
          asset_in, asset_out, amount_in, amount_out, signer
          FROM price_data.account_swap_activity FINAL
          ${swapAmountFilter.joinSql}
          WHERE ${bound} AND account IN (${list})
          ${swapTokenFilter}
          ${swapAmountFilter.predicateSql}
          ORDER BY block_height DESC, ${SWAP_GROUP_KEY_SQL} DESC, event_name IN (${ROUTER_NET_EVENTS_SQL}) DESC, event_index DESC
          LIMIT {n:UInt32}`,
      query_params: { n: catFetch }, format: 'JSONEachRow',
    })
    const swapRows = await swapRes.json<{ block_height: number; ts: string; event_index: number; extrinsic_index: number | null; event_name: string; asset_in: number; asset_out: number; amount_in: string; amount_out: string; signer: string }>()
    noteSource(swapRows.length, oldestWindowBlock(swapRows, r => r.block_height))
    for (const rep of swapRouteReps(swapRows)) {
      // Mark the extrinsic as a swap (so its transfer legs are dropped as noise).
      // A hook swap has no extrinsic to own, and claiming `block:null` would
      // suppress the unrelated hook transfers that share the block.
      if (rep.extrinsic_index != null) tradeExt.add(`${rep.block_height}:${rep.extrinsic_index}`)
      if (!wantTrades) continue
      const who = rep.signer
      const aOut = asset(rep.asset_out)
      const row: ActivityRow = {
        type: 'trade', blockHeight: rep.block_height, timestamp: rep.ts, eventIndex: rep.event_index, extrinsicIndex: rep.extrinsic_index,
        who: who ? accountRef(who) : null, to: null, asset: null, assetIn: asset(rep.asset_in), assetOut: aOut,
        amount: null, amountIn: rep.amount_in, amountOut: rep.amount_out,
        valueUsd: usdValue(prices, aOut.assetId, rep.amount_out, aOut.decimals),
        linkBlock: rep.block_height, linkIndex: rep.extrinsic_index,
      }
      trades.push(row)
    }
  }

  // 2. Genuine user↔user transfers, queried directly from the transfer events
  // (account-keyed on `from`/`to`). Deriving these from raw_balance_observations
  // was wrong for active accounts: the observation feed is dominated by fee/swap
  // legs (transfers to/from `0x6d6f646c…` module accounts — treasury, routerex,
  // omnipool), so a recency LIMIT on it never reached the rare genuine transfers
  // on highly active accounts. Filtering pallet/pool/fee legs and trade legs in SQL,
  // keyed on the account, surfaces them regardless of how active the account is.
  // Balances.Transfer is the native asset (id 0); Tokens/Currencies carry currencyId.
  const transfers: ActivityRow[] = []
  const accCond = [...related].filter(a => ACCOUNT_RE.test(a))
  if (wantTransfers && accCond.length) {
    const accList = accCond.map(a => `'${a}'`).join(',')
    const transferAssetExpr = transferAssetIdSql()
    const transferTokenFilter = assetIdFilterSql(transferAssetExpr, tokenIds)
    const transferAmountFilter = eventValueFilterSql(transferAssetExpr, `JSONExtractString(args_json,'amount')`, 'block_timestamp', queryFilters, prices, 'account_transfer_price')
    // The read model carries the decoded from/to/asset/amount columns, so it answers a
    // plain transfer window without touching raw_events at all. It has no price join and
    // no asset-ref index, so a token-unit or min-USD threshold on a token still falls
    // back to raw_events — and THAT read is the one the prefilter below is for.
    const useTransferReadModel = tokenIds == null && queryFilters.min == null
    // Prune to the account's own (block, event) refs before the JSON conditions
    // — turns the per-account full scan of raw_events into a point-range read.
    // Module transfers stay in the refs: pot legs are filtered per-pot below
    // (a treasury donation IS the account's transfer; only swap/fee plumbing
    // pots are dropped).
    //
    // It applies exactly when the fallback read runs. Guarding it on
    // `tokenIds == null && min == null` as well made the condition `!A && A`, so it never
    // once appeared in a query and a filtered transfer read scanned raw_events with
    // JSONExtract predicates across the whole bound.
    const transferRefEvents = `event_name IN ('Balances.Transfer','Tokens.Transfer','Currencies.Transferred')`
    const transferRefsFilter = useTransferReadModel ? ''
      : `AND ${accountActivityRefsSql(accCond, transferRefEvents, bound, catFetch * 3)}`
    const poolAccs = ammPoolAccounts()
    const viewingPool = accCond.some(a => poolAccs.has(a))
    const poolLegFilter = !viewingPool && poolAccs.size
      ? `AND JSONExtractString(args_json,'from') NOT IN (${[...poolAccs].map(a => `'${a}'`).join(',')}) AND JSONExtractString(args_json,'to') NOT IN (${[...poolAccs].map(a => `'${a}'`).join(',')})`
      : ''
    // The noisy-pot legs are plumbing on a NORMAL account's page, but when the
    // viewed account IS one of those pots (fee processor, omnipool, router) they
    // ARE its activity — otherwise every row is dropped and the page is empty
    // while the tab count is large. Mirror the viewingPool/viewingMmContract
    // exception and skip the noisy-pot exclusion in that case.
    const viewingNoisyPot = accCond.some(a => NOISY_TRANSFER_POTS.includes(a))
    const rawNoisyPotFilter = viewingNoisyPot ? '' :
      `AND JSONExtractString(args_json,'from') NOT IN (${noisyPotList()}) AND JSONExtractString(args_json,'to') NOT IN (${noisyPotList()})`
    // The read-model form of all three exclusions, shared verbatim with the count arm
    // so the rows it counts and the rows this reads can never be a different set.
    const readModelPotFilters = await transferCandidatePotFiltersSql(accCond)
    const readTransfers = async (refsFilter: string): Promise<RawTransferEventRow[]> => {
      const res = await client.query({
        query: useTransferReadModel
          ? `SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name,
                from_account AS from_acc, to_account AS to_acc, amount, asset_id
              FROM price_data.account_transfer_activity
              WHERE account IN (${accList}) AND ${bound}
                AND (from_account IN (${accList}) OR to_account IN (${accList}))
                ${readModelPotFilters}
              ORDER BY block_height DESC, event_index DESC LIMIT {n:UInt32}`
          : `SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name,
                JSONExtractString(args_json,'from') AS from_acc,
                JSONExtractString(args_json,'to') AS to_acc,
                JSONExtractString(args_json,'amount') AS amount,
                ${transferAssetExpr} AS asset_id
              FROM price_data.raw_events
              ${transferAmountFilter.joinSql}
              WHERE ${bound}
                ${refsFilter}
                AND ${transferRefEvents}
                AND (JSONExtractString(args_json,'from') IN (${accList}) OR JSONExtractString(args_json,'to') IN (${accList}))
                ${rawNoisyPotFilter}
                AND NOT match(JSONExtractString(args_json,'from'), '^0x(7369626c|70617261|506172656e74)')
                AND NOT match(JSONExtractString(args_json,'to'), '^0x(7369626c|70617261|506172656e74)')
                ${poolLegFilter}
                ${transferTokenFilter}
                ${transferAmountFilter.predicateSql}
              ORDER BY block_height DESC, event_index DESC
              LIMIT {n:UInt32}`,
        query_params: { n: catFetch }, format: 'JSONEachRow',
      })
      return res.json<RawTransferEventRow>()
    }
    let rawTransferRows = await readTransfers(transferRefsFilter)
    // The prefilter caps the read at the newest `catFetch * 3` of the account's own
    // transfer references — generous enough that almost every account holds fewer than
    // the cap, so it prunes granules without hiding anything. A structural pot with
    // millions of them is the exception, and a rare token or a high threshold is exactly
    // the filter whose matches sit below such a cap. So a SHORT read is the signal to
    // check: if a reference survives past the cap, the prefilter narrowed this account's
    // history and the read is taken again over the whole bound.
    //
    // Redoing it, rather than reporting the cap as a frontier, is what keeps the
    // prefilter a pure optimisation — the rows are the same rows the unpruned read would
    // have returned, so `rawRows >= catFetch` remains the whole saturation rule and this
    // source ends where every other source ends: at its own limit.
    if (transferRefsFilter && rawTransferRows.length < catFetch) {
      const past = await client.query({
        query: `SELECT 1 FROM (${accountActivityRefsQuery(accCond, transferRefEvents, bound, 1, catFetch * 3)})`,
        format: 'JSONEachRow',
      })
      const refPastCap = (await past.json<Record<string, number>>()).length > 0
      if (transferReadNeedsWholeBound(rawTransferRows.length, catFetch, refPastCap)) {
        rawTransferRows = await readTransfers('')
      }
    }
    noteSource(rawTransferRows.length, oldestWindowBlock(rawTransferRows, r => r.block_height))
    // Transfers *to* the treasury pot are fees/deposits unless the originating
    // extrinsic is itself a token-transfer call — surface only genuine donations
    // (payouts *from* the treasury are unaffected). Skipped when the viewed
    // account IS the treasury, whose page is exactly those legs.
    const viewingTreasury = accCond.includes(TREASURY_POT)
    const treasuryTransferOk = viewingTreasury ? new Set<string>()
      : await transferCallExtrinsics(rawTransferRows.filter(r => r.to_acc === TREASURY_POT).map(r => [r.block_height, r.extrinsic_index] as [number, number | null]))
    const seenTr = new Set<string>()
    for (const r of dedupeTransferEvents(rawTransferRows)) {
      const key = `${r.block_height}:${r.event_index}`
      if (seenTr.has(key)) continue
      seenTr.add(key)
      // Drop transfers that are a leg of one of our own signed trades (swap noise).
      if (r.extrinsic_index != null && tradeExt.has(`${r.block_height}:${r.extrinsic_index}`)) continue
      // A transfer to the treasury that is not itself a transfer call is a
      // fee/deposit (register_code, an XCM inherent, a non-swap batch fee), not a
      // user transfer.
      if (!viewingTreasury && r.to_acc === TREASURY_POT
        && !(r.extrinsic_index != null && treasuryTransferOk.has(`${r.block_height}:${r.extrinsic_index}`))) continue
      const a = asset(r.asset_id)
      transfers.push({
        type: 'transfer', blockHeight: r.block_height, timestamp: r.ts, eventIndex: r.event_index, extrinsicIndex: r.extrinsic_index,
        who: r.from_acc ? accountRef(r.from_acc) : null,
        to: r.to_acc ? accountRef(r.to_acc) : null, asset: a, assetIn: null, assetOut: null,
        amount: r.amount, amountIn: null, amountOut: null,
        valueUsd: usdValue(prices, a.assetId, r.amount, a.decimals),
        linkBlock: r.block_height, linkIndex: r.extrinsic_index,
      })
    }
  }

  // 4. Liquidity provision/removal by this account (Omnipool / Stableswap / XYK).
  // Filtering by who=account excludes the routerex pallet's swap-internal pool ops,
  // leaving only genuine user LP actions. Omnipool carries the provided asset; for
  // Stableswap/XYK we key the row on the pool's share asset (poolId / assetA).
  const liq: ActivityRow[] = []
  // Extrinsics with liquidity events: their transfer legs (pool deposits/
  // withdrawals, pool seeding, ED fee) are represented by the liquidity row —
  // not standalone transfers. Pool accounts are blake2-derived, so no prefix
  // rule catches them; keying on the extrinsic does.
  const liqCreateExt = new Set<string>()
  if (wantLiquidity) {
    const liquidityAssetExpr = 'asset_id'
    // Row inclusion matches every asset the event references (XYK assetB, Stableswap
    // nested assets[]), even though the displayed asset_id stays the representative
    // liquidityAssetExpr — else this account's HOLLAR Stableswap LP rows drop out.
    const liquidityTokenFilter = tokenIds == null ? '' : tokenIds.length ? `AND hasAny(asset_refs, [${tokenIds.join(',')}])` : 'AND 0'
    const fetchLiquidityPage = async (pageBound: string, pageLimit: number): Promise<ActivityRow[]> => {
      const liqRes = await client.query({
        query: `SELECT block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name,
                who AS who,
                ${liquidityAssetExpr} AS asset_id,
                amount AS amount,
                asset_b AS asset_b,
                pool_account AS pool_acc,
                asset_refs AS asset_refs
              FROM price_data.liquidity_activity
              WHERE ${pageBound}
                AND event_name IN (${sqlEventNameList(LIQUIDITY_EVENTS)})
                AND ${liquidityWhoOrPoolSql(list)}
                ${liquidityTokenFilter}
              ORDER BY block_height DESC, event_index DESC LIMIT {n:UInt32}`,
        query_params: { n: pageLimit },
        format: 'JSONEachRow',
      })
      const liqRows = await liqRes.json<{ block_height: number; ts: string; event_index: number; extrinsic_index: number | null; event_name: string; who: string; asset_id: number; amount: string; asset_b: number; pool_acc: string; asset_refs: number[] }>()
      await fillMissingLiquidityAmounts(liqRows)
      const built: ActivityRow[] = []
      const liqCreateCands: { row: ActivityRow; pool: string; assetB: number }[] = []
      for (const r of liqRows) {
        const a = asset(r.asset_id)
        const row: ActivityRow = {
          type: 'liquidity', blockHeight: r.block_height, timestamp: r.ts, eventIndex: r.event_index, extrinsicIndex: r.extrinsic_index,
          who: r.who ? accountRef(r.who) : accounts[0] ? accountRef(accounts[0]) : null, to: null, asset: a, assetIn: null, assetOut: null,
          ...liquidityRowAmount(r.event_name, prices, a.assetId, r.amount, a.decimals), amountIn: null, amountOut: null,
          assetRefs: r.asset_refs,
          liqAction: liqActionFor(r.event_name),
          linkBlock: r.block_height, linkIndex: r.extrinsic_index,
        }
        if (r.event_name === 'XYK.PoolCreated') liqCreateCands.push({ row, pool: r.pool_acc, assetB: r.asset_b })
        built.push(row)
      }
      await enrichPoolCreations(liqCreateCands)
      await applyHistoricalUsd(built, activityHistPick)
      return built
    }
    const liqRows = queryFilters.min != null
      ? await fetchFilteredDeep(tw, catFetch, fetchLiquidityPage,
        row => activityRowMatchesFilters(row, { min: queryFilters.min, unit: queryFilters.unit }),
        row => row.blockHeight, row => row.eventIndex ?? -1,
        row => `${row.blockHeight}:${row.eventIndex}`)
      : await fetchLiquidityPage(bound, catFetch)
    noteSource(liqRows.length, oldestWindowBlock(liqRows, r => r.blockHeight))
    for (const row of liqRows) {
      if (row.extrinsicIndex != null) liqCreateExt.add(`${row.blockHeight}:${row.extrinsicIndex}`)
      liq.push(row)
    }
  }

  // 6. Cross-chain (XCM) transfers sent (outbound) or received (inbound) by this account.
  // Each XCM leg has its own window, so saturation is per leg: the concatenation
  // reaching catFetch says nothing about whether any single leg was exhausted.
  const xcmLegs = exact ? [exact.enumerated.xcm]
    : wantXcm
    ? await Promise.all([
      getRecentXcm(catFetch, from, to, accounts, 0, queryFilters),
      getRecentXcmIn(catFetch, from, to, accounts, 0, queryFilters),
      getRecentXcmOutRemote(catFetch, from, to, accounts, 0, queryFilters),
      getRecentXcmExecuted(catFetch, from, to, accounts, 0, queryFilters),
    ])
    : []
  for (const leg of xcmLegs) noteSource(leg.length, oldestWindowBlock(leg, r => r.blockHeight))
  const xcm = xcmLegs.flat()
  const govVotes = exact || !wantVotes ? []
    : (await getRecentVotes(catFetch, from, to, 0, {}, accounts, queryFilters)).map(voteActivityRow)
  // Collective (Council / Technical Committee) votes are a source of their own,
  // read newest-first under its own limit — so it contributes its own frontier
  // rather than borrowing the indexed source's. Skipped under a filter no
  // amountless row can satisfy (collectiveVotesAdmitted).
  const collectiveVotes = exact || !wantVotes || !collectiveVotesAdmitted(queryFilters) ? []
    : (await getCollectiveVotes(accounts, catFetch, from, to)).map(voteActivityRow)
  const voteRows: ActivityRow[] = exact ? exact.enumerated.votes : [...govVotes, ...collectiveVotes]
  if (exact) noteSource(voteRows.length, oldestWindowBlock(voteRows, r => r.blockHeight))
  else {
    noteSource(govVotes.length, oldestWindowBlock(govVotes, r => r.blockHeight))
    noteSource(collectiveVotes.length, oldestWindowBlock(collectiveVotes, r => r.blockHeight))
  }
  if (filters.min != null && filters.unit !== 'token') {
    await applyHistoricalUsd([...trades, ...transfers, ...liq, ...voteRows], activityHistPick)
  }

  // The assembled feed carries each row's category in `type`. When a single
  // category is requested, filter to it so rare types aren't starved out by the
  // slice below.
  const scopedTransfers = transfers.filter(t =>
    !(t.extrinsicIndex != null && liqCreateExt.has(`${t.blockHeight}:${t.extrinsicIndex}`)))
  const userTrades = dropShareRoutedTrades(trades, activityExtrinsicSet(liq))
  let merged = await suppressActivityPlumbing([...userTrades, ...scopedTransfers, ...liq, ...voteRows, ...xcm])
  if (type && type !== 'all') merged = merged.filter(r => activityTypeMatchesFamily(r.type, type))
  merged = merged.filter(r => activityRowMatchesFilters(r, filters) && activityRowMatchesAction(r, action))
  if (exact) {
    // The enumerated sources were read over the whole history rather than the located
    // blocks, so restrict to the blocks the page was located in before reconciling.
    const located = merged.filter(r => exact.perBlock.has(r.blockHeight))
    const mismatch = exactActivityMismatch(located.map(r => r.blockHeight), exact.perBlock)
    // Refusing is the only honest answer: the total and the page were derived from
    // different row sets, so serving either would number pages the feed does not
    // hold. The caller falls back to the candidate window, which says what it covers.
    if (mismatch) throw exactActivityDisagreement(mismatch)
    return { rows: located.sort(compareActivityRowsNewestFirst), complete: true, frontierBlock: null }
  }
  const frontierBlock = activityWindowFrontier(sourceWindows)
  return {
    rows: activityRowsAboveFrontier(merged, frontierBlock).sort(compareActivityRowsNewestFirst),
    complete: frontierBlock == null,
    frontierBlock,
  }
}

// A page never asks for a narrower window than this, so page 1 of a small account
// costs exactly what it always did. A count starts one step wider because it has
// no page depth to scale from, and the overwhelming majority of accounts (7.0M of
// the 7.05M with any activity hold under a thousand indexed references) then
// complete on its first pass.
const ACTIVITY_WINDOW_FLOOR = 1_000
const ACTIVITY_COUNT_WINDOW_SEED = 2_000

// Grow the candidate window until the feed is complete — no source still had
// older rows behind its window — or the source ceiling is reached. A wider window
// pushes the frontier further back, so it is what deepens both the exact total and
// the pages that total numbers: whatever depth the total was counted at, a page at
// that depth is servable for the same cost.
async function growAccountActivityWindow(
  accounts: string[],
  type: string,
  seedFetch: number,
  action: string | undefined,
  filters: ValueListFilters,
  from: string | undefined,
  to: string | undefined,
  enough: (window: AccountActivityWindow) => boolean,
): Promise<AccountActivityWindow> {
  let catFetch = Math.min(Math.max(seedFetch, ACTIVITY_WINDOW_FLOOR), MAX_ACTIVITY_SOURCE_ROWS)
  for (;;) {
    const window = await collectAccountActivity(accounts, type, catFetch, action, filters, from, to)
    if (window.complete || enough(window) || catFetch >= MAX_ACTIVITY_SOURCE_ROWS) return window
    catFetch = Math.min(catFetch * 4, MAX_ACTIVITY_SOURCE_ROWS)
  }
}

// One page of the account feed, located inside the whole feed when the request's
// shape can be counted exactly (see the section above) and otherwise sliced out of a
// candidate window.
//
// Located: the page's ranks are found in SQL, the classifier assembles exactly the
// blocks holding them, and the slice is taken at `offset - above` because `above`
// rows of the feed sit in strictly newer blocks. Windowed: the page must START above
// the window's frontier; past it the feed continues but this window cannot say what
// it holds, so the page is refused rather than silently omitting older history — and
// a page that only ENDS past it is served short rather than withheld, because a total
// counts a complete window to exactly there.
async function getAccountActivity(accounts: string[], limit: number, type = 'all', offset = 0, action?: string, filters: ValueListFilters = {}, from?: string, to?: string): Promise<ActivityRow[]> {
  const located = await locatedAccountActivityPage(accounts, type, limit, offset, action, filters, from, to)
  const page = located ?? await windowedAccountActivityPage(accounts, type, limit, offset, action, filters, from, to)
  await applyHistoricalUsd(page, activityHistPick)
  return page
}

// Null when this request has no exact plan, when the located blocks and the classifier
// disagreed, or when a count arm was too heavy to run — the windowed path answers in
// every one of those cases, with a partial total that says what it covers.
async function locatedAccountActivityPage(
  accounts: string[], type: string, limit: number, offset: number,
  action: string | undefined, filters: ValueListFilters, from?: string, to?: string,
): Promise<ActivityRow[] | null> {
  try {
    const plan = await planExactActivity(accounts, normalizeActivityTypeKey(type), action, filters, from, to)
    if (!plan) return null
    const location = await locateExactActivity(plan, offset, limit)
    if (!location.blocks.length) return []
    // Only the SQL-counted sources are still read here, and the closed block set — not a
    // row limit — is what bounds them: a source's CANDIDATES in a block can far outnumber
    // the rows it contributes (a block with one real transfer can hold fifty plumbing
    // legs), so a limit scaled to the located row count would truncate the very context
    // the classification needs. The enumerated sources are handed over from the plan.
    const built = await collectAccountActivity(accounts, type, MAX_LOCATED_BLOCK_SOURCE_ROWS, action, filters, from, to,
      { blocks: location.blocks, perBlock: location.perBlock, enumerated: plan.enumerated })
    return built.rows.slice(offset - location.above, offset - location.above + limit)
  } catch (error) {
    if (!exactActivityRefusal(error)) throw error
    console.warn('[explorer] located activity page unavailable', { type, offset, limit, accounts: accounts.length }, (error as Error).message)
    return null
  }
}

// Whether an exact-path failure means "answer this from the window instead" rather than
// "this request is broken". The transfer family's subordination sets are hash sets over
// the account's own history, so the structural pots — the routerex pallet alone holds
// 10.9M hook transfer legs — can exceed the query memory ceiling. Falling back publishes
// a partial total that says so, which is the same answer those pots got before any of
// this existed; a 500 would be strictly worse than the honest incompleteness.
function exactActivityRefusal(error: unknown): boolean {
  if (error instanceof ExactActivityDisagreement) return true
  const code = (error as { code?: unknown })?.code
  // 241 memory limit, 396 result rows, 62 query size, 159 execution time.
  return typeof code === 'string' && (code === '241' || CLICKHOUSE_QUERY_GUARD_CODES.has(code))
}

async function windowedAccountActivityPage(
  accounts: string[], type: string, limit: number, offset: number,
  action: string | undefined, filters: ValueListFilters, from?: string, to?: string,
): Promise<ActivityRow[]> {
  const want = offset + limit
  const window = await growAccountActivityWindow(accounts, type, want * 5, action, filters, from, to,
    built => built.rows.length >= want)
  if (!window.complete && offset >= window.rows.length) throw activityQueryTooBroad()
  return window.rows.slice(offset, offset + limit)
}

// A cold count is the most expensive read on the page, so cap how long it may keep
// widening. Past the deadline the answer is the widest exact prefix reached so far
// rather than an ever-growing wait or a ClickHouse execution timeout.
const ACTIVITY_COUNT_DEADLINE_MS = 15_000
// How many rows the account/tag activity feed holds under exactly these filters —
// the number the pager sizes itself from — and whether that is the whole feed.
//
// A count has no page depth to scale its window from, and the intermediate widening
// steps a page walks through buy it nothing: it wants either the whole feed or the
// deepest frontier the ceiling reaches, which is also the deepest a page can be
// served from. So it seeds at the width that completes for the overwhelming majority
// of accounts (7.0M of the 7.05M with any activity hold under a thousand indexed
// references) and, if that saturates, jumps straight to the ceiling. A pot-sized
// feed (the Omnipool pot references 72.5M activity rows) is counted exactly back to
// its frontier and says so; only a feed whose narrowest window cannot even be
// assembled has no total at all.
async function countAccountActivity(accounts: string[], type: string, action: string | undefined, filters: ValueListFilters, from?: string, to?: string): Promise<ScopedListTotal> {
  // A countable shape needs no window at all: the total is a sum over the feed's
  // blocks, so it is exact and complete however deep the account's history runs. A
  // refusal here is not an error page — it falls through to the window, which reports
  // the prefix it does cover.
  try {
    const plan = await planExactActivity(accounts, normalizeActivityTypeKey(type), action, filters, from, to)
    if (plan) return { total: await countExactActivity(plan), complete: true }
  } catch (error) {
    if (!exactActivityRefusal(error)) throw error
    console.warn('[explorer] exact activity total unavailable', { type, action, accounts: accounts.length }, (error as Error).message)
  }
  const deadline = Date.now() + ACTIVITY_COUNT_DEADLINE_MS
  let widest: AccountActivityWindow | null = null
  for (const catFetch of [ACTIVITY_COUNT_WINDOW_SEED, MAX_ACTIVITY_SOURCE_ROWS]) {
    try {
      widest = await collectAccountActivity(accounts, type, catFetch, action, filters, from, to)
    } catch (error) {
      // A window too wide to assemble ends the widening. The narrower one that did
      // assemble is still an exact prefix, so the pager keeps real pages over it.
      // Logged rather than swallowed silently.
      console.warn('[explorer] activity window unavailable', { type, action, catFetch, accounts: accounts.length }, error)
      break
    }
    if (widest.complete || Date.now() > deadline) break
  }
  if (!widest) return { total: null, complete: false }
  // Counted at the published frontier, not the window's own: an incomplete total is
  // cached for minutes and has to keep numbering pages the feed can still serve.
  const margin = activityFrontierMarginBlocks(await measuredParaBlockMs(client))
  const counted = activityRowsAboveFrontier(widest.rows, publishedActivityFrontier(widest.frontierBlock, margin))
  return { total: counted.length, complete: widest.complete }
}

// The newest block in which anything this account's page would show happened.
//
// It exists so the page stops rebuilding for accounts that did nothing. The
// rebuild is expensive — measured on two real accounts at 750-1000ms, reading
// 27-33M rows and 1.2-1.7 GiB — and under an 8-second TTL a reader polling
// every 6s paid it again and again while the answer never changed. With the
// height in the KEY, an idle account keeps hitting the cache and an account
// that acts invalidates itself immediately, which is also faster than waiting
// out a TTL.
//
// account_activity_v3 is ORDER BY (account, block_height, …), so the watermark is
// an index-prefix read of the same projection every per-account feed is built from
// — it sees exactly what the page can show.
async function accountActivityWatermark(accounts: string[]): Promise<number> {
  if (!accounts.length) return 0
  // Briefly cached: one page asks for several lists at once, and they should
  // agree on the height they were built for.
  return cached(`explorer:acct-watermark:${accounts.join(',')}`, 2_000, async () => {
    try {
      const res = await client.query({
        query: `SELECT max(block_height) AS w FROM price_data.account_activity_v3
                WHERE account IN {accounts:Array(String)}`,
        query_params: { accounts }, format: 'JSONEachRow',
      })
      return Number((await res.json<{ w: number | null }>())[0]?.w ?? 0)
    } catch {
      // A failed watermark must not serve a stale page: fall back to a value
      // that changes every block, which restores the old rebuild-always
      // behaviour rather than pinning the cache on a height we never read.
      return await indexedRawHead()
    }
  })
}

async function getScopedAccountActivity(
  accounts: string[],
  cacheScope: string,
  type: string,
  limit: number,
  offset: number,
  action: string | undefined,
  filters: ValueListFilters,
  from?: string,
  to?: string,
): Promise<ActivityRow[]> {
  const window = timeWindow(from, to)
  noteHotActivityScope(cacheScope, accounts)
  // A CLOSED dated view is history and cannot change; a live one — or a dated one
  // still reaching today — is keyed by the account's own activity height, so the
  // TTL is only a backstop (see datedWindowIsClosed).
  const mark = window && datedWindowIsClosed(to) ? 0 : await accountActivityWatermark(accounts)
  return cached(`explorer:${cacheScope}:activity:w${mark}:${type}:${limit}:${offset}:${action ?? ''}:${from ?? ''}:${to ?? ''}:${filterKey(filters)}`, window ? 30_000 : 60_000,
    () => getAccountActivity(accounts, limit, type, offset, action, filters, from, to))
}

// ── Keeping the shared enumerated read warm ───────────────────────────────────
//
// Serving the previous snapshot while a lapsed one re-reads (cachedSwr above) already
// means only a reader who finds the key EMPTY waits, which over 12 days of proxy logs is
// 17.5% of unfiltered account/tag activity requests rather than 25.3%. This pass closes
// part of what is left, for the scopes a reader has recently been reading.
//
// It deliberately does not keep a standing set warm around the clock. Traffic to one
// account is a handful of visits a day, so refreshing every hot scope every cycle
// regardless of demand costs roughly twenty times the reader wall it removes — the same
// trade that made the directory's activity ranking recount 250 members every five
// minutes. Two rules keep this proportional instead:
//
//   - Demand decays. A scope stops being refreshed an hour after its last request, so a
//     quiet instance does no work at all and cost tracks visits rather than uptime.
//   - Only what is about to lapse is re-read. The snapshot outlives three cycles, so
//     re-reading it every cycle would be two wasted reads in three.
//
// Measured against the same logs, that is 1.2 reads and 0.64s of wall per five-minute
// cycle, for 325s of reader wall over twelve days against 507s without it and 778s
// before either change.
//
// A first-ever visit cannot be warmed and is not pretended otherwise: it pays the cold
// read and gets the same correct answer, only slower.
const HOT_ACTIVITY_SCOPES = 16
const HOT_ACTIVITY_SCOPE_IDLE_MS = 60 * 60_000
// Re-read a snapshot only once it is within this much of lapsing — a little over one
// cycle, so nothing expires between cycles and nothing is read three times per lifetime.
const ENUMERATED_PREWARM_LEAD_MS = 6 * 60_000
// What one cycle may spend, sequentially. The read is 0.1–0.3s for a typical account and
// 6.2s for the one holding 101k cross-chain rows, so a wall-clock budget bounds the pass
// where a count of scopes would not: worst case one over-running scope, then the pass
// stops and the oldest-first ordering resumes there next cycle.
const ENUMERATED_PREWARM_BUDGET_MS = 20_000
interface HotActivityScope { accounts: string[]; requestedAt: number }
const hotActivityScopes = new Map<string, HotActivityScope>()

// Recorded at the one function both feed endpoints go through, and NOWHERE else: the
// account-directory ranking counts pool members through getAddressListTotal /
// getTagListTotal, and if those counted as a reader's interest this set would fill with
// the 250 accounts that pass visits — reintroducing exactly the continuous whole-history
// load the ranking was throttled to remove.
//
// Interest is in the SCOPE, not in the shape asked for: a reader moves between chips and
// filters on one page, and every one of those shapes reads the same snapshot. Only the
// undated `all`/`transfer` set is warmed, which is 92% of what they ask for.
function noteHotActivityScope(cacheScope: string, accounts: string[]): void {
  // Re-inserted so iteration order is least-recently-requested first, with the member
  // list refreshed: a tag gains members and an account gains EVM bindings, and warming
  // the key a stale list builds would warm one no reader reads.
  hotActivityScopes.delete(cacheScope)
  hotActivityScopes.set(cacheScope, { accounts, requestedAt: Date.now() })
  for (const scope of hotActivityScopes.keys()) {
    if (hotActivityScopes.size <= HOT_ACTIVITY_SCOPES) break
    hotActivityScopes.delete(scope)
  }
}

// Re-read the snapshots that are about to lapse under scopes still being read, oldest
// request first, inside the cycle's budget.
//
// A failure here costs a reader latency and never correctness: the entry simply stays
// absent and the next request computes it, so the pass logs and moves on.
async function prewarmHotActivitySnapshots(): Promise<void> {
  const startedAt = Date.now()
  const deadline = startedAt + ENUMERATED_PREWARM_BUDGET_MS
  let warmed = 0
  let due = 0
  for (const [cacheScope, scope] of [...hotActivityScopes].sort((a, b) => a[1].requestedAt - b[1].requestedAt)) {
    if (startedAt - scope.requestedAt > HOT_ACTIVITY_SCOPE_IDLE_MS) { hotActivityScopes.delete(cacheScope); continue }
    // The same budget planExactActivity refuses an over-large account list on, so a cycle
    // cannot be spent warming a snapshot the request path never reads.
    if (sqlAccountList(scope.accounts).length * 2 > MAX_EXACT_ACCOUNT_LIST_BYTES) continue
    const key = enumeratedActivityKey(scope.accounts, 'all')
    const expiry = cacheExpiry(key)
    if (expiry != null && expiry - startedAt > ENUMERATED_PREWARM_LEAD_MS) continue
    due++
    if (Date.now() >= deadline) continue
    try {
      await refreshEnumeratedActivitySnapshot(scope.accounts)
      warmed++
    } catch (error) {
      console.warn('[explorer] activity snapshot prewarm failed', error)
    }
  }
  if (due) console.info('[explorer] activity snapshot prewarm', { hot: hotActivityScopes.size, due, warmed, ms: Date.now() - startedAt })
}

// Account detail feeds resolve the address to the same related-account set used
// by getAddress. Unknown addresses return null so routes can distinguish them
// from recognized accounts with no activity.
export async function getAddressActivity(addressInput: string, type = 'all', limit = 40, offset = 0, action?: string, filters: ValueListFilters = {}, from?: string, to?: string): Promise<ActivityRow[] | null> {
  const resolved = await resolveRelatedAccounts(addressInput)
  if (!resolved) return null
  return getScopedAccountActivity(resolved.related, `account:${resolved.norm.accountId}`, type, limit, offset, action, filters, from, to)
}

// The account's signed extrinsics (paginated). Same shape as getRecentExtrinsics
// but scoped to the related-account set as the signer.
export async function getAddressExtrinsics(addressInput: string, limit = 25, offset = 0, filters: ExtrinsicListFilters = {}, from?: string, to?: string): Promise<ExtrinsicSummary[] | null> {
  const resolved = await resolveRelatedAccounts(addressInput)
  if (!resolved) return null
  return getAccountExtrinsics(resolved.related, limit, offset, `addr-extrinsics:${resolved.norm.accountId}`, filters, from, to)
}

// Every governance vote cast by the account (OpenGov + Democracy + collectives),
// scoped to the same related-account set as the other detail feeds.
export async function getAddressVotes(addressInput: string, limit = 25, offset = 0, from?: string, to?: string, filters: VoteListFilters = {}): Promise<VoteRow[] | null> {
  const resolved = await resolveRelatedAccounts(addressInput)
  if (!resolved) return null
  return getScopedVotes(resolved.related, `account:${resolved.norm.accountId}`, limit, offset, from, to, filters)
}

// Tab counts for an account/tag detail page: extrinsics is the deduplicated
// union of signed and on-behalf (proxy/multisig) extrinsics, and events is any
// event mentioning a related account. The events count is a full args scan
// (~2.5s), so it is served from its own lazily-fetched endpoint under a long
// cache rather than blocking the page payload.

// Multisig lifecycle event → MultisigLifecycleEvent.kind, exactly the map the
// retired multisig_operations derivation job used.
const MS_EVENT_KIND: Record<string, MultisigLifecycleEvent['kind']> = {
  'Multisig.NewMultisig': 'new',
  'Multisig.MultisigApproval': 'approval',
  'Multisig.MultisigExecuted': 'executed',
  'Multisig.MultisigCancelled': 'cancelled',
}

// An account's multisig operations, reconstructed per request from its own
// (account-first, PK-bounded FINAL) lifecycle events — the same precedent as
// pendingMultisigOps — plus the as_multi_threshold_1 ops from the in-memory
// snapshot the shared proxy/multisig refresher keeps. Short-TTL cached: the
// extrinsics feed, its count, and the tab-counts overlap query all want the
// same reconstruction within one request burst.
async function accountMultisigOps(accounts: string[]): Promise<MultisigOperationState[]> {
  const list = sqlAccountList(accounts)
  if (list === "''") return []
  return cached(`explorer:ms-ops:${[...accounts].sort().join(',')}`, 10_000, async () => {
    const res = await client.query({
      query: `
        SELECT block_height AS block, event_index AS eventIndex, assumeNotNull(extrinsic_index) AS extrinsic,
               toUInt32(toUnixTimestamp(block_timestamp)) AS ts, event_name,
               multisig, lower(actor) AS actor, call_hash AS callHash,
               timepoint_height AS timepointHeight, timepoint_index AS timepointIndex,
               has_timepoint AS hasTimepoint, result_ok AS resultOk, result_error_json AS resultErrorJson
        FROM price_data.multisig_event_activity FINAL
        WHERE multisig IN (${list}) AND extrinsic_index IS NOT NULL`,
      format: 'JSONEachRow',
    })
    const rows = await res.json<{
      block: number; eventIndex: number; extrinsic: number; ts: number; event_name: string
      multisig: string; actor: string; callHash: string
      timepointHeight: number; timepointIndex: number; hasTimepoint: number; resultOk: number | null
      resultErrorJson: string | null
    }>()
    const events: MultisigLifecycleEvent[] = rows.map(r => ({
      kind: MS_EVENT_KIND[r.event_name],
      multisig: r.multisig, callHash: r.callHash,
      timepointHeight: r.hasTimepoint ? r.timepointHeight : null,
      timepointIndex: r.hasTimepoint ? r.timepointIndex : null,
      actor: r.actor, block: r.block, extrinsic: r.extrinsic, eventIndex: r.eventIndex, ts: r.ts,
      ok: r.event_name === 'Multisig.MultisigExecuted' ? r.resultOk === 1 : null,
      errorJson: r.resultErrorJson ?? null,
    }))
    const states = buildMultisigOperations(events)
    for (const row of threshold1OpsFor(accounts)) states.push({ row, touchpoints: [] })
    return states
  })
}

// Distinct on-behalf extrinsics (proxy targets ∪ multisig operation anchors)
// for a related-account set, as a (block,extrinsic) tuple set — the shared
// basis for both the count below and the tab-counts overlap query. Cheap:
// both sources are account-first and tiny. Cached on its own so the tag
// snapshot read path (which serves counts from a table that predates this
// field) can attach it without a recompute.
async function onBehalfExtrinsicTuples(accounts: string[], cacheKey: string): Promise<Set<string>> {
  const list = sqlAccountList(accounts)
  if (list === "''") return new Set()
  return cached(`explorer:onbehalf-tuples:${cacheKey}`, 600_000, async () => {
    const [proxyRes, msStates] = await Promise.all([
      client.query({
        query: `SELECT DISTINCT block_height, extrinsic_index FROM price_data.proxy_call_activity WHERE real_account IN (${list})`,
        format: 'JSONEachRow',
      }),
      accountMultisigOps(accounts),
    ])
    const keys = new Set<string>()
    for (const t of await proxyRes.json<{ block_height: number; extrinsic_index: number }>()) keys.add(`${t.block_height}:${t.extrinsic_index}`)
    for (const s of msStates) keys.add(`${s.row.anchor_block_height}:${s.row.anchor_extrinsic_index}`)
    return keys
  })
}

async function onBehalfExtrinsicCount(accounts: string[], cacheKey: string): Promise<number> {
  return (await onBehalfExtrinsicTuples(accounts, cacheKey)).size
}

// The signed side of the extrinsics list as SQL, so the page query and the exact
// total cannot read one filter two ways. `call`/`result` match the same columns
// the signed rows display.
function signedExtrinsicPredicateSql(list: string, filters: ExtrinsicListFilters): string {
  const call = filters.call?.trim() ? textNameFilter('call_name', 'callName') : ''
  const result = filters.result === 'success' ? 'AND success = 1'
    : filters.result === 'failed' ? 'AND success = 0' : ''
  return `AND (signer IN (${list}) OR effective_signer IN (${list})) ${call} ${result}`
}

// Signed ∩ on-behalf overlap (e.g. self-proxy): the merged extrinsics list
// shows such an extrinsic once, so the total subtracts it from the naive sum.
// Driven by an explicit chunked IN list over the given tuple set (the source
// tables no longer exist as a single joinable projection once on-behalf ops are
// reconstructed at request time). Counts DISTINCT extrinsics, because
// raw_extrinsics is replayable and the list itself dedupes per extrinsic.
async function signedOverlapCount(tuples: Set<string>, list: string, bound: string, filters: ExtrinsicListFilters): Promise<number> {
  if (!tuples.size) return 0
  const tupleList = [...tuples].map(k => { const [h, e] = k.split(':'); return `(${h},${e})` })
  let total = 0
  for (let i = 0; i < tupleList.length; i += 10_000) {
    const chunk = tupleList.slice(i, i + 10_000).join(',')
    const res = await client.query({
      query: `SELECT uniqExact((block_height, extrinsic_index)) AS c FROM price_data.raw_extrinsics
              WHERE (block_height, extrinsic_index) IN (${chunk})
                AND ${bound}
                ${signedExtrinsicPredicateSql(list, filters)}`,
      query_params: { ...textNameParams('callName', filters.call) },
      format: 'JSONEachRow',
    })
    total += Number((await res.json<{ c: string }>())[0]?.c ?? 0)
  }
  return total
}

// Tab badges for an account/tag detail page. Each number is the exact length of
// the list behind that tab, produced by the same counters the pagers use.
export interface TabCounts { extrinsics: number; extrinsicsOnBehalf: number; events: number; votes: number }
async function getAccountTabCounts(accounts: string[], cacheKey: string): Promise<TabCounts> {
  const list = sqlAccountList(accounts)
  if (list === "''") return { extrinsics: 0, extrinsicsOnBehalf: 0, events: 0, votes: 0 }
  return cached(`explorer:tab-counts:${cacheKey}`, 600_000, async () => {
    const [extrinsics, onBehalf, events, votes] = await Promise.all([
      countAccountExtrinsics(accounts, cacheKey, {}),
      onBehalfExtrinsicCount(accounts, cacheKey),
      countAccountEvents(accounts, cacheKey, {}),
      // Conviction/democracy plus the collective votes the activity index does
      // not carry (its own 10-min cache is shared with the tag snapshot path).
      countScopedVotes(accounts, cacheKey),
    ])
    return { extrinsics, extrinsicsOnBehalf: onBehalf, events, votes }
  })
}
export async function getAddressTabCounts(addressInput: string): Promise<TabCounts | null> {
  const resolved = await resolveRelatedAccounts(addressInput)
  if (!resolved) return null
  return getAccountTabCounts(resolved.related, `addr:${resolved.norm.accountId}`)
}
const TAG_COUNT_REFRESH_MS = 10 * 60_000
const tagCountRefreshes = new Map<string, Promise<TabCounts>>()
const hotTagCounts = new Set<string>()
async function refreshTagTabCounts(tagId: string, members: string[], membershipKey: string): Promise<TabCounts> {
  const existing = tagCountRefreshes.get(tagId)
  if (existing) return existing
  const refresh = (async () => {
    const counts = await getAccountTabCounts(members, `tag:${tagId}:${membershipKey}`)
    // The snapshot table predates the votes badge and stays schema-stable; the
    // votes count is recomputed cheaply (and cached) on the read path instead.
    const { votes: _votes, extrinsicsOnBehalf: _onBehalf, ...persisted } = counts
    // `activity` is no longer a tab badge — the activity list reports its own
    // exact, filter-aware total — so the retained column keeps its default.
    await client.insert({
      table: 'price_data.tag_activity_counts',
      values: [{ tag_id: tagId, membership_key: membershipKey, ...persisted, computed_at: new Date().toISOString().replace('T', ' ').slice(0, 19) }],
      format: 'JSONEachRow',
    })
    return counts
  })().finally(() => {
    if (tagCountRefreshes.get(tagId) === refresh) tagCountRefreshes.delete(tagId)
  })
  tagCountRefreshes.set(tagId, refresh)
  return refresh
}
export async function getTagTabCounts(tagId: string): Promise<TabCounts | null> {
  const members = tagMembers(tagId)
  if (!members) return null
  hotTagCounts.add(tagId)
  const membershipKey = tagMembershipList(members)
  const result = await client.query({
    query: `SELECT membership_key, extrinsics, events,
              dateDiff('second', computed_at, now()) AS age
            FROM price_data.tag_activity_counts FINAL
            WHERE tag_id = {tagId:String}
            LIMIT 1`,
    query_params: { tagId }, format: 'JSONEachRow',
  })
  const snapshot = (await result.json<{ membership_key: string; extrinsics: string; events: string; age: number }>())[0]
  if (snapshot?.membership_key === membershipKey) {
    // Never attach a full-history refresh to the request that discovers an aged
    // snapshot. The ten-minute prewarmer owns refresh scheduling; this endpoint
    // always returns the last complete snapshot immediately. A request-triggered
    // refresh used to contend with the activity feed on the same cold page even
    // though the counts response itself had already completed. Votes aren't in
    // the snapshot table — they're recomputed via their own cheap cached query.
    const votes = await countScopedVotes(members, `tag:${tagId}:${membershipKey}`)
    const extrinsicsOnBehalf = await onBehalfExtrinsicCount(members, `tag:${tagId}:${membershipKey}`)
    return { extrinsics: Number(snapshot.extrinsics), extrinsicsOnBehalf, events: Number(snapshot.events), votes }
  }
  return refreshTagTabCounts(tagId, members, membershipKey)
}
// exact list totals (real numbered paging)
// Every paginated list on an account/tag detail page publishes how many rows it
// actually holds UNDER THE ACTIVE FILTERS, so "Page N of M", the numbered pages
// and the last-page jump are real rather than guesses. Each total runs the same
// code path that builds its list: the activity total is the classified feed's own
// length, never a sum of per-category counts. That sum was the bug — a DCA
// execution IS a swap, so trades 588 + dca 584 both counted the same 613 trade
// rows and the pager advertised 49 pages of a 26-page feed.
export type ScopedListTab = 'activity' | 'extrinsics' | 'events' | 'votes'
// `total` is always exact for the rows it covers. `complete` says whether it covers
// the whole list: an activity feed too deep to assemble in one window is counted
// exactly back to its candidate frontier, and the page states that older history
// lies beyond the pages it numbers rather than implying the list ends there.
export interface ScopedListTotal { total: number | null; complete: boolean }
export interface ScopedListQuery {
  tab: ScopedListTab
  type?: string
  action?: string
  value?: ValueListFilters
  extrinsic?: ExtrinsicListFilters
  event?: EventListFilters
  from?: string
  to?: string
}

// Every filter that changes the answer belongs in the key; a missing one serves
// one filter's total under another's.
export function scopedListTotalKey(scope: string, query: ScopedListQuery): string {
  return [
    'explorer', scope, 'list-total', query.tab,
    query.type ?? '', query.action ?? '',
    filterKey(query.value), filterKey(query.extrinsic), filterKey(query.event),
    query.from ?? '', query.to ?? '',
  ].join(':')
}

// The activity total walks the whole classified feed above its frontier, so it is
// far the most expensive of the four — served stale-while-revalidate: only a cold
// first hit waits, and an open page refreshes at most once per fresh window. A real
// total must stay close to a feed that keeps growing, hence the short fresh window.
const LIST_TOTAL_FRESH_MS = 120_000
const LIST_TOTAL_STALE_MS = 900_000
// A prefix total costs the full widening pass to establish — the Omnipool pot's
// 72.5M activity references reach the candidate ceiling every time — so once a list
// is known to only be countable in part, its total is refreshed less eagerly than a
// complete one instead of re-running that pass every fresh window while the page
// sits open. It cannot be parked indefinitely either: the counted prefix is the
// window's newest rows, so as blocks are indexed it gains rows at the head and loses
// them past the frontier, and a total left to age would eventually number a last
// page the window no longer reaches.
const LIST_TOTAL_PARTIAL_FRESH_MS = 300_000
const LIST_TOTAL_PARTIAL_STALE_MS = 1_800_000
const partialTotalLists = new Map<string, number>()

async function scopedListTotal(accounts: string[], scope: string, query: ScopedListQuery): Promise<ScopedListTotal> {
  const key = scopedListTotalKey(scope, query)
  const now = Date.now()
  for (const [seen, until] of partialTotalLists) if (until <= now) partialTotalLists.delete(seen)
  const partial = partialTotalLists.has(key)
  const result = await cachedSwr(key,
    partial ? LIST_TOTAL_PARTIAL_FRESH_MS : LIST_TOTAL_FRESH_MS,
    partial ? LIST_TOTAL_PARTIAL_STALE_MS : LIST_TOTAL_STALE_MS,
    async (): Promise<ScopedListTotal> => {
      switch (query.tab) {
        case 'activity':
          return countAccountActivity(accounts, query.type ?? 'all', query.action, query.value ?? {}, query.from, query.to)
        // The other three lists are counted by SQL over their own ordering, so
        // their total is always the whole list.
        case 'extrinsics':
          return { total: await countAccountExtrinsics(accounts, scope, query.extrinsic ?? {}, query.from, query.to), complete: true }
        case 'events':
          return { total: await countAccountEvents(accounts, scope, query.event ?? {}, query.from, query.to), complete: true }
        case 'votes':
          return { total: await countScopedVotes(accounts, scope, query.from, query.to), complete: true }
      }
    })
  if (!result.complete) partialTotalLists.set(key, Date.now() + LIST_TOTAL_PARTIAL_STALE_MS)
  return result
}

// undefined = unknown account/tag (404). `total: null` = not even the narrowest
// candidate window could be assembled, so the list has no countable prefix at all.
export async function getAddressListTotal(addressInput: string, query: ScopedListQuery): Promise<ScopedListTotal | undefined> {
  const resolved = await resolveRelatedAccounts(addressInput)
  if (!resolved) return undefined
  return scopedListTotal(resolved.related, `addr:${resolved.norm.accountId}`, query)
}

export async function getTagListTotal(tagId: string, query: ScopedListQuery): Promise<ScopedListTotal | undefined> {
  const members = tagMembers(tagId)
  if (!members) return undefined
  return scopedListTotal(members, `tag:${tagId}`, query)
}

// How many rows the extrinsics list holds: extrinsics the account SIGNED ∪
// extrinsics executed on its behalf, deduplicated per extrinsic exactly as the
// list does (which is why the overlap is subtracted rather than the sum taken).
// Mirrors getAccountExtrinsics' sources and filters; `call`/`result` match the
// DISPLAYED name/result, so on-behalf candidates are enriched here for the same
// reason the list enriches them.
async function countAccountExtrinsics(accounts: string[], cacheKey: string, filters: ExtrinsicListFilters, from?: string, to?: string): Promise<number> {
  const list = sqlAccountList(accounts)
  if (list === "''") return 0
  const bound = timeWindow(from, to) ?? '1'
  return cached(`explorer:extrinsics-total:${cacheKey}:${from ?? ''}:${to ?? ''}:${filterKey(filters)}`, 600_000, async () => {
    const wantSigned = !filters.origin || filters.origin === 'signed'
    const wantProxy = !filters.origin || filters.origin === 'proxy'
    const wantMs = !filters.origin || filters.origin === 'multisig'
    const hasCallFilter = Boolean(filters.call?.trim())
    const hasResultFilter = filters.result === 'success' || filters.result === 'failed'
    const [proxyRows, msStatesAll] = await Promise.all([
      wantProxy ? fetchProxyCandidates(list, bound) : Promise.resolve([] as ProxyCandidateRow[]),
      wantMs ? accountMultisigOps(accounts) : Promise.resolve([] as MultisigOperationState[]),
    ])
    const msWindow = msAnchorWindow(from, to)
    const msStates = msWindow ? msStatesAll.filter(s => msWindow(s.row.anchor_timestamp)) : msStatesAll
    const candidates = [...mergeOnBehalfCandidates(proxyRows, msStates).values()]
    let onBehalfKeys = new Set(candidates.map(c => `${c.block}:${c.extrinsic}`))
    if (hasCallFilter || hasResultFilter) {
      const [proxyInnerMap] = await Promise.all([enrichProxyCandidates(candidates), enrichMultisigCandidates(candidates)])
      const hydration = await hydrateOnBehalfExtrinsics(new Set(candidates.map(c => `${c.block},${c.extrinsic}`)))
      let rows = candidates
        .map(c => buildOnBehalfRow(c, hydration.get(`${c.block}:${c.extrinsic}`), proxyInnerMap))
        .filter((r): r is ExtrinsicSummaryRow => r != null)
      if (hasCallFilter) rows = rows.filter(r => matchesCallFilter(r.display_call_name!, filters.call!))
      if (filters.result === 'success') rows = rows.filter(r => r.display_success === 1)
      if (filters.result === 'failed') rows = rows.filter(r => r.display_success === 0)
      onBehalfKeys = new Set(rows.map(r => `${r.block_height}:${r.extrinsic_index}`))
    }
    if (!wantSigned) return onBehalfKeys.size
    const res = await client.query({
      query: `SELECT uniqExact((block_height, extrinsic_index)) AS c FROM price_data.raw_extrinsics
              WHERE ${bound} ${signedExtrinsicPredicateSql(list, filters)}`,
      query_params: { ...textNameParams('callName', filters.call) },
      format: 'JSONEachRow',
    })
    const signed = Number((await res.json<{ c: string }>())[0]?.c ?? 0)
    return signed + onBehalfKeys.size - await signedOverlapCount(onBehalfKeys, list, bound, filters)
  })
}

// The events list pages distinct (block, event) references out of the account
// activity index, so its total is that same reference set, counted whole. It has
// to collapse the same things the list's reference read does — replayed index
// rows, and one event reached through several related accounts or tag members.
//
// A GROUP BY does that by hashing every reference: on the Omnipool pot's 72.5M
// it costs 5.5 s, 1.55 GiB and fifteen spills to disk. A reference is already a
// pair of UInt32s, so shifting block_height into the high half is a bijection
// into UInt64 — not a hash, no collision to argue about, and no assumption about
// how many events a block may hold — and a roaring bitmap counts that set
// directly, for the same total in 3.7 s, 743 MiB and no spill.
async function countAccountEvents(accounts: string[], cacheKey: string, filters: EventListFilters, from?: string, to?: string): Promise<number> {
  const list = sqlAccountList(accounts)
  if (list === "''") return 0
  const bound = timeWindow(from, to) ?? '1'
  return cached(`explorer:events-total:${cacheKey}:${from ?? ''}:${to ?? ''}:${filterKey(filters)}`, 600_000, async () => {
    const eventFilter = filters.event?.trim() ? textNameFilter('event_name', 'eventName') : ''
    const res = await client.query({
      query: `SELECT groupBitmap(bitShiftLeft(toUInt64(block_height), 32) + toUInt64(event_index)) AS c
              FROM price_data.account_activity_v3
              WHERE ${bound} AND account IN (${list})
                ${eventFilter}`,
      query_params: { ...textNameParams('eventName', filters.event) },
      format: 'JSONEachRow',
      // Structural pots (router/Omnipool/treasury/referral) hold tens of millions
      // of references, so this still reads the whole account even though it no
      // longer materializes it. Four threads keep the biggest of these under four
      // seconds on a cache miss (10-min TTL) while leaving cores for live requests.
      clickhouse_settings: { max_threads: 4 },
    })
    return Number((await res.json<{ c: string }>())[0]?.c ?? 0)
  })
}

// value-event markers (the "Value" chart's flagged big events)
// The largest value-changing events across the account set's history — user
// transfers (in/out), swaps, liquidity moves, cross-chain (XCM) flows and
// money-market liquidations, each valued at its block-time hourly close, never
// the current price — PLUS one marker per big jump of the value line itself,
// so every large move the chart draws carries an annotation of its most likely
// cause (or an explicit 'price' marker when nothing discrete explains it). A
// DCA schedule's many block-hook executions collapse into one marker for the
// whole schedule (summed value, linked to /dca/:id) instead of flooding the chart.
export interface ValueEvent {
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  timestamp: string
  kind: 'transfer-in' | 'transfer-out' | 'swap' | 'liquidity' | 'cross-chain' | 'price' | 'other'
  // 'price' markers carry the SIGNED bucket delta (no discrete event to value).
  valueUsd: number
  // null only for 'price' markers — a market move has no single asset.
  asset: AssetRef | null
  counterparty: AccountRef | null
  // Cross-chain flow direction (inbound credit vs outbound send).
  direction?: 'in' | 'out'
  // false when a cross-chain marker's (block,eventIndex) has no matching row in
  // the XCM activity feed (reserved-account credits, non-contiguous walk-backs):
  // the marker still annotates the jump but renders WITHOUT a dead detail link.
  linkable?: boolean
  // Traded pair for swap markers (resolved for the chosen markers only);
  // `asset` stays the value-bearing leg the marker was scored on.
  assetIn?: AssetRef | null
  assetOut?: AssetRef | null
  // Raw token amount in `asset` decimals — only on markers whose USD value is
  // exactly one event's leg (summed markers would pair a total with one leg).
  amount?: string
}

const VALUE_EVENT_TRANSFER_NAMES = ['Balances.Transfer', 'Tokens.Transfer', 'Currencies.Transferred']
const VALUE_EVENT_LIQUIDITY_NAMES = ['XYK.LiquidityAdded', 'XYK.LiquidityRemoved']
// Cross-chain movements are indexed as deposit/withdraw events, not transfers:
// an inbound XCM credit is a hook-context Currencies/Tokens.Deposited in a
// barrier block (XCM_BARRIER_EVENTS); an outbound send is the Currencies/Tokens.
// Withdrawn of an XTokens/PolkadotXcm extrinsic (user-sent) or a hook-context
// one in a barrier block (remote-initiated pull).
const VALUE_EVENT_XCM_IN_NAMES = ['Currencies.Deposited', 'Tokens.Deposited']
const VALUE_EVENT_XCM_OUT_NAMES = ['Currencies.Withdrawn', 'Tokens.Withdrawn']
const VALUE_EVENT_DEFAULT_LIMIT = 12
// Jump detection: a point-to-point move of the reconstructed value series is
// "big" when it clears both an absolute floor and a fraction of the series'
// peak — dust accounts don't spam markers, whale noise doesn't drown them. The
// same threshold gates the value-fill so a flat account never surfaces its dust.
const VALUE_JUMP_MIN_USD = 1_000
const VALUE_JUMP_PEAK_FRACTION = 0.05
// A jump is "explained" by its window's dominant cause when that cause's summed
// USD reaches this fraction of |Δ|; below it the marker degrades to an honest
// 'price' annotation instead of blaming an incidental small event. Calibrated
// on real accounts: a drip-style LP unwind sums to ~40% of its bucket's drop.
const VALUE_JUMP_EXPLAIN_FRACTION = 0.3
// Top candidate rows fetched per jump window. Per-kind sums saturate well below
// this for real accounts; it bounds the read on whale windows.
const VALUE_JUMP_WINDOW_ROWS = 40

// Threshold below which a value-line move (or a fill event) is not "significant"
// for this account: an absolute floor OR a fraction of the series' peak.
function valueJumpThreshold(series: number[]): number {
  let peak = 0
  for (const v of series) peak = Math.max(peak, Math.abs(v))
  return Math.max(VALUE_JUMP_MIN_USD, peak * VALUE_JUMP_PEAK_FRACTION)
}

// The value line's biggest point-to-point moves: |Δ| over the threshold, ranked
// by |Δ|, capped at the marker budget. Each jump's block window is the half-open
// span between its two points' end-of-bucket blocks — exactly the blocks whose
// events the delta reflects. The FINAL segment is skipped: the chart pins its
// last point to live net worth (getAddressHistory/getTag overwrite it), so a
// delta computed here against the un-pinned cached series could disagree with
// the drawn line.
interface ValueJumpWindow { delta: number; startBlock: number; endBlock: number; timestamp: string }
function selectValueJumps(
  history: { portfolioSeries: number[]; portfolioDates: string[]; portfolioBlocks: number[] } | null,
  from: string | undefined,
  to: string | undefined,
  maxJumps: number,
): ValueJumpWindow[] {
  if (!history) return []
  const { portfolioSeries: series, portfolioDates: dates, portfolioBlocks: blocks } = history
  if (series.length < 2 || blocks.length !== series.length) return []
  const threshold = valueJumpThreshold(series)
  const jumps: ValueJumpWindow[] = []
  // i < length-1: the last delta lands on the pinned point — don't flag it.
  for (let i = 1; i < series.length - 1; i++) {
    const delta = series[i] - series[i - 1]
    if (Math.abs(delta) < threshold || !(blocks[i] > blocks[i - 1])) continue
    const day = (dates[i] ?? '').slice(0, 10)
    if ((from && day < from) || (to && day > to)) continue
    jumps.push({ delta, startBlock: blocks[i - 1], endBlock: blocks[i], timestamp: dates[i] })
  }
  jumps.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
  return jumps.slice(0, maxJumps)
}

// SQL: per-asset raw→token scale (10^decimals) for exact-index value ranking.
function assetDecimalsPowSql(assetIdExpr: string): string {
  const assets = allExplorerAssets()
  const ids = assets.map(a => a.assetId).join(',')
  const decimals = assets.map(a => a.decimals).join(',')
  return `pow(10, transform(toUInt32(${assetIdExpr}), [${ids || '0'}], [${decimals || '12'}], 12))`
}

function valueEventKind(eventName: string): ValueEvent['kind'] {
  if (SWAP_EVENTS.includes(eventName)) return 'swap'
  if (VALUE_EVENT_LIQUIDITY_NAMES.includes(eventName)) return 'liquidity'
  return 'other'
}

interface ValueEventCandidateRow {
  block_height: number
  event_index: number
  extrinsic_index: number | null
  event_name: string
  ts: string
  asset_id: number
  amount: string
  value_usd: number
}

// Value-chart markers for an explicit account set, bounded to the optional day
// window (default: the full indexed range, matching the value-history chart's
// span). Two selection passes share one candidate machinery:
//  - the globally largest-USD events (transfers, swaps, liquidity), each valued
//    at its block-time hourly close;
//  - one marker per big JUMP of the reconstructed value series itself, so a
//    large move never renders unannotated: each jump's block window is scored
//    per cause (transfer / cross-chain / liquidity / swap) and the dominant one
//    wins, or an explicit 'price' marker when no discrete activity plausibly
//    explains the move.
// All event reads are bounded account_activity_v3 scans (sort key leads with
// account) valued via the ASOF hourly-close join the value filters use.
async function getAccountValueEvents(accounts: string[], cacheKey: string, from?: string, to?: string, limit = VALUE_EVENT_DEFAULT_LIMIT, historyAccounts: string[] = accounts): Promise<ValueEvent[]> {
  const list = sqlAccountList(accounts)
  if (list === "''") return []
  return cached(`explorer:value-events:${cacheKey}:${from ?? ''}:${to ?? ''}:${limit}`, 600_000, async () => {
    const bound = timeWindow(from, to) ?? '1'
    // The value series the chart draws (cache shared with getAddressHistory/
    // getTag): its biggest deltas are the jumps that must end up annotated.
    const history = await getAccountHistoryShared(historyAccounts, cacheKey).catch(() => null)
    const jumps = selectValueJumps(history, from, to, limit)
    const windows = [...jumps].sort((x, y) => x.startBlock - y.startBlock)
    const windowId = new Map(windows.map((w, i) => [w, i + 1]))
    const windowCondFor = (col: string) => windows.map(w => `(${col} > ${w.startBlock} AND ${col} <= ${w.endBlock})`).join(' OR ') || '0'
    // Fetch well past the requested markers: mirror legs (~half the transfer
    // candidates), pool/MM-leg counterparties and same-extrinsic swap echoes are
    // dropped below and must not leave the chart short.
    const fetch = limit * 4
    const closes = historicalClosesRelationSql()
    const namedEvents = [...SWAP_EVENTS, ...VALUE_EVENT_LIQUIDITY_NAMES].map(n => `'${n}'`).join(',')
    const transferNames = VALUE_EVENT_TRANSFER_NAMES.map(n => `'${n}'`).join(',')
    const xcmInNames = VALUE_EVENT_XCM_IN_NAMES.map(n => `'${n}'`).join(',')
    const xcmOutNames = VALUE_EVENT_XCM_OUT_NAMES.map(n => `'${n}'`).join(',')
    // Cross-chain gates, bounded to the jump windows: inbound credits and
    // remote-initiated pulls execute in hook context inside a MessageQueue.
    // Processed block; user-sent outbound withdrawals live in an XTokens/
    // pallet-xcm extrinsic (see VALUE_EVENT_XCM_* above).
    const xcmSentEventNames = XCM_SENT_EVENTS_SQL
    const xcmBarrierBlocksSql = `SELECT block_height FROM ${xcmEventActivityTable()}
                    WHERE event_name IN (${XCM_BARRIER_EVENTS_SQL}) AND extrinsic_index IS NULL AND (${windowCondFor('block_height')})`
    const xcmSentPairsSql = `SELECT block_height, assumeNotNull(extrinsic_index) FROM price_data.raw_xcm_activity
                    WHERE source_kind = 'event' AND name IN (${xcmSentEventNames})
                      AND extrinsic_index IS NOT NULL AND (${windowCondFor('block_height')})`
    const [eventRes, windowRes, xcmSentRes] = await Promise.all([
      client.query({
        query: `
          SELECT block_height, event_index, any(extrinsic_index) AS extrinsic_index, any(event_name) AS event_name,
                 any(ts) AS ts, any(asset_id) AS asset_id, any(amount) AS amount, any(value_usd) AS value_usd
          FROM (
            SELECT a.block_height AS block_height, a.event_index AS event_index, a.extrinsic_index AS extrinsic_index,
                   a.event_name AS event_name, toString(a.block_timestamp) AS ts,
                   a.asset_id AS asset_id, toString(a.amount) AS amount,
                   toFloat64(a.amount) / ${assetDecimalsPowSql('a.asset_id')} * value_price.close AS value_usd
            FROM price_data.account_activity_v3 AS a FINAL
            ASOF LEFT JOIN ${closes} value_price
              ON value_price.asof_join_key = toUInt8(isNotNull(a.block_timestamp))
             AND value_price.asset_id = toUInt32(a.asset_id)
             AND value_price.price_time <= a.block_timestamp
            WHERE a.account IN (${list}) AND ${bound}
              AND a.has_amount = 1
              AND (a.event_name IN (${namedEvents})
                OR (a.event_name IN (${transferNames}) AND NOT a.is_module_transfer))
          )
          GROUP BY block_height, event_index
          HAVING value_usd > 0
          ORDER BY value_usd DESC
          LIMIT {fetch:UInt32}`,
        query_params: { fetch }, format: 'JSONEachRow',
        // Whale/structural accounts carry millions of indexed rows; spill the
        // event-identity dedup to disk instead of hitting the memory ceiling.
        clickhouse_settings: { max_bytes_before_external_group_by: '1500000000' },
      }),
      // Per-jump-window candidates: the same families the global pass ranks,
      // EXTENDED with the cross-chain deposit/withdraw events (gated to real
      // XCM contexts). Top rows per window; the per-cause sums drive the jump
      // attribution.
      !windows.length ? Promise.resolve(null) : client.query({
        query: `
          SELECT w, block_height, event_index, any(extrinsic_index) AS extrinsic_index, any(event_name) AS event_name,
                 any(ts) AS ts, any(asset_id) AS asset_id, any(amount) AS amount, any(value_usd) AS value_usd
          FROM (
            SELECT multiIf(${windows.map((w, i) => `a.block_height <= ${w.endBlock}, ${i + 1}`).join(', ')}, 0) AS w,
                   a.block_height AS block_height, a.event_index AS event_index, a.extrinsic_index AS extrinsic_index,
                   a.event_name AS event_name, toString(a.block_timestamp) AS ts,
                   a.asset_id AS asset_id, toString(a.amount) AS amount,
                   toFloat64(a.amount) / ${assetDecimalsPowSql('a.asset_id')} * value_price.close AS value_usd
            FROM price_data.account_activity_v3 AS a FINAL
            ASOF LEFT JOIN ${closes} value_price
              ON value_price.asof_join_key = toUInt8(isNotNull(a.block_timestamp))
             AND value_price.asset_id = toUInt32(a.asset_id)
             AND value_price.price_time <= a.block_timestamp
            WHERE a.account IN (${list}) AND (${windowCondFor('a.block_height')})
              AND a.has_amount = 1
              AND (a.event_name IN (${namedEvents})
                OR (a.event_name IN (${transferNames}) AND NOT a.is_module_transfer)
                OR (a.event_name IN (${xcmInNames}) AND a.extrinsic_index IS NULL AND a.block_height IN (${xcmBarrierBlocksSql}))
                OR (a.event_name IN (${xcmOutNames}) AND ((a.extrinsic_index IS NULL AND a.block_height IN (${xcmBarrierBlocksSql}))
                  OR (a.extrinsic_index IS NOT NULL AND (a.block_height, assumeNotNull(a.extrinsic_index)) IN (${xcmSentPairsSql})))))
          )
          GROUP BY w, block_height, event_index
          HAVING value_usd > 0
          ORDER BY w, value_usd DESC
          LIMIT ${VALUE_JUMP_WINDOW_ROWS} BY w`,
        format: 'JSONEachRow',
        clickhouse_settings: { max_bytes_before_external_group_by: '1500000000' },
      }),
      // Sent-event refs of the windows' outbound XCM extrinsics: a cross-chain
      // marker links to the XCM activity row, which the feed keys by this event.
      !windows.length ? Promise.resolve(null) : client.query({
        query: `SELECT block_height, assumeNotNull(extrinsic_index) AS extrinsic_index,
                       assumeNotNull(event_index) AS event_index, name
                FROM price_data.raw_xcm_activity
                WHERE source_kind = 'event' AND name IN (${xcmSentEventNames})
                  AND extrinsic_index IS NOT NULL AND event_index IS NOT NULL AND (${windowCondFor('block_height')})`,
        format: 'JSONEachRow',
      }),
    ])
    const rows = await eventRes.json<ValueEventCandidateRow>()
    const windowRows = windowRes ? await windowRes.json<ValueEventCandidateRow & { w: number }>() : []
    const xcmSentRows = xcmSentRes ? await xcmSentRes.json<{ block_height: number; extrinsic_index: number; event_index: number; name: string }>() : []

    // Transfer direction + counterparty from the transfer read model (the v3
    // index carries no from/to): a bounded point lookup for at most `fetch`
    // plus the window candidates' refs.
    const transferRows = rows.filter(r => VALUE_EVENT_TRANSFER_NAMES.includes(r.event_name))
    const windowTransferRows = windowRows.filter(r => VALUE_EVENT_TRANSFER_NAMES.includes(r.event_name))
    const legByRef = new Map<string, { from: string; to: string }>()
    if (transferRows.length || windowTransferRows.length) {
      const tuples = [...new Set([...transferRows, ...windowTransferRows].map(r => `(${r.block_height},${r.event_index})`))].join(',')
      const legRes = await client.query({
        query: `SELECT block_height, event_index, any(from_account) AS from_account, any(to_account) AS to_account
                FROM price_data.account_transfer_activity
                WHERE account IN (${list}) AND (block_height, event_index) IN (${tuples})
                GROUP BY block_height, event_index`,
        format: 'JSONEachRow',
      })
      for (const r of await legRes.json<{ block_height: number; event_index: number; from_account: string; to_account: string }>()) {
        legByRef.set(`${r.block_height}:${r.event_index}`, { from: r.from_account.toLowerCase(), to: r.to_account.toLowerCase() })
      }
    }
    const scoped = new Set(accounts.map(a => a.toLowerCase()))
    // Pool accounts: a transfer whose counterparty is one of these is a swap/LP
    // leg represented elsewhere, never a user transfer marker (and never a
    // cross-chain one).
    const plumbing = new Set(ammPoolAccounts())
    // The same movement is often indexed twice (Currencies.Transferred mirrors
    // Tokens.Transfer): keep the highest-priority mirror per movement identity —
    // the dedupeTransferEvents rule, applied post-lookup since identity needs
    // from/to. Global and window candidates keep separate maps: a mirror that
    // only cleared one fetch's value cut must not suppress the other's row.
    const mirrorKey = (r: ValueEventCandidateRow, leg: { from: string; to: string }) =>
      `${r.block_height}|${r.extrinsic_index ?? -1}|${r.asset_id}|${leg.from}|${leg.to}|${r.amount}`
    const buildMirrorPriority = (candidates: ValueEventCandidateRow[]) => {
      const priority = new Map<string, number>()
      for (const r of candidates) {
        const leg = legByRef.get(`${r.block_height}:${r.event_index}`)
        if (!leg) continue
        const key = mirrorKey(r, leg)
        const p = transferEventPriority(r.event_name)
        if (p > (priority.get(key) ?? 0)) priority.set(key, p)
      }
      return priority
    }
    const mirrorPriority = buildMirrorPriority(transferRows)
    // Direction/counterparty resolution shared by the global markers and the
    // window scoring: null = drop (mirror echo, internal shuffle, plumbing leg),
    // 'other' = real transfer whose legs the read model missed.
    const resolveTransfer = (r: ValueEventCandidateRow, priority: Map<string, number>): { kind: 'transfer-in' | 'transfer-out'; counterparty: string } | 'other' | null => {
      const leg = legByRef.get(`${r.block_height}:${r.event_index}`)
      // Read-model miss: still a real transfer, direction just unknown.
      if (!leg) return 'other'
      if (transferEventPriority(r.event_name) !== priority.get(mirrorKey(r, leg))) return null
      const fromIn = scoped.has(leg.from), toIn = scoped.has(leg.to)
      // Internal shuffles between the scoped accounts change no value; a pool
      // COUNTERPARTY marks a swap or LP leg represented elsewhere (the viewed
      // set itself may be such an account — its legs are its activity, the
      // feed's viewingPool exception).
      if (fromIn && toIn) return null
      const counterparty = toIn ? leg.from : leg.to
      if (plumbing.has(counterparty)) return null
      return { kind: toIn ? 'transfer-in' : 'transfer-out', counterparty }
    }

    const out: ValueEvent[] = []
    const seenSwapExtrinsics = new Set<string>()
    for (const r of rows) {
      const base = {
        blockHeight: Number(r.block_height), eventIndex: Number(r.event_index),
        extrinsicIndex: r.extrinsic_index == null ? null : Number(r.extrinsic_index),
        timestamp: r.ts, valueUsd: +Number(r.value_usd).toFixed(2), asset: asset(r.asset_id),
        ...(r.amount && r.amount !== '0' ? { amount: r.amount } : {}),
      }
      if (VALUE_EVENT_TRANSFER_NAMES.includes(r.event_name)) {
        const resolved = resolveTransfer(r, mirrorPriority)
        if (!resolved) continue
        if (resolved === 'other') { out.push({ ...base, kind: 'other', counterparty: null }); continue }
        out.push({ ...base, kind: resolved.kind, counterparty: accountRef(resolved.counterparty) })
        continue
      }
      const kind = valueEventKind(r.event_name)
      if (kind === 'swap' && r.extrinsic_index != null) {
        // Router.Executed and the pool's own *Executed describe one trade; rows
        // arrive value-sorted, so the largest leg per extrinsic wins.
        const key = `${r.block_height}:${r.extrinsic_index}`
        if (seenSwapExtrinsics.has(key)) continue
        seenSwapExtrinsics.add(key)
      }
      out.push({ ...base, kind, counterparty: null })
    }
    // Jump attribution: score every window candidate under its cause (mirror-
    // deduped, echo-collapsed), then give each selected jump ONE marker — the
    // direction-consistent cause with the largest summed USD when it plausibly
    // explains |Δ|, an explicit 'price' marker otherwise.
    const jumpMarkers: ValueEvent[] = []
    if (jumps.length) {
      const isXcmCandidate = (name: string) => VALUE_EVENT_XCM_IN_NAMES.includes(name) || VALUE_EVENT_XCM_OUT_NAMES.includes(name)
      const xcmDirOf = (name: string): 'in' | 'out' => VALUE_EVENT_XCM_IN_NAMES.includes(name) ? 'in' : 'out'
      // Currencies.* mirrors Tokens.* for the same movement — Currencies wins,
      // and its event index matches the row the XCM activity feed keeps.
      const xcmMirrorKey = (r: ValueEventCandidateRow) => `${r.block_height}|${r.extrinsic_index ?? -1}|${r.asset_id}|${r.amount}|${xcmDirOf(r.event_name)}`
      const xcmEventPriority = (name: string) => name.startsWith('Currencies.') ? 2 : 1
      const windowMirrorPriority = buildMirrorPriority(windowTransferRows)
      const xcmPriority = new Map<string, number>()
      for (const r of windowRows) {
        if (!isXcmCandidate(r.event_name)) continue
        const key = xcmMirrorKey(r)
        const p = xcmEventPriority(r.event_name)
        if (p > (xcmPriority.get(key) ?? 0)) xcmPriority.set(key, p)
      }
      // Outbound markers point at the XTokens/pallet-xcm Sent event — the row
      // the activity feed keeps (the legacy event wins over its mirror), so the
      // marker's link resolves; the withdrawal is just its funding leg.
      const xcmSentByExtrinsic = new Map<string, { eventIndex: number; name: string }>()
      for (const r of xcmSentRows) {
        const key = `${r.block_height}:${r.extrinsic_index}`
        const cur = xcmSentByExtrinsic.get(key)
        if (!cur || (!isXTokensSentEvent(cur.name) && isXTokensSentEvent(r.name))) {
          xcmSentByExtrinsic.set(key, { eventIndex: Number(r.event_index), name: r.name })
        }
      }

      interface JumpCause { score: number; best: ValueEvent | null; bestValue: number; hits: number }
      const causes = new Map<string, JumpCause>() // `${w}:<class>`
      const bump = (key: string, value: number, event: ValueEvent, mode: 'sum' | 'max') => {
        const cur = causes.get(key) ?? { score: 0, best: null, bestValue: 0, hits: 0 }
        cur.score = mode === 'sum' ? cur.score + value : Math.max(cur.score, value)
        cur.hits += 1
        if (value > cur.bestValue) { cur.best = event; cur.bestValue = value }
        causes.set(key, cur)
      }
      // Value-descending so per-trade/per-execution dedup keeps the largest leg.
      const sortedWindowRows = [...windowRows].sort((x, y) => Number(y.value_usd) - Number(x.value_usd))
      for (const r of sortedWindowRows) {
        const w = Number(r.w)
        if (!w) continue
        const value = Number(r.value_usd)
        const base: ValueEvent = {
          blockHeight: Number(r.block_height), eventIndex: Number(r.event_index),
          extrinsicIndex: r.extrinsic_index == null ? null : Number(r.extrinsic_index),
          timestamp: r.ts, kind: 'other', valueUsd: +value.toFixed(2), asset: asset(r.asset_id), counterparty: null,
          ...(r.amount && r.amount !== '0' ? { amount: r.amount } : {}),
        }
        if (VALUE_EVENT_TRANSFER_NAMES.includes(r.event_name)) {
          const resolved = resolveTransfer(r, windowMirrorPriority)
          if (!resolved || resolved === 'other') continue
          bump(`${w}:${resolved.kind}`, value, { ...base, kind: resolved.kind, counterparty: accountRef(resolved.counterparty) }, 'sum')
          continue
        }
        if (isXcmCandidate(r.event_name)) {
          if (xcmEventPriority(r.event_name) !== xcmPriority.get(xcmMirrorKey(r))) continue
          const direction = xcmDirOf(r.event_name)
          const sent = direction === 'out' && r.extrinsic_index != null
            ? xcmSentByExtrinsic.get(`${r.block_height}:${r.extrinsic_index}`) : undefined
          bump(`${w}:cross-chain-${direction}`, value,
            { ...base, ...(sent ? { eventIndex: sent.eventIndex } : {}), kind: 'cross-chain', direction }, 'sum')
          continue
        }
        // A swap between priced assets is value-neutral churn and must never
        // "explain" a jump. On Basilisk every asset a swap can land in is priced
        // by its own feed — the one token that is not (the XYK share) is minted by
        // a liquidity add, never bought — so no swap moves the reconstructed line.
        if (SWAP_EVENTS.includes(r.event_name)) continue
        // Liquidity add/remove — direction-agnostic: LP flows are value shuffles
        // whose reconstructed line can move either way (drip unwinds, principal
        // entering/leaving the LP-valued curve).
        bump(`${w}:liquidity`, value, { ...base, kind: 'liquidity' }, 'sum')
      }

      for (const jump of jumps) {
        const w = windowId.get(jump)!
        // Direction-consistent causes only: an inflow can't explain a drop.
        const candidateKeys = jump.delta > 0
          ? [`${w}:transfer-in`, `${w}:cross-chain-in`, `${w}:liquidity`, `${w}:swap`]
          : [`${w}:transfer-out`, `${w}:cross-chain-out`, `${w}:liquidity`, `${w}:swap`]
        let winner: { key: string; cause: JumpCause } | null = null
        for (const key of candidateKeys) {
          const cause = causes.get(key)
          if (cause && (!winner || cause.score > winner.cause.score)) winner = { key, cause }
        }
        const explained = winner != null && winner.cause.score >= Math.abs(jump.delta) * VALUE_JUMP_EXPLAIN_FRACTION
        if (explained && winner!.key.startsWith(`${w}:dca:`)) {
          // Schedule covers this jump via its reserved /dca/:id marker — no
          // extra marker here.
          continue
        }
        if (explained && winner!.cause.best) {
          // A multi-event cause sums its USD but `amount` belongs to one leg —
          // drop it rather than pair a window total with a single leg's tokens.
          const best = winner!.cause.best
          jumpMarkers.push(winner!.cause.hits === 1 ? best : { ...best, amount: undefined })
        } else {
          // Nothing discrete accounts for the move — an honest market-move
          // marker carrying the signed delta, pinned to the jump's own point.
          jumpMarkers.push({
            blockHeight: jump.endBlock, eventIndex: 0, extrinsicIndex: null, timestamp: jump.timestamp,
            kind: 'price', valueUsd: +jump.delta.toFixed(2), asset: null, counterparty: null,
          })
        }
      }

      // Cross-chain link verification: an inbound credit / remote-initiated
      // outbound pull marker links to /cross-chain/<block>-e<idx>, which
      // ActivityDetail resolves against the XCM feed's reconstruction
      // (xcmInRowsForBlocks / xcmOutRemoteRowsForBlocks) — NOT the raw deposit/
      // withdraw event. That reconstruction skips reserved accounts, walks back
      // contiguously from the barrier, and mirror-dedups, so the raw event index
      // often has no feed row (deterministic for treasury/sovereign tags). Verify
      // each such marker against the actual feed rows; keep the link only on a
      // match (re-pointing the index to the feed's), else render it unlinked.
      const inBlocks = [...new Set(jumpMarkers.filter(m => m.kind === 'cross-chain' && m.direction === 'in').map(m => m.blockHeight))]
      const outBlocks = [...new Set(jumpMarkers.filter(m => m.kind === 'cross-chain' && m.direction === 'out' && m.extrinsicIndex == null).map(m => m.blockHeight))]
      if (inBlocks.length || outBlocks.length) {
        const prices = await ensurePrices()
        const whoIn = new Set(accounts)
        const [inRows, outRows] = await Promise.all([
          inBlocks.length ? xcmInRowsForBlocks(inBlocks, prices, whoIn) : Promise.resolve([]),
          outBlocks.length ? xcmOutRemoteRowsForBlocks(outBlocks, prices, whoIn) : Promise.resolve([]),
        ])
        // Feed row index keyed by block+asset (one credit per asset per block in
        // practice); re-point the marker to that index so the detail link resolves.
        const feedIndex = new Map<string, number>()
        for (const r of [...inRows, ...outRows]) {
          if (r.eventIndex != null && r.asset) feedIndex.set(`${r.blockHeight}:${r.asset.assetId}`, r.eventIndex)
        }
        for (const m of jumpMarkers) {
          if (m.kind !== 'cross-chain') continue
          if (m.direction === 'out' && m.extrinsicIndex != null) continue // user-sent path already resolves
          const idx = m.asset ? feedIndex.get(`${m.blockHeight}:${m.asset.assetId}`) : undefined
          if (idx != null) m.eventIndex = idx
          else m.linkable = false
        }
      }
    }

    out.sort((x, y) => y.valueUsd - x.valueUsd)
    // Selection order: one marker per big jump (largest |Δ| first — annotating
    // distinct moves beats raw event size), then a value-fill of the remaining
    // budget. The fill is GATED to the account's own significance threshold, so
    // a flat account never surfaces its dust; a jump that IS a top event dedups
    // by identity.
    const fillThreshold = history ? valueJumpThreshold(history.portfolioSeries) : VALUE_JUMP_MIN_USD
    const chosen: ValueEvent[] = []
    const usedRefs = new Set<string>()
    const take = (e: ValueEvent) => {
      if (chosen.length >= limit) return
      const ref = `${e.blockHeight}:${e.eventIndex}`
      if (usedRefs.has(ref)) return
      usedRefs.add(ref)
      chosen.push(e)
    }
    for (const e of jumpMarkers) take(e)
    // Value-fill: only genuinely significant events (≥ this account's jump
    // threshold). 'price'/'cross-chain' jump markers already annotate the moves;
    // this backfills large discrete events that weren't themselves a jump.
    for (const e of out) if (e.valueUsd >= fillThreshold) take(e)

    // Pair enrichment for the few chosen markers: a swap hover should say which
    // asset traded for which, a DCA hover its schedule's pair. Swap markers were
    // scored on one leg row; re-read the trade's rows and prefer the router net
    // summary so multi-hop routes show the true end-to-end pair.
    const swapMarkers = chosen.filter(e => e.kind === 'swap')
    if (swapMarkers.length) {
      const blocks = [...new Set(swapMarkers.map(e => e.blockHeight))]
      const res = await client.query({
        query: `SELECT block_height, event_index, extrinsic_index, event_name, asset_in, asset_out
                FROM price_data.swap_activity WHERE block_height IN (${blocks.join(',')})`,
        format: 'JSONEachRow',
      })
      const rows = await res.json<{ block_height: number; event_index: number; extrinsic_index: number | null; event_name: string; asset_in: number; asset_out: number }>()
      for (const e of swapMarkers) {
        const inTrade = rows.filter(r => Number(r.block_height) === e.blockHeight && (e.extrinsicIndex != null
          ? r.extrinsic_index != null && Number(r.extrinsic_index) === e.extrinsicIndex
          : Number(r.event_index) === e.eventIndex))
        const rep = inTrade.find(r => isRouterNet(r.event_name))
          ?? inTrade.find(r => Number(r.event_index) === e.eventIndex)
          ?? inTrade[0]
        if (rep) { e.assetIn = asset(Number(rep.asset_in)); e.assetOut = asset(Number(rep.asset_out)) }
      }
    }
    // Chronological order for rendering.
    return chosen.sort((x, y) => x.blockHeight - y.blockHeight || x.eventIndex - y.eventIndex)
  })
}

export async function getAddressValueEvents(addressInput: string, from?: string, to?: string): Promise<ValueEvent[] | null> {
  const resolved = await resolveRelatedAccounts(addressInput)
  if (!resolved) return null
  return getAccountValueEvents(resolved.related, `addr:${resolved.norm.accountId}`, from, to)
}

export async function getTagValueEvents(tagId: string, from?: string, to?: string): Promise<ValueEvent[] | null> {
  const members = tagMembers(tagId)
  if (!members) return null
  // Jump detection reads the SAME series getTag charts, under the same shared cache
  // key, so a jump is attributed over exactly the accounts the series was built from.
  const historyAccounts = [...new Set(members)]
  return getAccountValueEvents(historyAccounts, `tag:${tagId}`, from, to, VALUE_EVENT_DEFAULT_LIMIT, historyAccounts)
}

// ───────────────── on-behalf extrinsic candidates (request-time) ─────────────────
// Proxy.proxy/proxy_announced calls whose `real` is the account
// (proxy_call_activity, MV-fed) and this account's multisig operations
// (accountMultisigOps), merged into a single per-(block,extrinsic) candidate:
// multisig beats proxy when both land on the same extrinsic (matches the old
// union's `origin_kind ASC` tiebreak, since 'multisig' < 'proxy'), and within
// a kind the lowest call_address / call_hash wins (matches the old per-branch
// `LIMIT 1 BY` after `ORDER BY ..., call_address|call_hash`).
interface ProxyCandidateRow { block: number; extrinsic: number; callAddress: string; proxyCallName: string }
interface OnBehalfCandidate {
  block: number
  extrinsic: number
  kind: 'proxy' | 'multisig'
  callAddress?: string
  proxyCallName?: string
  opState?: MultisigOperationState
}

async function fetchProxyCandidates(list: string, bound: string): Promise<ProxyCandidateRow[]> {
  const res = await client.query({
    query: `SELECT block_height AS block, extrinsic_index AS extrinsic, call_address AS callAddress, proxy_call_name AS proxyCallName
            FROM price_data.proxy_call_activity
            WHERE real_account IN (${list}) AND ${bound}
            ORDER BY ingested_at DESC
            LIMIT 1 BY block_height, extrinsic_index, call_address`,
    format: 'JSONEachRow',
  })
  return res.json<ProxyCandidateRow>()
}

function mergeOnBehalfCandidates(proxyRows: ProxyCandidateRow[], msStates: MultisigOperationState[]): Map<string, OnBehalfCandidate> {
  const map = new Map<string, OnBehalfCandidate>()
  for (const p of proxyRows) {
    const key = `${p.block}:${p.extrinsic}`
    const existing = map.get(key)
    if (existing && (existing.kind === 'multisig' || existing.callAddress! <= p.callAddress)) continue
    map.set(key, { block: p.block, extrinsic: p.extrinsic, kind: 'proxy', callAddress: p.callAddress, proxyCallName: p.proxyCallName })
  }
  for (const s of msStates) {
    const key = `${s.row.anchor_block_height}:${s.row.anchor_extrinsic_index}`
    const existing = map.get(key)
    if (existing?.kind === 'multisig' && existing.opState!.row.call_hash <= s.row.call_hash) continue
    map.set(key, { block: s.row.anchor_block_height, extrinsic: s.row.anchor_extrinsic_index, kind: 'multisig', opState: s })
  }
  return map
}

// Bounds an account's multisig ops by the request's date window, comparing
// against each op's anchor_timestamp (unix seconds). block_timestamp — and so
// this server's ClickHouse session — runs UTC (verified against the parity
// captures' timeline strings; server.ts asserts `SELECT timezone() = 'UTC'` at
// startup and exits if not), so Date.parse(`${date}T00:00:00Z`) reproduces
// the same boundary the SQL timeWindow() applies to raw block_timestamp.
function msAnchorWindow(from?: string, to?: string): ((ts: number) => boolean) | null {
  const fromTs = from && DATE_RE.test(from) ? Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000) : null
  const toTs = to && DATE_RE.test(to) ? Math.floor(Date.parse(`${to}T00:00:00Z`) / 1000) + 86400 : null
  if (fromTs == null && toTs == null) return null
  return ts => (fromTs == null || ts >= fromTs) && (toTs == null || ts < toTs)
}

// raw_calls rows for a (block,extrinsic) tuple set, deduped like every other
// ReplacingMergeTree read here. Shared by proxy inner-call resolution and
// multisig call/child/origin resolution — both need every call address inside
// their candidate extrinsics, not just the wrapper's own row.
interface RawCallLookupRow { block: number; extrinsic: number; callAddress: string; callName: string; success: number | null; originJson: string | null; errorJson: string | null }
async function loadRawCallsForTuples(tuples: Set<string>): Promise<RawCallLookupRow[]> {
  const out: RawCallLookupRow[] = []
  const keys = [...tuples]
  for (let i = 0; i < keys.length; i += 10_000) {
    const inList = keys.slice(i, i + 10_000).map(k => `(${k})`).join(',')
    const res = await client.query({
      query: `SELECT block_height AS block, assumeNotNull(extrinsic_index) AS extrinsic, call_address AS callAddress,
                     call_name AS callName, success, origin_json AS originJson, error_json AS errorJson
              FROM price_data.raw_calls
              WHERE (block_height, assumeNotNull(extrinsic_index)) IN (${inList}) AND extrinsic_index IS NOT NULL
              ORDER BY ingested_at DESC
              LIMIT 1 BY block_height, assumeNotNull(extrinsic_index), call_address`,
      format: 'JSONEachRow',
    })
    out.push(...await res.json<RawCallLookupRow>())
  }
  return out
}

async function loadSignersForTuples(tuples: Set<string>): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const keys = [...tuples]
  for (let i = 0; i < keys.length; i += 10_000) {
    const inList = keys.slice(i, i + 10_000).map(k => `(${k})`).join(',')
    const res = await client.query({
      query: `SELECT block_height AS block, extrinsic_index AS extrinsic, lower(coalesce(signer, effective_signer)) AS signer
              FROM price_data.raw_extrinsics
              WHERE (block_height, extrinsic_index) IN (${inList})
              ORDER BY ingested_at DESC
              LIMIT 1 BY block_height, extrinsic_index`,
      format: 'JSONEachRow',
    })
    for (const s of await res.json<{ block: number; extrinsic: number; signer: string | null }>()) {
      if (s.signer) out.set(`${s.block}:${s.extrinsic}`, s.signer)
    }
  }
  return out
}

// origin_json's Signed variant, exactly as the retired multisig_operations
// derivation job parsed it (raw_extrinsics signer is the fallback for the
// historical rows that predate origin_json).
export function signedOrigin(originJson: string | null): string | null {
  if (!originJson) return null
  try {
    const o = JSON.parse(originJson) as { value?: { __kind?: string; value?: string } }
    return o.value?.__kind === 'Signed' && typeof o.value.value === 'string' ? o.value.value.toLowerCase() : null
  } catch { return null }
}

// MultisigCallInfo[] for a set of multisig op touchpoints, built exactly like
// the deleted derivation job did: multisig_call_activity for the wrapper call
// (threshold/otherSignatories), raw_calls for every call in those same
// extrinsics (own success/origin + the dispatched child's name/success).
async function loadMultisigCallInfo(tupleKeys: Set<string>): Promise<MultisigCallInfo[]> {
  const calls: MultisigCallInfo[] = []
  const keys = [...tupleKeys]
  for (let i = 0; i < keys.length; i += 10_000) {
    const chunk = keys.slice(i, i + 10_000)
    const tuples = chunk.map(k => `(${k})`).join(',')
    const callRes = await client.query({
      query: `SELECT block_height AS block, assumeNotNull(extrinsic_index) AS extrinsic, call_address AS callAddress,
                     call_name AS callName, args_json AS argsJson, toUInt32(toUnixTimestamp(block_timestamp)) AS ts
              FROM price_data.multisig_call_activity FINAL
              WHERE (block_height, assumeNotNull(extrinsic_index)) IN (${tuples}) AND extrinsic_index IS NOT NULL`,
      format: 'JSONEachRow',
    })
    const rows = await callRes.json<{ block: number; extrinsic: number; callAddress: string; callName: string; argsJson: string; ts: number }>()
    if (!rows.length) continue
    const extrinsicKeys = new Set(rows.map(r => `${r.block},${r.extrinsic}`))
    const [rawCalls, signers] = await Promise.all([loadRawCallsForTuples(extrinsicKeys), loadSignersForTuples(extrinsicKeys)])
    const byAddress = new Map<string, RawCallLookupRow>()
    for (const c of rawCalls) byAddress.set(`${c.block}:${c.extrinsic}:${c.callAddress}`, c)
    for (const r of rows) {
      let threshold: number | null = null
      let otherSignatories: string[] = []
      try {
        const args = JSON.parse(r.argsJson) as { threshold?: number; otherSignatories?: string[] }
        threshold = typeof args.threshold === 'number' ? args.threshold : null
        otherSignatories = Array.isArray(args.otherSignatories) ? args.otherSignatories.map(s => s.toLowerCase()) : []
      } catch { /* keep defaults — the derive-check will simply not match */ }
      const own = byAddress.get(`${r.block}:${r.extrinsic}:${r.callAddress}`)
      const child = byAddress.get(`${r.block}:${r.extrinsic}:${proxyChildAddress(r.callAddress)}`)
      calls.push({
        block: r.block, extrinsic: r.extrinsic, callAddress: r.callAddress, callName: r.callName,
        threshold, otherSignatories,
        originAccount: signedOrigin(own?.originJson ?? null) ?? signers.get(`${r.block}:${r.extrinsic}`) ?? null,
        callSuccess: own?.success ?? null,
        innerCallName: child?.callName ?? null,
        innerSuccess: child?.success ?? null,
        innerErrorJson: child?.errorJson ?? null,
        ts: r.ts,
      })
    }
  }
  return calls
}

async function enrichProxyCandidates(scoped: OnBehalfCandidate[]): Promise<Map<string, ProxyInnerInfo>> {
  const proxyCands = scoped.filter(c => c.kind === 'proxy')
  if (!proxyCands.length) return new Map()
  const tuples = new Set(proxyCands.map(c => `${c.block},${c.extrinsic}`))
  const rawCalls = await loadRawCallsForTuples(tuples)
  const calls: ExtrinsicCallRow[] = rawCalls.map(c => ({ block: c.block, extrinsic: c.extrinsic, callAddress: c.callAddress, callName: c.callName, success: c.success, errorJson: c.errorJson }))
  return resolveProxyInner(proxyCands.map(c => ({ block: c.block, extrinsic: c.extrinsic, callAddress: c.callAddress! })), calls)
}

async function enrichMultisigCandidates(scoped: OnBehalfCandidate[]): Promise<void> {
  const states = scoped.filter(c => c.kind === 'multisig').map(c => c.opState!)
  const tuples = new Set<string>()
  for (const s of states) for (const tp of s.touchpoints) tuples.add(`${tp.block},${tp.extrinsic}`)
  if (!tuples.size) return
  const calls = await loadMultisigCallInfo(tuples)
  enrichMultisigOperations(states, calls)
}

interface ExtrinsicHydrationRow { block: number; extrinsic: number; hash: string; ts: string; signer: string | null; success: number; callName: string; fee: string | null; error_json: string | null; spec_version: number }
async function hydrateOnBehalfExtrinsics(tuples: Set<string>): Promise<Map<string, ExtrinsicHydrationRow>> {
  const out = new Map<string, ExtrinsicHydrationRow>()
  const keys = [...tuples]
  for (let i = 0; i < keys.length; i += 10_000) {
    const inList = keys.slice(i, i + 10_000).map(k => `(${k})`).join(',')
    const res = await client.query({
      // spec_version joins one level up (see the signed select) so a failed
      // anchor extrinsic's error_json can be decoded into a failure reason.
      query: `SELECT ext.*, b.spec_version AS spec_version
              FROM (
                SELECT block_height AS block, extrinsic_index AS extrinsic, extrinsic_hash AS hash,
                       toString(block_timestamp) AS ts, coalesce(signer, effective_signer) AS signer,
                       success, call_name AS callName, fee, error_json
                FROM price_data.raw_extrinsics
                WHERE (block_height, extrinsic_index) IN (${inList})
                ORDER BY ingested_at DESC
                LIMIT 1 BY block_height, extrinsic_index
              ) AS ext
              LEFT JOIN price_data.blocks b ON b.block_height = ext.block`,
      format: 'JSONEachRow',
    })
    for (const r of await res.json<ExtrinsicHydrationRow>()) out.set(`${r.block}:${r.extrinsic}`, r)
  }
  return out
}

// Builds the same ExtrinsicSummaryRow shape extrinsicSummary() has always
// consumed, so the on-behalf → ExtrinsicSummary mapping (origin kind/state/
// threshold/timeline/…) stays byte-identical to the retired SQL union.
function buildOnBehalfRow(c: OnBehalfCandidate, hydrate: ExtrinsicHydrationRow | undefined, proxyInner: Map<string, ProxyInnerInfo>): ExtrinsicSummaryRow | null {
  if (!hydrate) return null // extrinsic row missing (shouldn't happen for a real anchor) — drop rather than fabricate
  const base = {
    block_height: c.block, extrinsic_index: c.extrinsic, extrinsic_hash: hydrate.hash,
    ts: hydrate.ts, signer: hydrate.signer, success: hydrate.success, call_name: hydrate.callName, fee: hydrate.fee,
    error_json: hydrate.error_json, spec_version: hydrate.spec_version,
  }
  if (c.kind === 'proxy') {
    const inner = proxyInner.get(`${c.block}:${c.extrinsic}:${c.callAddress}`)
    return {
      ...base,
      display_call_name: inner?.innerCallName || c.proxyCallName!,
      display_success: inner?.innerSuccess ?? hydrate.success,
      error_json: inner?.innerSuccess === 0 ? inner.innerErrorJson : hydrate.error_json,
      origin_kind: 'proxy',
    }
  }
  const op = c.opState!.row
  return {
    ...base,
    display_call_name: op.inner_call_name || hydrate.callName,
    display_success: op.state === 'pending' ? null : op.inner_success,
    error_json: op.state === 'executed' && op.inner_success === 0 ? op.inner_error_json : hydrate.error_json,
    origin_kind: 'multisig',
    ms_state: op.state,
    ms_threshold: op.threshold,
    ms_signatories: op.signatories,
    ms_approvals: op.approvals,
    ms_call_hash: op.inner_call_name === '' ? op.call_hash : '',
    ms_initiator: op.initiator,
    ms_timeline_actors: op.timeline_actors,
    ms_timeline_actions: op.timeline_actions,
    ms_timeline_ts: op.timeline_ts.map(chTimestampString),
    ms_timeline_blocks: op.timeline_blocks,
    ms_timeline_extrinsics: op.timeline_extrinsics,
  }
}

function dedupeSummaryRows(rows: ExtrinsicSummaryRow[]): ExtrinsicSummaryRow[] {
  const seen = new Set<string>()
  const out: ExtrinsicSummaryRow[] = []
  for (const r of rows) {
    const key = `${r.block_height}:${r.extrinsic_index}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out
}

// The account's extrinsics feed: extrinsics it SIGNED, plus extrinsics
// executed ON ITS BEHALF — Proxy.proxy calls whose `real` is the account and
// multisig operations of a multisig it is, reconstructed at request time from
// MV-fed sources (see the on-behalf candidate helpers above). Sources are
// merged, deduplicated per extrinsic (on-behalf wins so the badge survives
// self-proxy), sorted, then sliced — pagination stays deterministic over the
// full filtered ordering. `call`/`result` filters match the DISPLAYED call
// name / result (the inner call for on-behalf rows); pending operations match
// neither result value. A call/result filter forces full enrichment of every
// on-behalf candidate (filter completeness); otherwise only the top
// (offset+limit) candidates are enriched.
async function getAccountExtrinsics(accounts: string[], limit = 25, offset = 0, cacheKey?: string, filters: ExtrinsicListFilters = {}, from?: string, to?: string): Promise<ExtrinsicSummary[]> {
  const list = sqlAccountList(accounts)
  if (list === "''") return []
  const tw = timeWindow(from, to)
  const bound = tw ?? '1'
  return cached(`explorer:${cacheKey ?? `acct-extrinsics:${[...accounts].sort().join(',')}`}:${limit}:${offset}:${from ?? ''}:${to ?? ''}:${filterKey(filters)}`, tw ? 30000 : 8000, async () => {
    const wantSigned = !filters.origin || filters.origin === 'signed'
    const wantProxy = !filters.origin || filters.origin === 'proxy'
    const wantMs = !filters.origin || filters.origin === 'multisig'
    const hasCallFilter = Boolean(filters.call?.trim())
    const hasResultFilter = filters.result === 'success' || filters.result === 'failed'
    const enrichAll = hasCallFilter || hasResultFilter

    const [proxyRows, msStatesAll] = await Promise.all([
      wantProxy ? fetchProxyCandidates(list, bound) : Promise.resolve([] as ProxyCandidateRow[]),
      wantMs ? accountMultisigOps(accounts) : Promise.resolve([] as MultisigOperationState[]),
    ])
    const msWindow = msAnchorWindow(from, to)
    const msStates = msWindow ? msStatesAll.filter(s => msWindow(s.row.anchor_timestamp)) : msStatesAll

    const mergedMap = mergeOnBehalfCandidates(proxyRows, msStates)
    let scoped = [...mergedMap.values()].sort((a, b) => b.block - a.block || b.extrinsic - a.extrinsic)
    if (!enrichAll) scoped = scoped.slice(0, offset + limit)
    // With nothing to merge, the merged ordering IS the signed ordering, so the page
    // can be taken in SQL instead of allocating every row before it. That is what
    // makes a real page count usable at depth: one live account signs 945,640
    // extrinsics, and reading the 945,650-row prefix for its last page tripped the
    // client's 100k result-row guard. Accounts that DO have on-behalf history are
    // orders of magnitude smaller (the largest signs 16,320), so the prefix form
    // stays well inside the guard there.
    const signedPageInSql = mergedMap.size === 0

    const [proxyInnerMap] = await Promise.all([enrichProxyCandidates(scoped), enrichMultisigCandidates(scoped)])
    const hydration = await hydrateOnBehalfExtrinsics(new Set(scoped.map(c => `${c.block},${c.extrinsic}`)))

    let onBehalfRows = scoped
      .map(c => buildOnBehalfRow(c, hydration.get(`${c.block}:${c.extrinsic}`), proxyInnerMap))
      .filter((r): r is ExtrinsicSummaryRow => r != null)
    if (hasCallFilter) onBehalfRows = onBehalfRows.filter(r => matchesCallFilter(r.display_call_name!, filters.call!))
    if (filters.result === 'success') onBehalfRows = onBehalfRows.filter(r => r.display_success === 1)
    if (filters.result === 'failed') onBehalfRows = onBehalfRows.filter(r => r.display_success === 0)

    const signedRows: ExtrinsicSummaryRow[] = wantSigned ? await (async () => {
      const res = await client.query({
        // The extrinsics-only inner select keeps bound/filters unqualified and
        // ambiguity-free (single table in scope); the spec_version join for
        // failure-reason decoding happens one level up, against the already
        // bounded candidate set (signed display name/result == call_name/success).
        query: `
          SELECT ext.block_height AS block_height, ext.extrinsic_index AS extrinsic_index, ext.extrinsic_hash AS extrinsic_hash,
                 ext.ts AS ts, ext.signer AS signer, ext.success AS success, ext.call_name AS call_name, ext.fee AS fee,
                 ext.call_name AS display_call_name, toNullable(ext.success) AS display_success,
                 ext.error_json AS error_json, b.spec_version AS spec_version
          FROM (
            SELECT block_height, extrinsic_index, extrinsic_hash, toString(block_timestamp) AS ts, coalesce(signer, effective_signer) AS signer, success, call_name, fee, error_json
            FROM price_data.raw_extrinsics
            WHERE ${bound}
              ${signedExtrinsicPredicateSql(list, filters)}
            ORDER BY block_height DESC, extrinsic_index DESC
            LIMIT 1 BY block_height, extrinsic_index
            LIMIT {branchLimit:UInt32} OFFSET {branchOffset:UInt32}
          ) AS ext
          LEFT JOIN price_data.blocks b ON b.block_height = ext.block_height
          ORDER BY ext.block_height DESC, ext.extrinsic_index DESC`,
        // LIMIT 1 BY drops replayed rows BEFORE the window, so a re-ingested
        // extrinsic cannot shift or shorten a page the way TS-side dedup would.
        query_params: {
          branchLimit: signedPageInSql ? limit : offset + limit,
          branchOffset: signedPageInSql ? offset : 0,
          ...textNameParams('callName', filters.call),
        },
        format: 'JSONEachRow',
      })
      return res.json<ExtrinsicSummaryRow>()
    })() : []

    // on-behalf rows first: a stable sort preserves their precedence over a
    // same-(block,extrinsic) signed row, reproducing the old union's
    // "on-behalf wins" tiebreak without needing a second sort key.
    const combined = [...onBehalfRows, ...signedRows]
    combined.sort((a, b) => b.block_height - a.block_height || b.extrinsic_index - a.extrinsic_index)
    const page = signedPageInSql ? combined : dedupeSummaryRows(combined).slice(offset, offset + limit)
    return uniqueExtrinsicSummaries(page)
  })
}

// Events that mention the account. Each account_id appears in args_json as its
// lowercase 0x-less hex (e.g. Balances.Transfer {from,to}); positionCaseInsensitive
// finds any leg referencing one of the related accounts. Bounded by recency
// (ORDER BY block_height DESC) + LIMIT/OFFSET. Same shape as getRecentEvents.
export async function getAddressEvents(addressInput: string, limit = 25, offset = 0, filters: EventListFilters = {}, from?: string, to?: string): Promise<EventRow[] | null> {
  const resolved = await resolveRelatedAccounts(addressInput)
  if (!resolved) return null
  return getAccountEvents(resolved.related, limit, offset, `addr-events:${resolved.norm.accountId}`, filters, from, to)
}

// Events mentioning any account in an explicit set (related-account set, or a
// tag's members). Shared by getAddressEvents and the tag events endpoint.
async function getAccountEvents(accounts: string[], limit = 25, offset = 0, cacheKey?: string, filters: EventListFilters = {}, from?: string, to?: string): Promise<EventRow[]> {
  const hexes = accounts.filter(a => ACCOUNT_RE.test(a)).map(a => a.slice(2).toLowerCase())
  if (!hexes.length) return []
  const tw = timeWindow(from, to)
  const bound = tw ?? '1'
  return cached(`explorer:${cacheKey ?? `acct-events:${[...accounts].sort().join(',')}`}:${limit}:${offset}:${from ?? ''}:${to ?? ''}:${filterKey(filters)}`, tw ? 30000 : 8000, async () => {
    const eventFilter = filters.event?.trim() ? textNameFilter('event_name', 'eventName') : ''
    const list = sqlAccountList(accounts)
    let rows: EventSourceRow[]
    if (list !== "''") {
      // Page over (block, event) references through the account-activity index,
      // then fetch only those rows from raw_events.
      const refsRes = await client.query({
        query: accountActivityRefsQuery(accounts, filters.event?.trim() ? textNameMatchSql('event_name', 'eventName') : '', bound, limit, offset),
        query_params: { ...textNameParams('eventName', filters.event) },
        // Member sets past the arm cap keep the single grouped scan, which on a
        // structural pot is the read that hit the memory ceiling. Spilling keeps
        // such a page slow rather than a 500.
        clickhouse_settings: { max_bytes_before_external_group_by: '1500000000' },
        format: 'JSONEachRow',
      })
      const refs = await refsRes.json<{ block_height: number; event_index: number }>()
      if (!refs.length) return []
      const res = await client.query({
        query: `
          SELECT block_height, event_index, extrinsic_index, toString(block_timestamp) AS ts, event_name, args_json
          FROM price_data.raw_events
          WHERE (block_height, event_index) IN (${refs.map(r => `(${r.block_height},${r.event_index})`).join(',')})
          ORDER BY block_height DESC, event_index DESC`,
        format: 'JSONEachRow',
      })
      rows = await res.json<EventSourceRow>()
    } else {
      const cond = hexes.map(h => `positionCaseInsensitive(args_json, '${h}') > 0`).join(' OR ')
      const res = await client.query({
        query: `
          SELECT block_height, event_index, extrinsic_index, toString(block_timestamp) AS ts, event_name, args_json
          FROM price_data.raw_events
          WHERE ${bound}
            AND (${cond})
            ${eventFilter}
          ORDER BY block_height DESC, event_index DESC
          LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
        query_params: { limit, offset, ...textNameParams('eventName', filters.event) }, format: 'JSONEachRow',
      })
      rows = await res.json<EventSourceRow>()
    }
    return uniqueEventRows(rows)
  })
}

export interface AssetDetail {
  asset: AssetListItem
  holderCount: number
  totalUsd: number
  priceSeries: number[]
  priceDates: string[]
}

export async function getAssetDetail(assetId: number): Promise<AssetDetail> {
  return cached(`explorer:asset:${assetId}`, 30000, async () => {
    const prices = await ensurePrices()
    const a = assetDescriptor(assetId)
    const p = prices.get(assetId)
    const type = explorerAssetType(a)

    // The full holder list is paginated via /explorer/holders; here we only need
    // the holder count and total held USD (a one-row page carries both via the
    // window aggregates), so the asset-detail payload stays small.
    const hsummary = await getHolders(assetId, 1, 0)
    // `amountUsd` is the total USD held of this asset — the same value the asset
    // list surfaces — so reuse the holder summary's total here.
    const assetItem: AssetListItem = { ...a, price: p?.price ?? null, change24h: p?.change24h ?? null, type, amountUsd: hsummary.totalUsd }

    // Full available daily closes from the proven OHLC view. The UI receives the
    // dates too so performance chips can be shown only when the relevant window
    // exists for this asset.
    let priceSeries: number[] = []
    let priceDates: string[] = []
    const closesP = (async () => {
      const end = new Date()
      const start = new Date(0)
      const fmt = (d: Date) => d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
      const pxRes = await client.query({
        query: `SELECT toString(interval_start) AS ts, toFloat64(close) AS px
                FROM price_data.ohlc_1d_query(asset_id={id:UInt32}, start_time={s:DateTime}, end_time={e:DateTime})
                WHERE close > 0
                ORDER BY interval_start`,
        query_params: { id: assetId, s: fmt(start), e: fmt(end) }, format: 'JSONEachRow',
      })
      for (const r of await pxRes.json<{ ts: string; px: number }>()) {
        if (!(r.px > 0)) continue
        priceDates.push(r.ts)
        priceSeries.push(r.px)
      }
    })().catch(() => { /* asset may have no OHLC */ })
    await closesP

    return { asset: assetItem, holderCount: hsummary.total, totalUsd: hsummary.totalUsd, priceSeries, priceDates }
  })
}

// all accounts ranked by portfolio (tag-grouped)
export interface TopAccountRow {
  account: AccountRef | null
  tag: { tagId: string; name: string; color: string; icon: string; memberCount: number } | null
  portfolioUsd: number
  lastBlock: number
  identity?: string | null
  // 1Y wallet-value sparkline (SPARK_WEEKS weekly points, zero-padded so every
  // row spans the same trailing year) + activity counter. Optional — the page
  // still renders if the enrichment pass fails.
  sparkline?: number[]
  // The account's own activity feed total — the same number its detail page reports,
  // computed by the background pass (see the activity-ordering note). Absent for an
  // account outside the counted pool: no number is better than another model's number.
  activityCount?: number
  activityCountComplete?: boolean
  tradingVolumeUsd?: number
  // Up to 4 largest holdings (> $10, highest USD first) for the icon cluster
  // shown after the row's value. Tag rows aggregate holdings across members.
  topAssets?: { asset: AssetRef; valueUsd: number }[]
  // How many further holdings clear the same $10 without making the top four.
  otherAssets?: number
}

// 1Y value sparkline
export const SPARK_WEEKS = 53
const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS

// The 53 points are fixed calendar weeks: bucket 52 is the current (possibly
// partial) Monday-Sunday week and bucket 0 begins 52 Mondays earlier. UTC keeps
// the boundary identical to ClickHouse Date/toMonday regardless of API host TZ.
export function sparklineCalendarWindowStart(now: Date = new Date()): Date {
  const timestamp = now.getTime()
  if (!Number.isFinite(timestamp)) throw new RangeError('invalid sparkline date')
  const midnightUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const daysSinceMonday = (now.getUTCDay() + 6) % 7
  return new Date(midnightUtc - daysSinceMonday * DAY_MS - (SPARK_WEEKS - 1) * WEEK_MS)
}
// Assemble one group's weekly value series from raw parts, all pre-bucketed to
// SPARK_WEEKS trailing weeks: in-window balance observations (forward-filled per
// account+asset — summing across accounts per bucket would sawtooth, see
// getAccountHistory), an exact pre-window baseline per account+asset (dormant
// holdings show their real flat value rather than 0; accounts born inside the
// window keep leading zeros), and weekly close prices per asset (forward-filled,
// with the earliest indexed close covering the leading buckets).
export function buildValueSparkline(
  obs: { account_id: string; asset_id: string; b: number; bal: string }[],
  baseline: Map<string, string>,                       // `${account}|${asset}` → raw balance at window start
  pricesByAsset: Record<string, Map<number, number>>,  // asset_id → bucket → weekly close
  decimals: Map<string, number>,                       // asset_id → decimals
): number[] | null {
  const byKey = new Map<string, Map<number, string>>()
  for (const [k, bal] of baseline) byKey.set(k, new Map([[-1, bal]]))
  for (const r of obs) {
    const k = `${r.account_id}|${r.asset_id}`
    if (!byKey.has(k)) byKey.set(k, new Map())
    byKey.get(k)!.set(r.b, r.bal)
  }
  const series: number[] = new Array(SPARK_WEEKS).fill(0)
  for (const [k, balMap] of byKey) {
    const assetId = k.slice(k.indexOf('|') + 1)
    const dec = decimals.get(assetId) ?? 12
    const pxMap = pricesByAsset[assetId] ?? new Map<number, number>()
    if (pxMap.size === 0 && [...balMap.values()].some(value => BigInt(value) !== 0n)) return null
    let earliest = 0
    for (let b = 0; b < SPARK_WEEKS; b++) { const p = pxMap.get(b); if (p != null) { earliest = p; break } }
    let bal: string | null = balMap.get(-1) ?? null
    let px = earliest
    for (let b = 0; b < SPARK_WEEKS; b++) {
      if (balMap.has(b)) bal = balMap.get(b)!
      const p = pxMap.get(b)
      if (p != null) px = p
      if (bal != null && px > 0) series[b] += (Number(bal) / 10 ** dec) * px
    }
  }
  return series.map(v => +v.toFixed(2))
}
export type AccountSort = 'value' | 'identity' | 'activity' | 'volume'
// The activity sort briefly shipped as `updates`; both resolve to the same column.
export function normalizeAccountSort(sort: string): string {
  return sort === 'updates' ? 'activity' : sort
}
export interface AccountsPage {
  rows: TopAccountRow[]
  total: number
  // For an ordering that can only be established for part of the directory, how many
  // leading rows are provably in the right order. Absent means the whole ordering is.
  rankedDepth?: number
}

// ─── The activity ordering ────────────────────────────────────────────────────
//
// The Activity column shows the number the account's own detail page reports: its
// classified activity feed's exact total. It used to show distinct balance
// observations, which is a different unit — hMN had 6,129,461 of those behind 1,221,974
// activities — and the two disagreeing under one word is the defect this removes.
//
// That number cannot be computed on the request path. It is per-account, its
// cross-chain leg has to be parsed row by row, and the accounts this column ranks
// highest are the busiest on the chain: 2 to 12 seconds each. So it is computed in a
// background pass on its own slow interval, and both the ordering and the displayed
// value come from what that pass stored. The request reads one small snapshot row.
//
// The pass is deliberately throttled rather than exhaustive. It rode the five-minute
// directory prewarm at first, which recounted all 250 members 288 times a day: every
// member's total was already past its cache's two-minute fresh window whenever the pass
// came round, so nothing was ever reused and ClickHouse spent ~19 cores and ~60 TiB an
// hour re-deriving numbers that had not changed. An exact per-account total is not a
// five-minute value, so a cycle now recounts only the few members whose stored total has
// aged out, one at a time, with a cooldown between them. Counted totals are persisted, so
// throttling makes the column slightly older — never empty.
//
// Which accounts it computes is the part that has to be justified rather than assumed.
// Every feed row is built from at least one event that MENTIONS the account, so an
// account's reference count in account_activity_v3 is an upper bound on its feed total
// (hMN: 1.22M of 9.83M references; the Omnipool pot: 60.5k of 72.6M, because almost all
// of its references are plumbing the feed suppresses). Take the pool as the accounts
// with the most references, and that bound makes the pool a provable superset of the
// true top N for every N whose N-th total is at least the largest reference count left
// OUTSIDE the pool. `rankedDepth` reports exactly that N.
//
// The pool counts rows rather than distinct references — no FINAL, so a replayed range's
// un-merged replacement copies are still counted. That only ever counts a reference more
// than once, so it stays an upper bound, and counting the floor too high only makes
// `rankedDepth` more conservative. Deduplicating it would cost per-account aggregate
// state across the whole table to tighten a bound that is already sound.
//
// Below it the ordering is still every counted total in order, and no row ever shows a
// number from another model — an account the pass has not counted shows none at all and
// sorts after the ones it has. So the imprecision past `rankedDepth` is bounded and
// one-directional: an uncounted account with fewer references than the pool's floor
// could belong among those ranks and is missing from them. It cannot displace a rank
// above `rankedDepth`, and it cannot make a shown number wrong.
const ACTIVITY_LEADERBOARD_SNAPSHOT_KEY = 'activity-leaderboard:v1'
// The pool. Sized so its reference floor still leaves a useful ranked depth: reference
// counts fall steeply — rank 100 is 208,358, rank 400 is 33,981, rank 800 is 13,873 — so
// a deeper pool buys ranked depth roughly linearly.
const ACTIVITY_LEADERBOARD_POOL = 250
// How often the pass wakes up. Its own interval, not the five-minute directory prewarm's:
// the pages below read whatever ranking is published, so the two have no reason to share a
// cadence, and sharing it is what made an exact total a five-minute value.
const ACTIVITY_LEADERBOARD_REFRESH_MS = 15 * 60_000
// How stale a member's stored total may get before the pass recounts it.
const ACTIVITY_LEADERBOARD_ENTRY_TTL_MS = 12 * 3_600_000
// How many members one cycle counts, and how long it waits between them. One at a time
// with idle gaps: a whole-history count is the most expensive read the API issues, and a
// background ranking gains nothing from running several of them at once.
//
// The rate has to clear the WHOLE pool — reference plus demand — within the TTL, or
// entries age out faster than the pass returns to them. 250 + 400 = 650 members
// against a 12 h window and a 15-minute cycle needs 650 / (12 × 4) ≈ 14 per cycle;
// 14 gives 672. At 3 per cycle (the rate this shipped with) the budget was 144, so
// even the 174 groups the reference pool alone maps to aged out between counts.
//
// The cost is real and worth stating: most counts are sub-second, but a structural
// pot's is 5–11 s (Polkadot Treasury's 1.19M activities take 10.8 s). Fourteen counts
// spaced by the cooldown occupy about five minutes of the fifteen-minute cycle, still
// strictly one read at a time, and only a handful of the 650 are the expensive kind.
const ACTIVITY_LEADERBOARD_COUNTS_PER_CYCLE = 14
const ACTIVITY_LEADERBOARD_COUNT_COOLDOWN_MS = 20_000
// The demand-driven half of the pool: the rows the directory actually renders on
// its prewarmed first pages, across every sort. Measured live, the eight sorts'
// page 0 hold 301 distinct rows — each appearing on 1.33 sorts on average, because
// the same tags and pots lead most orderings — so covering what a reader sees costs
// ~300 counts rather than the 114,317 rows a per-row model would need. This is the
// bound the rate above is sized against; the constant exists so the two cannot drift
// apart unnoticed (accountDirectoryActivity.test.ts pins the relationship).
const ACTIVITY_LEADERBOARD_DIRECTORY_POOL_MAX = 400
// The reference pool is a whole-table group-by (26 GiB, ~6s) and its membership moves over
// days, so it is persisted with the ranking and re-derived on its own slow schedule
// instead of once per cycle.
const ACTIVITY_LEADERBOARD_POOL_TTL_MS = 6 * 3_600_000

interface ActivityLeaderboardEntry {
  // The directory's grouping key: a tag id for a tagged member, else the account id.
  gkey: string
  total: number
  // False when the feed could only be counted in part (a structural pot whose candidate
  // set exceeds the query memory ceiling). Rendered as a floor, and ranked below every
  // exact total, so a reader is never shown a partial competing with an exact one.
  complete: boolean
  // When this total was established. Drives which members a cycle recounts: the pass
  // revisits the oldest first and leaves everything inside its TTL alone.
  countedAt?: string
}

interface ActivityLeaderboardPoolMember { account: string; refs: number }

interface ActivityLeaderboard {
  entries: ActivityLeaderboardEntry[]
  rankedDepth: number
  computedAt: string
  // The reference pool the ranking is drawn from, the largest reference count left
  // outside it, and when that was derived.
  pool?: ActivityLeaderboardPoolMember[]
  refsOutside?: number
  poolAt?: string
}

let activityLeaderboard: ActivityLeaderboard | null = null

// The pool, largest reference counts first, plus the largest count left outside it — the
// bound `rankedDepth` is established against. Re-derived only when the published one has
// aged out; every cycle in between reuses it.
async function activityLeaderboardPool(published: ActivityLeaderboard | null): Promise<{ pool: ActivityLeaderboardPoolMember[]; refsOutside: number; poolAt: string }> {
  const fresh = published?.pool?.length && published.poolAt
    && Date.now() - Date.parse(published.poolAt) < ACTIVITY_LEADERBOARD_POOL_TTL_MS
  if (fresh) return { pool: published.pool as ActivityLeaderboardPoolMember[], refsOutside: published.refsOutside ?? 0, poolAt: published.poolAt as string }
  const res = await client.query({
    query: `SELECT account, toString(count()) AS refs FROM price_data.account_activity_v3
            GROUP BY account
            HAVING match(account, '^0x[0-9a-f]{64}$')
            ORDER BY count() DESC LIMIT {limit:UInt32}`,
    query_params: { limit: ACTIVITY_LEADERBOARD_POOL + 1 }, format: 'JSONEachRow',
  })
  const rows = (await res.json<{ account: string; refs: string }>())
    .map(r => ({ account: r.account, refs: Number(r.refs) }))
  return {
    pool: rows.slice(0, ACTIVITY_LEADERBOARD_POOL),
    // Nothing outside the pool can hold more feed rows than this.
    refsOutside: rows[ACTIVITY_LEADERBOARD_POOL]?.refs ?? 0,
    poolAt: new Date().toISOString(),
  }
}

// The directory row a pool member's total belongs to: its tag when it has one, because the
// directory groups tagged accounts under the tag and the tag's own feed is what that row
// shows.
function activityLeaderboardGkey(account: string): string {
  return tagForAccount(account)?.tagId ?? account
}

// The gkeys a rendered directory page covers — the same key the query grouped by, so
// a leaderboard entry made from one lands on that exact row: a system tag's id, else
// the account itself. Viewer-fold pages are never prewarmed, so `u:` keys cannot
// appear here (those are counted directly, see viewerFoldActivityEntries).
export function directoryRowGkeys(rows: TopAccountRow[]): string[] {
  const out: string[] = []
  for (const row of rows) {
    const gkey = row.tag ? row.tag.tagId : row.account?.accountId
    if (gkey) out.push(gkey)
  }
  return out
}

// Whatever the last full prewarm pass rendered, replaced atomically so a half-warmed
// pass can never narrow the pool. Empty until the first pass completes, which only
// means the board keeps to its reference pool for those few minutes.
let directoryPoolGkeys: string[] = []

// Pool members for those gkeys: an account each cycle can count FROM, since a total is
// established through an account (a tagged one resolves to its tag's own feed — see
// activityLeaderboardTotal). Reference-pool members are skipped, being counted already.
// `refs: 0` places these after the reference pool in the due order, so the busiest
// accounts on the chain keep priority over whatever currently leads a directory page.
export function demandPoolMembers(
  gkeys: string[],
  alreadyPooled: Set<string>,
  memberOfTag: (tagId: string) => string | null,
  limit = ACTIVITY_LEADERBOARD_DIRECTORY_POOL_MAX,
): ActivityLeaderboardPoolMember[] {
  const out: ActivityLeaderboardPoolMember[] = []
  const seen = new Set<string>()
  for (const gkey of gkeys) {
    if (out.length >= limit) break
    if (seen.has(gkey) || alreadyPooled.has(gkey)) continue
    seen.add(gkey)
    const account = ACCOUNT_RE.test(gkey) ? gkey : memberOfTag(gkey)
    if (account) out.push({ account, refs: 0 })
  }
  return out
}

// Count one pool member through the very endpoints the detail pages read, so the
// directory cannot describe an account differently from its own page — and so the count
// lands in the same cache that page will hit.
async function activityLeaderboardTotal(account: string): Promise<{ gkey: string; total: ScopedListTotal } | null> {
  const tag = tagForAccount(account)
  const query: ScopedListQuery = { tab: 'activity', type: 'all' }
  if (tag) {
    const total = await getTagListTotal(tag.tagId, query)
    return total ? { gkey: tag.tagId, total } : null
  }
  const total = await getAddressListTotal(account, query)
  return total ? { gkey: account, total } : null
}

// How long ago a stored total was established. A never-counted member is infinitely due,
// which is what puts a cold board's members ahead of a warm board's oldest entry.
function activityLeaderboardEntryAge(entry: ActivityLeaderboardEntry | undefined): number {
  if (!entry?.countedAt) return Infinity
  const at = Date.parse(entry.countedAt)
  return Number.isFinite(at) ? Date.now() - at : Infinity
}

// Recount the few members whose stored total has aged out, then publish. Ordering is by
// (exact before partial, then total), and `rankedDepth` stops at the first rank the
// reference bound no longer covers — so every page the directory offers is one this pass
// can stand behind.
async function refreshActivityLeaderboardUncached(): Promise<void> {
  // Start from what is already published — including on a cold process, where that means
  // the persisted ranking. Without this a restart would throw away every count and begin
  // the multi-cycle rebuild again.
  const published = await ensureActivityLeaderboard()
  // Seed the swept table from the published ranking BEFORE counting anything: a cold
  // process (every deploy) would otherwise serve a blank Activity column for the whole
  // first cycle, since the table is the read path now.
  if (!activityTotalsSeeded && published?.entries.length) {
    await persistActivityTotals(published.entries)
    activityTotalsSeeded = true
  }
  const { pool, refsOutside, poolAt } = await activityLeaderboardPool(published)
  const byGkey = new Map<string, ActivityLeaderboardEntry>()
  // Carry those entries so a throttled pass deepens the ranking instead of restarting it;
  // a re-counted member simply overwrites its own entry.
  for (const entry of published?.entries ?? []) byGkey.set(entry.gkey, entry)
  // One member per directory row (a tag's members all resolve to the tag's own feed), the
  // most overdue first, capped at what one cycle may spend.
  // The reference pool ranks the chain's busiest accounts; the demand pool covers what
  // the directory actually shows. Only the reference half is persisted and aged (see
  // activityLeaderboardPool) — the demand half is rebuilt from the latest prewarm every
  // cycle, so it follows the pages rather than a six-hour-old snapshot of them.
  const members = [
    ...pool,
    ...demandPoolMembers(
      directoryPoolGkeys,
      new Set(pool.map(m => activityLeaderboardGkey(m.account))),
      tagId => tagMembers(tagId)?.[0] ?? null,
    ),
  ]
  const dueByGkey = new Map<string, ActivityLeaderboardPoolMember>()
  for (const member of members) {
    const gkey = activityLeaderboardGkey(member.account)
    if (dueByGkey.has(gkey)) continue
    if (activityLeaderboardEntryAge(byGkey.get(gkey)) <= ACTIVITY_LEADERBOARD_ENTRY_TTL_MS) continue
    dueByGkey.set(gkey, member)
  }
  const due = [...dueByGkey.entries()]
    .sort(([a], [b]) => activityLeaderboardEntryAge(byGkey.get(b)) - activityLeaderboardEntryAge(byGkey.get(a)))
    .slice(0, ACTIVITY_LEADERBOARD_COUNTS_PER_CYCLE)
  let counted = 0
  const countedNow = new Set<string>()
  for (const [, member] of due) {
    // Idle between counts so the pass leaves the instance to live ingestion and requests
    // rather than occupying it back to back.
    if (counted) await new Promise(resolve => setTimeout(resolve, ACTIVITY_LEADERBOARD_COUNT_COOLDOWN_MS))
    try {
      const result = await activityLeaderboardTotal(member.account)
      if (!result || result.total.total == null) continue
      byGkey.set(result.gkey, {
        gkey: result.gkey, total: result.total.total, complete: result.total.complete,
        countedAt: new Date().toISOString(),
      })
      countedNow.add(result.gkey)
      counted++
    } catch (error) {
      console.warn('[explorer] activity leaderboard member failed', member.account, error)
    }
  }
  // Totals live in account_activity_totals, keyed by the directory's own grouping key,
  // and the read path joins them (see AGENTS.md, Swept models) — they are no longer a
  // literal spliced into the directory query, which is what capped this at a few
  // hundred entries. Replacement is per gkey, so a partial sweep is a valid state and
  // recounting one entity is idempotent.
  const entries = [...byGkey.values()].sort((a, b) => Number(b.complete) - Number(a.complete) || b.total - a.total)
  // Only what this cycle recounted; the seed above covers a cold start.
  await persistActivityTotals(entries.filter(e => countedNow.has(e.gkey)))
  activityTotalsSeeded = true
  // Only the leading run whose totals clear everything outside the pool is provably in
  // order. A partial total is a floor, so it can never establish a rank.
  let rankedDepth = 0
  for (const entry of entries) {
    if (!entry.complete || entry.total < refsOutside) break
    rankedDepth++
  }
  activityLeaderboard = { entries, rankedDepth, computedAt: new Date().toISOString(), pool, refsOutside, poolAt }
  await persistActivityLeaderboard(activityLeaderboard)
  console.info('[explorer] activity leaderboard', { entries: entries.length, members: members.length, due: due.length, counted, rankedDepth, refsOutside })
}

// The sweep's write side. One row per directory grouping key; ReplacingMergeTree keyed
// on gkey, so recounting an entity replaces its row rather than accumulating history.
let activityTotalsSeeded = false

async function persistActivityTotals(entries: ActivityLeaderboardEntry[]): Promise<void> {
  if (!entries.length) return
  await client.insert({
    table: 'price_data.account_activity_totals',
    values: entries.map(entry => ({
      gkey: entry.gkey,
      total: entry.total,
      complete: entry.complete ? 1 : 0,
      counted_at: (entry.countedAt || new Date().toISOString()).replace('T', ' ').replace(/\.\d{3}Z$/, ''),
    })),
    format: 'JSONEachRow',
  }).catch(error => console.warn('[explorer] activity totals persist failed', error))
}

// Persisted so a restart serves the last published ranking instead of an empty one; the
// directory's own snapshot table is a keyed payload store, so this needs no new schema.
async function persistActivityLeaderboard(board: ActivityLeaderboard): Promise<void> {
  await client.insert({
    table: 'price_data.account_directory_snapshots',
    values: [{
      snapshot_key: ACTIVITY_LEADERBOARD_SNAPSHOT_KEY,
      payload_json: JSON.stringify(board),
      computed_at: new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ''),
    }],
    format: 'JSONEachRow',
  })
}

async function loadActivityLeaderboard(): Promise<ActivityLeaderboard | null> {
  const res = await client.query({
    query: `SELECT payload_json FROM price_data.account_directory_snapshots FINAL
            WHERE snapshot_key = {key:String} LIMIT 1`,
    query_params: { key: ACTIVITY_LEADERBOARD_SNAPSHOT_KEY }, format: 'JSONEachRow',
  })
  const row = (await res.json<{ payload_json: string }>())[0]
  if (!row) return null
  try {
    const board = JSON.parse(row.payload_json) as ActivityLeaderboard
    return Array.isArray(board?.entries) && Number.isSafeInteger(board.rankedDepth) ? board : null
  } catch { return null }
}

// Whatever ranking is currently published. Never triggers a rebuild on the request path:
// a cold process reads the persisted one, and an instance that has never built one
// serves the directory with no activity numbers rather than with the wrong ones.
async function ensureActivityLeaderboard(): Promise<ActivityLeaderboard | null> {
  if (activityLeaderboard) return activityLeaderboard
  activityLeaderboard = await loadActivityLeaderboard().catch(() => null)
  return activityLeaderboard
}
const ACCOUNT_DIRECTORY_SNAPSHOT_MAX_AGE_SECONDS = 10 * 60

// The last page published for `snapshotKey`, with the age that decides how long
// it may still be used.
//
// Serving and refreshing want different answers, so the caller says which it is:
//
//  - `currentGenerationOnly: false` (serving) accepts any page inside the
//    declared age tolerance. The snapshot key already carries the model version
//    (v1/v2/v3), so which columns the payload holds is settled by the key; all
//    that remains to bound is how old the numbers are, and that is exactly what
//    the tolerance says. A page one generation behind is the stale value the
//    directory is supposed to serve while the next one computes.
async function loadAccountDirectorySnapshot(
  snapshotKey: string,
): Promise<{ page: AccountsPage; ageSeconds: number } | null> {
  const res = await client.query({
    query: `SELECT payload_json,dateDiff('second',computed_at,now()) AS age
      FROM price_data.account_directory_snapshots FINAL
      WHERE snapshot_key={snapshotKey:String} LIMIT 1`,
    query_params: { snapshotKey }, format: 'JSONEachRow',
  })
  const row = (await res.json<{ payload_json: string; age: number }>())[0]
  if (!row || Number(row.age) > ACCOUNT_DIRECTORY_SNAPSHOT_MAX_AGE_SECONDS) return null
  try {
    const page = JSON.parse(row.payload_json) as AccountsPage
    return Array.isArray(page?.rows) && Number.isSafeInteger(page.total)
      ? { page, ageSeconds: Math.max(0, Number(row.age)) }
      : null
  } catch { return null }
}

async function persistAccountDirectorySnapshot(snapshotKey: string, page: AccountsPage): Promise<void> {
  await client.insert({
    table: 'price_data.account_directory_snapshots',
    values: [{
      snapshot_key: snapshotKey,
      payload_json: JSON.stringify(page),
      computed_at: new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ''),
    }],
    format: 'JSONEachRow',
  })
}

// ORDER BY clause per sort mode. Rows with no displayed value for the chosen
// column sort last; ties fall back to portfolio value.
const ACCOUNT_SORT_SQL: Record<AccountSort, string> = {
  value: 'isNull(usd_total) ASC, usd_total DESC',
  // Named accounts (tag or on-chain identity) first, alphabetically; the unnamed
  // rest by value.
  identity: 'if(has_identity = 0, 1, 0) ASC, lowerUTF8(disp_name) ASC, usd_total DESC',
  // Exact totals first, then by total. See the activity-ordering note.
  activity: 'activity_count_complete DESC, activity_count DESC, usd_total DESC',
  volume: 'trading_volume_usd DESC, usd_total DESC',
}

// Total number of account rows (single accounts + tagged groups, tag members
// collapsed into one). Offset-independent, so it's cached on its own key and
// reused across pages.
//
// Unlike the pages themselves this keeps the account-value generation in its
// KEY, so a generation change makes it absent rather than stale. The total is
// not served on its own — it is embedded in a page payload, and a page must be
// one generation throughout — and it is only ever computed inside a page
// rebuild that is already running in the background, so invalidating it costs
// no request any latency.
async function getAccountsTotal(): Promise<number> {
  return cachedSwr(`explorer:accounts-total:${accountValueGenerationEpoch}`, 60_000, 30 * 60_000, async () => {
    const res = await client.query({
      query: `
        WITH tags AS (SELECT account_id, any(label_id) AS lid
                        FROM price_data.account_tags FINAL WHERE deleted = 0 GROUP BY account_id)
        SELECT uniqExact(if(t.lid = '', o.account_id, t.lid)) AS total
        FROM (
          SELECT account_id FROM price_data.account_asset_latest_balances GROUP BY account_id
        ) o
        LEFT JOIN tags t ON t.account_id = o.account_id`,
      format: 'JSONEachRow',
    })
    const rows = await res.json<{ total: string }>()
    return Number(rows[0]?.total ?? 0)
  })
}

const ACCOUNTS_FRESH_MS = 60_000
const ACCOUNTS_STALE_MS = 30 * 60_000
// The per-viewer fold's OWN stale window — deliberately much shorter than
// ACCOUNTS_STALE_MS. A per-viewer key is one of (fingerprint × sort × offset
// × limit) in the SAME shared, bounded (5,000-entry) LRU every anonymous key
// also lives in; at 30 minutes, ordinary logged-in traffic — or even one
// session alone, polling near the 120 req/min rate limit across a few pages
// and sorts — could evict the shared directory/hot keys that store exists to
// protect. `generation` already forces a refresh every five minutes
// regardless (accountValueGenerationEpoch), so a much longer stale window
// buys nothing but eviction pressure; this sits on that same order.
const ACCOUNTS_VIEWER_STALE_MS = 5 * 60_000

function accountsCacheKey(sort: AccountSort, offset: number, limit: number): string {
  return `explorer:accounts:${sort}:${offset}:${limit}`
}

// Paginated directory of every account that has a balance observation (seeded
// to the full chain by the snapshot-balances bootstrap). Sorting, money-market
// enrichment, and identity-presence are all resolved server-side so a single
// page can be ordered correctly against the whole set.
export function getAccounts(offset: number, limit: number, sort: AccountSort = 'value'): Promise<AccountsPage> {
  return accountsPage(offset, limit, sort, false)
}

// The prewarm's entry point: rebuild the page for the current generation even
// when a perfectly serveable previous one is cached. A background pass that owns
// refresh must not be satisfied by the value it exists to replace.
function refreshAccountsPage(offset: number, limit: number, sort: AccountSort): Promise<AccountsPage> {
  return accountsPage(offset, limit, sort, true)
}

// The accounts directory, folded under one viewer's OWN tags in addition to
// the shared system ones. Runs the exact same bounded whole-directory query
// getAccounts does (see accountsPage's cost comment) — this adds no new
// ClickHouse work of its own, only a different GROUP BY key for the accounts
// the fold names — but the result is per-viewer, so it is cached (and NOT
// snapshotted or prewarmed) on its own short-TTL key rather than the shared
// SWR entry every anonymous request shares. `fold.ids` empty (a tagless
// viewer, or one whose tags all lose to a system tag) means nothing would
// actually change, so the caller should reach for getAccounts directly
// instead — this still falls back safely if it doesn't.
// A system tag's members as directory rows. Null when no such tag exists, so
// the route answers 404 rather than an empty list that reads as "no members".
export function getTagMemberAccounts(tagId: string, sort: AccountSort = 'value'): Promise<AccountsPage> | null {
  const members = tagMembers(tagId)
  return members ? getAccountsForMembers(members, sort) : null
}

// The directory rows for exactly these accounts — one row each, never folded
// under the tag they all share. Powers a tag page's member list, so a tag reads
// like the directory it is a slice of. `keepOrder` returns the rows in the
// CALLER's member sequence instead of the directory sort — a user list tag's
// members carry the order their owner arranged them in, and the page should
// show that arrangement, not re-rank it by value.
export async function getAccountsForMembers(members: string[], sort: AccountSort = 'value', keepOrder = false): Promise<AccountsPage> {
  const ids = [...new Set(members.map(m => m.toLowerCase()))].sort()
  if (!ids.length) return { rows: [], total: 0 }
  const page = await accountsPage(0, Math.min(ids.length, 500), sort, false, ids)
  if (!keepOrder) return page
  const position = new Map(members.map((m, i) => [m.toLowerCase(), i]))
  const rows = [...page.rows].sort((a, b) =>
    (position.get(a.account?.accountId?.toLowerCase() ?? '') ?? Number.MAX_SAFE_INTEGER)
    - (position.get(b.account?.accountId?.toLowerCase() ?? '') ?? Number.MAX_SAFE_INTEGER))
  return { ...page, rows }
}

async function accountsPage(offset: number, limit: number, sort: AccountSort, refresh: boolean, members?: string[]): Promise<AccountsPage> {
  // Whole-directory ranking: every rebuild re-aggregates all balances (+ MM
  // positions, and full-history volume CTEs for some sorts) just to render one
  // page — seconds of ClickHouse time. Serve stale-while-revalidating so no
  // request ever waits on it: within the fresh window the cached page is
  // returned, and afterwards — including when the five-minute account-value
  // generation advances — the previous page is returned while the next one
  // computes in the background.
  const key = accountsCacheKey(sort, offset, limit)
  const snapshotKey = `${sort}:${offset}:${limit}`
  // A member-scoped page reads only those accounts' balances, so it costs a
  // fraction of the whole-directory ranking and needs none of its
  // stale-while-revalidate machinery — an ordinary cache is enough.
  const memberKey = members ? `:m${members.length}:${members.join(',')}` : ''
  const build = async (): Promise<AccountsPage> => {
    // The persisted snapshot ranks the WHOLE directory under the shared
    // system-tag grouping; a page scoped to one tag's members must not adopt it
    // — it is a different row set entirely.
    if (!members) {
      const current = await loadAccountDirectorySnapshot(snapshotKey).catch(() => null)
      if (current) return current.page
    }
    const prices = await ensureAccountValuePrices()
    const { idsSql, unitsSql } = priceTransformArrays(prices)
    const orderBy = ACCOUNT_SORT_SQL[sort] ?? ACCOUNT_SORT_SQL.value
    const includeActivitySort = sort === 'activity'
    const includeVolumeSort = sort === 'volume'
    const memberFilter = members ? `WHERE l.account_id IN {members:Array(String)}` : ''
    // Every CTE below groups by this SAME `gkey` — a system tag's label_id when
    // the account has one, else the account itself. Scoped to one tag's members
    // the tag IS the page, so grouping by it would collapse every member into
    // the single row the reader just came from; each member is its own row.
    const gkeySql = (idExpr: string): string =>
      members ? idExpr : `if(t.lid = '', ${idExpr}, t.lid)`
    const labelIdSql = (): string => members ? `''` : 't.lid'
    // The activity ordering and value both come from the background leaderboard, keyed
    // on the same gkey this query groups by. An account outside the pool has no counted
    // total, so it sorts last and renders no number — never a number from another model.
    // Read on EVERY sort, not just sort=activity: the leaderboard is an in-process
    // object spliced in as a `transform()` literal, so the Activity column costs no
    // query — gating it on the sort only meant the column read as empty by default.
    const leaderboard = await ensureActivityLeaderboard()
    // Totals come from the swept table by JOIN, not as a literal: the directory has
    // 114k grouping keys and interpolating them would be megabytes of query text.
    const activityJoin = 'LEFT JOIN price_data.account_activity_totals AS act FINAL ON act.gkey = g.gkey'
    const activitySelect = 'ifNull(act.total, toUInt64(0))'
    // Exact totals rank above partial ones: a partial is a floor, so ordering it against
    // an exact number would put a "known to be at least this" above a "known to be this".
    const activityCompleteSelect = 'ifNull(act.complete, 0)'
    const volumeCte = includeVolumeSort ? `,
            trade_volume_raw AS (
              SELECT account AS account_id, toFloat64(sum(${accountVolumeSource().col})) AS volume_usd
              FROM ${accountVolumeSource().table}
              WHERE match(account, '^0x[0-9a-f]{64}$')
              GROUP BY account_id
            ),
            trade_volume AS (
              SELECT ${gkeySql('v.account_id')} AS gkey, sum(v.volume_usd) AS volume_usd
              FROM (
                SELECT
                  vr.account_id AS account_id,
                  sum(vr.volume_usd) AS volume_usd
                FROM trade_volume_raw vr
                GROUP BY account_id
              ) v
              LEFT JOIN tags t ON t.account_id = v.account_id
              GROUP BY gkey
            )` : ''
    const volumeJoin = includeVolumeSort ? 'LEFT JOIN trade_volume tv ON tv.gkey = g.gkey' : ''
    const volumeSelect = includeVolumeSort ? 'ifNull(tv.volume_usd, 0.)' : '0.'
    const [res, total] = await Promise.all([
      client.query({
        query: `
          WITH
            tags AS (SELECT account_id, any(label_id) AS lid, any(label_name) AS lname, any(color) AS c, any(icon) AS ic
                       FROM price_data.account_tags FINAL WHERE deleted = 0 GROUP BY account_id),
            latest AS (
              SELECT
                l.account_id AS account_id,
                l.asset_id AS asset_id, l.bal AS bal, l.lb AS lb
              FROM (
                SELECT
                  account_id,
                  asset_id,
                  toUInt256OrZero(argMaxMerge(total_state)) AS bal,
                  maxMerge(last_block_state) AS lb
                FROM price_data.account_asset_latest_balances
                GROUP BY account_id, asset_id
              ) l
              ${memberFilter}
            ),
            -- One name per account across every identity source: lowest chain
            -- priority wins (0 = Basilisk), chain key breaks a tie so the
            -- directory's identity sort is stable. Blank displays are retired
            -- rows, not identities.
            -- Filtering happens in the inner query: naming the aggregate "display"
            -- while also filtering on the column of that name resolves the WHERE
            -- predicate to the aggregate, which ClickHouse rejects.
            ident AS (
              SELECT account_id, argMin(display, (priority, chain)) AS display
              FROM (
                SELECT lower(account_id) AS account_id, display, priority, chain
                FROM price_data.account_identities FINAL
                WHERE display != ''
              )
              GROUP BY account_id
            ),
            grouped AS (
              SELECT
                ${gkeySql('latest.account_id')} AS gkey,
                ${labelIdSql()} AS label_id, any(t.lname) AS lname, any(t.c) AS color, any(t.ic) AS icon,
                uniqExact(latest.account_id) AS members, any(latest.account_id) AS sample, max(latest.lb) AS last_block,
                sum(toFloat64(latest.bal) * transform(latest.asset_id, ${idsSql}, ${unitsSql}, 0.)) AS usd,
                -- Per-asset USD merged across the group's members → top-holding icons.
                sumMap([latest.asset_id], [toFloat64(latest.bal) * transform(latest.asset_id, ${idsSql}, ${unitsSql}, 0.)]) AS asset_usd_map
              FROM latest LEFT JOIN tags t ON t.account_id = latest.account_id
              GROUP BY gkey, label_id
            )
            ${volumeCte}
          SELECT
            g.label_id, g.lname, g.color, g.icon, g.members, g.sample, g.last_block, g.usd AS usd,
            g.usd AS usd_total,
            if(g.label_id != '' OR ident.account_id != '', 1, 0) AS has_identity,
            multiIf(g.label_id != '', g.lname, ident.display != '', ident.display, '') AS disp_name,
            ${activitySelect} AS activity_count,
            ${activityCompleteSelect} AS activity_count_complete,
            ${volumeSelect} AS trading_volume_usd,
            -- (asset_id, usd) for the 4 largest holdings, highest first: worth > $10
            -- AND ≥ 10% of the group's total held value (arraySum of the map).
            arraySlice(
              arrayReverseSort(x -> tupleElement(x, 2),
                arrayFilter(x -> tupleElement(x, 2) > 10. AND tupleElement(x, 2) >= 0.10 * arraySum(tupleElement(g.asset_usd_map, 2)),
                  arrayZip(tupleElement(g.asset_usd_map, 1), tupleElement(g.asset_usd_map, 2)))),
              1, 4) AS top_assets,
            -- Every OTHER holding worth more than the same $10. The shown four
            -- also need a 10% share, so an account spread across many similar
            -- positions shows one icon and a count rather than looking empty.
            -- Counted over the same map the icons come from, so a row's icons
            -- and its count always agree.
            greatest(0, toUInt32(arrayCount(v -> v > 10., tupleElement(g.asset_usd_map, 2))) - toUInt32(length(top_assets))) AS other_assets
          FROM grouped g
          LEFT JOIN ident ON g.label_id = '' AND lower(g.sample) = ident.account_id
          ${activityJoin}
          ${volumeJoin}
          ORDER BY ${orderBy}
          LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
        query_params: { limit, offset, ...(members ? { members } : {}) },
        format: 'JSONEachRow',
      }),
      // A member-scoped page is NOT a page of the directory: its total is the
      // tag's own membership, and reporting the chain-wide count there would
      // have a seven-member tag claim to be the first page of something vastly
      // larger.
      members ? Promise.resolve(members.length) : getAccountsTotal(),
    ])

    const raw = await res.json<{
      label_id: string; lname: string; color: string; icon: string; members: string; sample: string
      last_block: number; usd: number; usd_total: number
      has_identity: number; activity_count: number; activity_count_complete: number; trading_volume_usd: number
      top_assets: [string, number][]
      other_assets: number
    }>()

    const rows: TopAccountRow[] = raw.map(r => {
      const isTag = r.label_id !== ''
      return {
        account: isTag ? null : accountRef(r.sample),
        tag: isTag ? { tagId: r.label_id, name: r.lname, color: r.color, icon: tagIcon(r.label_id, r.icon), memberCount: Number(r.members) } : null,
        portfolioUsd: r.usd_total, lastBlock: r.last_block,
        // Prefer the on-chain identity display name for single-account rows; tag
        // groups keep their tag label.
        identity: isTag ? r.lname : (identityForAccount(r.sample)?.display ?? null),
        activityCount: r.activity_count > 0 ? Number(r.activity_count) : undefined,
        // A partial total is a floor, and says so rather than passing for exact.
        activityCountComplete: r.activity_count > 0 ? r.activity_count_complete === 1 : undefined,
        tradingVolumeUsd: r.trading_volume_usd > 0 ? Number(r.trading_volume_usd) : undefined,
        topAssets: r.top_assets?.length ? r.top_assets.map(([id, valueUsd]) => ({ asset: asset(id), valueUsd })) : undefined,
        otherAssets: r.other_assets > 0 ? Number(r.other_assets) : undefined,
      }
    })

    // The enrichment passes below each re-derive "which accounts does this row
    // cover" from `raw[i]` themselves (member expansion is cheap; re-deriving
    // avoids a parallel array to keep in sync).

    // Sparkline + counter enrichment is best-effort — a failure (RPC down, table
    // missing) must never take the directory itself down.
    try {
      await enrichAccountRows(raw, rows)
    } catch (err) {
      console.error('[accounts] row enrichment failed:', err)
    }

    // Overwrite the wallet-only sparkline with the full-portfolio series the detail
    // page shows (parity). Best-effort — on failure the wallet-only fallback stands.
    try {
      await enrichAccountSparklines(raw, rows)
    } catch (err) {
      console.error('[accounts] sparkline parity enrichment failed:', err)
    }

    // The activity ordering is only established for the leaderboard's ranked prefix, so
    // the page publishes that depth and the pager offers nothing past it. Only the
    // activity ORDERING is bounded that way — every other sort ranks the whole
    // directory and must keep its full pager even though it now shows the same
    // leaderboard's counts.
    const page: AccountsPage = { rows, total, ...(includeActivitySort && leaderboard ? { rankedDepth: leaderboard.rankedDepth } : {}) }
    await persistAccountDirectorySnapshot(snapshotKey, page).catch(err => console.error('[accounts] snapshot persist failed:', err))
    return page
  }

  // Read the generation once: labelling the result with the generation the
  // rebuild STARTED from can only under-claim freshness, so one that advanced
  // mid-rebuild is refreshed again rather than passing for current.
  const generation = accountValueGenerationEpoch
  // A tag's own members: a small, bounded row set read from those accounts'
  // balances alone, so the seconds-long whole-directory machinery above does
  // not apply. Same freshness as the directory it mirrors.
  if (members) return cachedSwr(`tag-accounts:${sort}${memberKey}`, ACCOUNTS_FRESH_MS, ACCOUNTS_VIEWER_STALE_MS, build, generation)
  if (refresh) return cacheRefresh(key, ACCOUNTS_FRESH_MS, ACCOUNTS_STALE_MS, build, generation)
  // Nothing cached means a restarted process or an evicted key, not that no page
  // exists: adopt the last persisted one as the stale value so this request
  // serves it too, for whatever is left of the tolerance it was published under.
  await seedStale(key, async () => {
    const persisted = await loadAccountDirectorySnapshot(snapshotKey)
    if (!persisted) return null
    return { value: persisted.page, staleMs: (ACCOUNT_DIRECTORY_SNAPSHOT_MAX_AGE_SECONDS - persisted.ageSeconds) * 1000 }
  }).catch(() => false)
  return cachedSwr(key, ACCOUNTS_FRESH_MS, ACCOUNTS_STALE_MS, build, generation)
}

// Which accounts a directory row covers: a system tag's own full membership
// (tagService's in-memory index) or the row's single sampled account. Shared by
// every enrichment pass below so a row can never disagree with itself about
// which accounts it covers.
function rowMemberAccounts(r: { label_id: string; sample: string }): string[] {
  return r.label_id !== '' ? (getTagRecord(r.label_id)?.members ?? []) : [r.sample]
}

// Per-row enrichment for the accounts directory: the 1Y value sparkline and the
// activity counter, batched per page. Once the resumable historical aggregate is
// complete, this reads weekly states; during deployment/backfill it retains the
// equivalent raw-observation query as a correctness-first fallback.
async function enrichAccountRows(
  raw: { label_id: string; sample: string; usd: number }[],
  rows: TopAccountRow[],
): Promise<void> {
  // Account set per row: tag rows expand to their members. Pallet/sovereign
  // accounts (modl/sibl/para) are excluded from the raw-observation history scan,
  // where a single busy pallet account can own tens of millions of balance events.
  // Their sparkline remains absent unless a complete historical source is
  // available; current balances are never projected backward.
  const isModuleAccount = (a: string) => /^0x(6d6f646c|7369626c|70617261)/.test(a)
  const rowMembers: string[][] = raw.map(r => rowMemberAccounts(r).filter(m => ACCOUNT_RE.test(m)))
  const rowHistorySubstrate: string[][] = rowMembers.map(members => members.filter(m => !isModuleAccount(m)))
  const rowModuleAccounts: string[][] = rowMembers.map(members => members.filter(isModuleAccount))
  const rowAccounts: string[][] = rowHistorySubstrate.map(members => [...new Set(members)])
  const all = [...new Set(rowAccounts.flat())]
  const moduleAccounts = [...new Set(rowModuleAccounts.flat())]
  if (!all.length && !moduleAccounts.length) return
  const list = all.length ? sqlAccountList(all) : "''"

  const winStart = sparklineCalendarWindowStart().toISOString().slice(0, 10)

  // The weekly-state query merges all pre-window states into bucket -1, whose argMax is
  // the exact baseline. It no longer also counts distinct balance observations: that
  // count used to fill the directory's Activity cell, and the cell now carries the
  // account's own feed total from the background ranking instead.
  let allObs: { account_id: string; asset_id: string; b: number; bal: string }[] = []
  if (all.length) {
    const obsRes = await client.query({
      query: `SELECT
              account_id,
              asset_id,
              toInt32(greatest(dateDiff('week', {ws:Date}, week_start), -1)) AS b,
              argMaxMerge(balance_state) AS bal
            FROM price_data.account_balance_weekly
            WHERE account_id IN (${list})
              AND week_start < addWeeks({ws:Date}, ${SPARK_WEEKS})
            GROUP BY account_id, asset_id, b`,
      query_params: { ws: winStart },
      format: 'JSONEachRow',
    })
    allObs = await obsRes.json<{ account_id: string; asset_id: string; b: number; bal: string }>()
  }
  const obsRows = allObs.filter(r => r.asset_id !== '' && r.b >= 0)
  const baseRows = allObs.filter(r => r.asset_id !== '' && r.b === -1)

  let moduleBalanceRows: { account_id: string; asset_id: string; bal: string }[] = []
  if (moduleAccounts.length) {
    const moduleList = sqlAccountList([...new Set(moduleAccounts)])
    const moduleRes = await client.query({
      query: `SELECT account_id, asset_id, toString(sum(bal_u256)) AS bal
              FROM (
                SELECT
                  account_id,
                  asset_id,
                  toUInt256OrZero(argMaxMerge(total_state)) AS bal_u256
                FROM price_data.account_asset_latest_balances
                WHERE account_id IN (${moduleList})
                GROUP BY account_id, asset_id
              )
              GROUP BY account_id, asset_id
              HAVING sum(bal_u256) > 0`,
      format: 'JSONEachRow',
    })
    moduleBalanceRows = await moduleRes.json<{ account_id: string; asset_id: string; bal: string }>()
  }

  // Weekly closes for every involved asset, keyed by its own id.
  const assetIds = [...new Set([...obsRows, ...baseRows].map(r => r.asset_id).concat(moduleBalanceRows.map(r => r.asset_id)))]
  const priceIdFor = new Map(assetIds.map(id => [id, String(Number(id))]))
  const priceIds = sqlUIntList([...priceIdFor.values()])
  const pricesByPriceId = new Map<string, Map<number, number>>()
  if (priceIds) {
    const pxRes = await client.query({
      query: `SELECT toString(asset_id) AS asset_id,
                toUInt32(greatest(least(dateDiff('week', {ws:Date}, toDate(interval_start)), ${SPARK_WEEKS - 1}), 0)) AS b,
                toFloat64(argMaxMerge(close_state)) AS close
              FROM price_data.ohlc_1w
              WHERE interval_start >= toDateTime({ws:Date}) - INTERVAL 7 DAY
                AND interval_start < addWeeks(toDateTime({ws:Date}), ${SPARK_WEEKS})
                AND asset_id IN (${priceIds})
              GROUP BY asset_id, interval_start
              ORDER BY asset_id, interval_start`,
      query_params: { ws: winStart }, format: 'JSONEachRow',
    })
    for (const r of await pxRes.json<{ asset_id: string; b: number; close: number }>()) {
      if (!(r.close > 0)) continue
      if (!pricesByPriceId.has(r.asset_id)) pricesByPriceId.set(r.asset_id, new Map())
      pricesByPriceId.get(r.asset_id)!.set(r.b, r.close)   // later interval wins within a bucket
    }
  }
  const pricesByAsset: Record<string, Map<number, number>> = {}
  const decimalsById = new Map<string, number>()
  for (const id of assetIds) {
    pricesByAsset[id] = pricesByPriceId.get(priceIdFor.get(id)!) ?? new Map()
    decimalsById.set(id, asset(id).decimals)
  }

  const obsByAccount = new Map<string, { account_id: string; asset_id: string; b: number; bal: string }[]>()
  for (const r of obsRows) (obsByAccount.get(r.account_id) ?? obsByAccount.set(r.account_id, []).get(r.account_id)!).push(r)
  const baseByAccount = new Map<string, { asset_id: string; bal: string }[]>()
  for (const r of baseRows) (baseByAccount.get(r.account_id) ?? baseByAccount.set(r.account_id, []).get(r.account_id)!).push(r)
  const moduleBalancesByAccount = new Map<string, { account_id: string; asset_id: string; bal: string }[]>()
  for (const r of moduleBalanceRows) (moduleBalancesByAccount.get(r.account_id) ?? moduleBalancesByAccount.set(r.account_id, []).get(r.account_id)!).push(r)
  const volumeByAccount = await tradingVolumeByAccount(all)

  rows.forEach((row, i) => {
    const accs = rowAccounts[i]
    const moduleAccs = rowModuleAccounts[i]
    const obs = accs.flatMap(a => obsByAccount.get(a) ?? [])
    const baseline = new Map<string, string>()
    for (const a of accs) for (const b of baseByAccount.get(a) ?? []) baseline.set(`${a}|${b.asset_id}`, b.bal)
    let spark = accs.length ? buildValueSparkline(obs, baseline, pricesByAsset, decimalsById) : null
    const moduleBalances = moduleAccs.flatMap(a => moduleBalancesByAccount.get(a) ?? [])
    // Module/sovereign accounts can have millions of observations. Their current
    // balance is not a historical balance series, so omit the sparkline unless a
    // complete indexed reconstruction is available.
    if (moduleBalances.length) spark = null
    // Pin the final bucket to the page query's authoritative current wallet value
    // (same rule as the detail chart): snapshot-seeded accounts can lack organic
    // observation history, and weekly closes drift from spot.
    if (spark) {
      spark[SPARK_WEEKS - 1] = +Number(raw[i].usd ?? 0).toFixed(2)
      row.sparkline = spark
    }
    if (accs.length) {
      const volume = accs.reduce((s, a) => s + (volumeByAccount.get(a) ?? 0), 0)
      if (volume > 0) row.tradingVolumeUsd = volume
    }
  })
}

// Resample a full-history value series (portfolioSeries + its ascending dates) onto
// the accounts-list sparkline's fixed trailing-year grid: SPARK_WEEKS weekly buckets
// ending at the current (partial) week, forward-filled. Buckets before the account's
// first data are 0 — young accounts are LEFT-PADDED to a full year; data older than a
// year is clamped in (bucket 0 carries the value as of ~1Y ago). Every row's sparkline
// therefore spans the same 1Y window and start positions are comparable across rows.
export function resampleValueSeriesToTrailingYear(values: number[], dates: string[], now: Date = new Date()): number[] {
  const winStartMs = sparklineCalendarWindowStart(now).getTime()
  const pts: { t: number; v: number }[] = []
  for (let i = 0; i < dates.length && i < values.length; i++) {
    const t = Date.parse(dates[i].replace(' ', 'T') + 'Z')
    if (Number.isFinite(t)) pts.push({ t, v: values[i] })
  }
  const out = new Array<number>(SPARK_WEEKS).fill(0)
  let cursor = 0, last = 0, seen = false
  for (let b = 0; b < SPARK_WEEKS; b++) {
    const bucketEnd = winStartMs + (b + 1) * WEEK_MS - 1
    while (cursor < pts.length && pts[cursor].t <= bucketEnd) { last = pts[cursor].v; seen = true; cursor++ }
    out[b] = seen ? +last.toFixed(2) : 0
  }
  return out
}

// Full-portfolio sparkline for the accounts directory.
//
// This reconstruction is the largest single reader in the instance (measured: 59.8 GiB /
// 339M rows / 13.7 s across 72 runs on one deep activity page) because it builds 180
// buckets over an account's ENTIRE life and resampleValueSeriesToTrailingYear then keeps
// only 53 trailing weeks. Clamping the window to that year was built and measured: the
// carry-in is fine (every sub-part establishes its opening value from rng.minb), but
// narrowing the span shrinks each bucket from ~8 days to ~2, so the weekly resampler
// lands on different samples and 92 of 127 live sparklines moved by 1-6% — the list and
// the detail chart would no longer agree, which is exactly the parity this shared path
// exists to guarantee. The cost came out of the reads instead — every per-account
// table this walks is ordered account-first, so the per-account predicate rides the
// primary key; what is left here is the 180-bucket reconstruction itself, not the
// reads under it.
//
// Reuses the detail page's own getAccountHistory so the row sparkline and the
// account/tag value-history chart are computed by the SAME code path (wallet
// balances + XYK LP principal, historical closes) and therefore cannot diverge — the
// earlier wallet-only weekly approximation understated LP-heavy accounts by ~2-3×.
// Overwrites the wallet-only series enrichAccountRows produced, which stays as the
// fallback when the history reconstruction yields nothing (a row never regresses to
// blank). Module/sovereign accounts are excluded — reconstructing their millions of
// pallet observations per directory refresh is far too heavy — so they keep no list
// sparkline (their detail pages still chart in full), matching prior behaviour.
async function enrichAccountSparklines(
  raw: { label_id: string; sample: string; usd_total: number; gkey?: string }[],
  rows: TopAccountRow[],
  foldMembersByKey: Map<string, string[]> | null = null,
): Promise<void> {
  // Row account set = the row's members + their EVM twins, i.e. exactly the
  // relatedAccountIds the detail page feeds getAccountHistory.
  //
  // Pallet/sovereign members (modl/sibl/para) are kept. enrichAccountRows drops them
  // from its raw-observation scan because a busy pallet account alone can own tens
  // of millions of balance
  // events, but this path is the detail page's own reconstruction, which already charts
  // those accounts: /explorer/address/<pallet>/history returns a full 180-bucket series
  // for the treasury and omnipool pallets in 2.1 s each, and account_balance_weekly
  // covers them back to 2022 (6,954 and 3,727 weeks). Dropping them here only made the
  // sparkline disagree with the Value column beside it, which sums every member — so
  // Treasury, Liquidity Mining, Parachain Sovereign,
  // Staking Pot and Pallet Pots showed a value with no series at all.
  const rowAccounts: string[][] = raw.map(r => {
    const members = rowMemberAccounts(r)
    return [...new Set(members.filter(m => ACCOUNT_RE.test(m)))]
  })
  // Each row is an independent multi-query getAccountHistory; bound the fan-out the
  // same way enrichTopAssets does so one page can't stampede ClickHouse.
  const CONCURRENCY = 8
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < rows.length) {
      const i = next++
      const accounts = rowAccounts[i]
      if (!accounts.length) continue   // module-only/tagless → keep enrichAccountRows' fallback
      try {
        // Same scope key the detail page uses, so a row's reconstruction is shared
        // with its account page and with the other sorts this row appears under.
        // A viewer-fold row carries no system label at all (it has its own uuid
        // key instead), so it gets its own namespace — still just a label:
        // getAccountHistoryShared's actual cache key also folds in a fingerprint
        // of `accounts` itself, so two rows can never collide on a shared key
        // wearing two different account sets.
        const gkey = raw[i].gkey
        const scopeKey = gkey && foldMembersByKey?.has(gkey)
          ? `user-tag:${gkey}`
          : (raw[i].label_id !== '' ? `tag:${raw[i].label_id}` : `addr:${raw[i].sample}`)
        const { portfolioSeries, portfolioDates } = await getAccountHistoryShared(accounts, scopeKey)
        if (portfolioSeries.length > 1) {
          // Resample the full-history series onto the fixed trailing-year grid: every
          // row's sparkline spans the same 1Y window, left-padded with 0 for younger
          // accounts so start positions are comparable across rows.
          const series = resampleValueSeriesToTrailingYear(portfolioSeries, portfolioDates)
          // Pin the final bucket to the row's authoritative current value (the Value
          // column; already nets debt) — the same rule getAddressHistory applies.
          series[SPARK_WEEKS - 1] = +Number(raw[i].usd_total ?? 0).toFixed(2)
          rows[i].sparkline = series
        }
      } catch { /* keep the wallet-only fallback from enrichAccountRows */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker))
}

// tag detail — combined portfolio of all members
export interface TagDetail {
  tagId: string
  name: string
  color: string
  note: string
  icon: string
  members: AccountRef[]
  balances: AddressBalance[]
  // Up to 4 largest combined holdings (see AddressDetail.topAssets).
  topAssets: { asset: AssetRef; valueUsd: number }[]
  portfolioUsd: number
  tradingVolumeUsd?: number
  liquidityPositions?: LpPosition[]
  portfolioSeries: number[]
  portfolioDates: string[]
  balanceHistory: AssetBalanceHistory[]
}

// Resolve a tag's canonical member account-id set (validated AccountId32 hexes).
// Shared by getTag and the tag activity/extrinsics/events endpoints so they all
// scope to the same accounts.
function tagMembers(tagId: string): string[] | null {
  const tag = getTagRecord(tagId)
  if (!tag || !tag.members.length) return null
  return tag.members.filter(m => ACCOUNT_RE.test(m))
}

// How often the prewarm wakes, not a bound on anything it produces: the age a
// served payload is actually held to is TAG_DETAIL_REQUEST_MAX_AGE_SECONDS.
const TAG_DETAIL_PREWARM_INTERVAL_MS = 2 * 60_000
const TAG_DETAIL_REQUEST_MAX_AGE_SECONDS = 10 * 60
// The prewarm rebuilds while a request would still accept the stored payload, so
// the oldest snapshot any request can be served stays inside the serving
// tolerance — waking more often than that only rebuilds payloads that would have
// been served anyway. Deriving this from the wake interval instead would rebuild
// every tick and bound nothing.
//
// TWO ticks of headroom, not one. `age` is whole-second arithmetic over a
// second-precision column, so a rebuild landing a second past the tick grid reads
// 479 at the fourth tick, skips, and is 599 by the fifth: measured replacement
// periods of 480 s AND 600 s from a one-tick margin. At 600 s a request stops
// accepting the payload and pays the multi-second reconstruction in the
// foreground — a path that was unreachable before this guard existed, because a
// hot tag was rebuilt every 120 s. Two ticks holds the period at 360-480 s with a
// 120 s margin, which keeps it unreachable. It costs a skip rate of about two in
// three instead of four in five.
const TAG_DETAIL_PREWARM_REBUILD_AGE_SECONDS = TAG_DETAIL_REQUEST_MAX_AGE_SECONDS - 2 * (TAG_DETAIL_PREWARM_INTERVAL_MS / 1000)
const hotTagDetails = new Set<string>(['treasury', 'money-market'])

// The joined member list both tag snapshot tables key on. Lowercased and sorted
// so a reordered or re-cased tag definition still matches a stored payload.
export function tagMembershipList(members: string[]): string {
  return [...members].map(member => member.toLowerCase()).sort().join(',')
}

// Short fingerprint of a LIVE, owner-editable membership (a user tag's), for the
// cache-scope keys the list-tag aggregate view uses. A system tag's membership
// only changes on a code deploy, so its scopes (tagMembershipList above, and the
// bare `tag:<id>` scope strings below) never needed this — but a list owner can
// add or remove a member between two requests, and every cache the member-list
// internals key purely by scope string (activity/extrinsics/events/votes/tab-counts/
// list-totals — none hash the account list themselves) would otherwise keep serving
// the previous membership's answer until its TTL lapses. Folding this into the scope
// makes a membership change take effect immediately: the string itself changes.
function membershipFingerprint(members: string[]): string {
  return createHash('sha256').update(tagMembershipList(members)).digest('hex').slice(0, 16)
}

// Identity of a persisted tag-detail payload: which accounts it covers. Every
// reader and writer of `tag_detail_snapshots.membership_key` must come through
// here, or a key that looks right silently matches nothing.
export function tagDetailMembershipKey(members: string[]): string {
  return tagMembershipList(members)
}

// Both requests and the prewarm read this snapshot, and the rule is the one the
// directory's serving read uses: age inside the declared tolerance, and the same
// model that produced it. Requiring it to be newer than the published
// claim/money-market generations instead would throw away a page that is still
// well inside the tolerance the moment a generation is republished, which is
// exactly when a request most needs it. The model belongs in the payload's
// identity, not in a freshness clause: `membershipKey` carries it (see
// tagDetailMembershipKey) because this table, unlike the directory's, has no
// model version in its key.
async function loadTagDetailSnapshot(tagId: string, membershipKey: string): Promise<TagDetail | null> {
  const res = await client.query({
    query: `SELECT membership_key,payload_json,dateDiff('second',computed_at,now()) AS age
      FROM price_data.tag_detail_snapshots FINAL WHERE tag_id={tagId:String} LIMIT 1`,
    query_params: { tagId }, format: 'JSONEachRow',
  })
  const row = (await res.json<{ membership_key: string; payload_json: string; age: number }>())[0]
  if (!row || row.membership_key !== membershipKey || Number(row.age) > TAG_DETAIL_REQUEST_MAX_AGE_SECONDS) return null
  try {
    const detail = JSON.parse(row.payload_json) as TagDetail
    return detail?.tagId === tagId && Array.isArray(detail.members) ? detail : null
  } catch { return null }
}

// Metadata-only form of the read above, for the prewarm's skip decision: the
// payload is multi-megabyte and the decision does not need it. Same two clauses,
// its own age threshold.
async function tagDetailSnapshotServesUntilNextTick(tagId: string, membershipKey: string): Promise<boolean> {
  const res = await client.query({
    query: `SELECT membership_key,dateDiff('second',computed_at,now()) AS age
      FROM price_data.tag_detail_snapshots FINAL WHERE tag_id={tagId:String} LIMIT 1`,
    query_params: { tagId }, format: 'JSONEachRow',
  })
  const row = (await res.json<{ membership_key: string; age: number }>())[0]
  return !!row && row.membership_key === membershipKey && Number(row.age) < TAG_DETAIL_PREWARM_REBUILD_AGE_SECONDS
}

async function persistTagDetailSnapshot(tagId: string, membershipKey: string, detail: TagDetail): Promise<void> {
  await client.insert({
    table: 'price_data.tag_detail_snapshots',
    values: [{
      tag_id: tagId,
      membership_key: membershipKey,
      payload_json: JSON.stringify(detail),
      computed_at: new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ''),
    }],
    format: 'JSONEachRow',
  })
}

// The member-set builder behind getTag, extracted so the user-tag aggregate view
// (getListTagDetail below) can share it over an arbitrary, live-editable member
// list. `presentation` is display-only (name/color/icon/note + the id to stamp on
// the response) — everything else is derived from `members`. `opts.snapshot` is the
// system-tag-only ClickHouse persistence layer (see loadTagDetailSnapshot /
// persistTagDetailSnapshot); omitting it (as the list-tag callers do) means the
// result is held only by the `cached()` wrapper below, never written to
// `tag_detail_snapshots` — a user tag's membership can change at any time, and that
// table has no per-caller bound on how many rows accumulate. `opts.scope` is the key
// getAccountHistoryShared uses for the (much longer-lived) portfolio-history cache
// it shares with the account page; system tags pass the same bare `tag:<id>` scope
// they always have, so their history entries keep landing on the same cache rows.
// A snapshot payload was serialized with whatever presentation was current when it
// was computed, and its key is (tag_id, membership_key) — so editing only a tag's
// name, colour, icon or note leaves the key alone and the stale text keeps being
// served until membership happens to change. Presentation is canonical in code and
// display-only (everything else in the payload derives from the member set), so
// stamp the current values over the cached ones rather than discard a snapshot
// that is otherwise still valid. Without this, reconcileTagPresentation reaches
// the table, the in-memory record and every SQL aggregate — but not this page.
export function withTagPresentation<T extends TagPresentation>(detail: T, presentation: TagPresentation): T {
  return { ...detail, ...presentation }
}

export interface TagPresentation { tagId: string; name: string; color: string; icon: string; note: string }

async function buildTagDetailForMembers(
  presentation: TagPresentation,
  members: string[],
  opts: {
    summary?: boolean
    refresh?: boolean
    cacheKey: string
    ttlMs?: number
    scope: string
    snapshot?: { tagId: string; membershipKey: string }
  },
): Promise<TagDetail> {
  const summary = opts.summary === true
  const refresh = opts.refresh === true
  return cached(opts.cacheKey, opts.ttlMs ?? 30_000, async () => {
    if (opts.snapshot && !summary && !refresh) {
      const snapshot = await loadTagDetailSnapshot(opts.snapshot.tagId, opts.snapshot.membershipKey).catch(() => null)
      if (snapshot) return withTagPresentation(snapshot, presentation)
    }
    const list = sqlAccountList(members)
    const [balanceRows, lockBreakdowns, prices] = await Promise.all([
      queryAggregatedBalances(list),
      summary ? Promise.resolve(new Map<number, AssetLockBreakdown>()) : queryLockBreakdownsSafe(list),
      ensureAccountValuePrices(),
    ])
    let balances: AddressBalance[] = valueAccountBalances(balanceRows, prices)

    const tagHistoryAccounts = [...new Set(members)]
    // LP stays (it feeds the displayed value); only the heavy portfolio-history
    // walk — which the card does not show — is skipped in summary.
    const [history, xykLp] = await Promise.all([
      summary
        ? Promise.resolve({ portfolioSeries: [] as number[], portfolioDates: [] as string[], balanceHistory: [] as AssetBalanceHistory[] })
        : getAccountHistoryShared(tagHistoryAccounts, opts.scope),
      getXykPositions(members, balances),
    ])
    const lpPositions = [...xykLp].sort((x, y) => (y.valueUsd ?? 0) - (x.valueUsd ?? 0))
    // Attach the lock/reserve components once the display rows are final.
    balances = attachLockBreakdowns(balances, lockBreakdowns)
    const lpUsd = lpPositions.reduce((s, p) => s + (p.valueUsd ?? 0), 0)
    const portfolioUsd = balances.reduce((s, b) => s + (b.valueUsd ?? 0), 0) + lpUsd
    // Pin the history's last point to the current net worth (see getAddress) so the
    // chart ends at the displayed figure.
    const portfolioSeries = history.portfolioSeries.slice()
    if (portfolioSeries.length) portfolioSeries[portfolioSeries.length - 1] = +portfolioUsd.toFixed(2)
    const tradingVolumeUsd = await tradingVolumeByAccount([...new Set(members)]).then(m => [...m.values()].reduce((s, v) => s + v, 0))
    const detail: TagDetail = {
      tagId: presentation.tagId, name: presentation.name, color: presentation.color, note: presentation.note, icon: presentation.icon,
      members: members.map(accountRef), balances, topAssets: topHeldTokens(balances), portfolioUsd,
      ...(tradingVolumeUsd > 0 ? { tradingVolumeUsd } : {}),
      liquidityPositions: lpPositions,
      portfolioSeries, portfolioDates: history.portfolioDates,
      // Holdings without indexed historical observations remain absent rather
      // than being projected backward from their current balance.
      balanceHistory: summary ? [] : history.balanceHistory,
    }
    if (opts.snapshot && !summary) await persistTagDetailSnapshot(opts.snapshot.tagId, opts.snapshot.membershipKey, detail)
      .catch(error => console.error('[tag-detail] snapshot persist failed', error))
    return detail
  })
}

export async function getTag(tagId: string, opts: { summary?: boolean; refresh?: boolean } = {}): Promise<TagDetail | null> {
  const tag = getTagRecord(tagId)
  if (!tag || !tag.members.length) return null
  // `summary` (hover card) skips the portfolio-history reconstruction — which for a
  // large tag walks every member's transfer log and dominates the response. The
  // detail page still gets the full object.
  const summary = opts.summary === true
  const refresh = opts.refresh === true
  const membershipKey = tagDetailMembershipKey(tag.members)
  if (!summary) hotTagDetails.add(tagId)
  return buildTagDetailForMembers(
    { tagId: tag.tagId, name: tag.name, color: tag.color, icon: tag.icon, note: tag.note },
    tag.members,
    {
      summary, refresh,
      cacheKey: `explorer:tag:${accountValueGenerationEpoch}:${tagId}${summary ? ':summary' : refresh ? ':refresh' : ''}`,
      ttlMs: 8000,
      scope: `tag:${tagId}`,
      snapshot: { tagId, membershipKey },
    },
  )
}

// Tag feeds use the same account-set implementations as account detail feeds.
export async function getTagActivity(tagId: string, type = 'all', limit = 40, offset = 0, action?: string, filters: ValueListFilters = {}, from?: string, to?: string): Promise<ActivityRow[] | null> {
  const members = tagMembers(tagId)
  if (!members) return null
  return getScopedAccountActivity(members, `tag:${tagId}`, type, limit, offset, action, filters, from, to)
}
export async function getTagExtrinsics(tagId: string, limit = 25, offset = 0, filters: ExtrinsicListFilters = {}, from?: string, to?: string): Promise<ExtrinsicSummary[] | null> {
  const members = tagMembers(tagId)
  if (!members) return null
  return getAccountExtrinsics(members, limit, offset, `tag-extrinsics:${tagId}`, filters, from, to)
}
export async function getTagEvents(tagId: string, limit = 25, offset = 0, filters: EventListFilters = {}, from?: string, to?: string): Promise<EventRow[] | null> {
  const members = tagMembers(tagId)
  if (!members) return null
  return getAccountEvents(members, limit, offset, `tag-events:${tagId}`, filters, from, to)
}
export async function getTagVotes(tagId: string, limit = 25, offset = 0, from?: string, to?: string, filters: VoteListFilters = {}): Promise<VoteRow[] | null> {
  const members = tagMembers(tagId)
  if (!members) return null
  return getScopedVotes(members, `tag:${tagId}`, limit, offset, from, to, filters)
}
export async function getTagVotesByReferendum(tagId: string, limit = 25, offset = 0): Promise<VotesByReferendumPage | null> {
  const members = tagMembers(tagId)
  if (!members) return null
  return getScopedVotesByReferendum(members, `tag:${tagId}`, limit, offset)
}

// ── User-tag aggregate view ───────────────────────────────────────────────────
// A list tag's own combined view — same shape and same member-list internals
// as a system tag's, but over a LIVE, owner-editable member set instead of a
// code-defined one. The route layer resolves permission + the tag's presentation
// fields and members (userListService.visibleTagMembers) and passes them in
// here; this file never reads userListService's maps directly. Deliberately
// excluded from hotTagDetails / hotTagCounts / startTagCountsPrewarm and from the
// tag_detail_snapshots / tag_activity_counts ClickHouse tables: those exist to
// amortize cost over a small, fixed set of code-defined tags, and a user can
// create/delete arbitrarily many list tags at will.
export interface ListTagPresentation { tagId: string; name: string; color: string; icon: string; note: string }

function listTagMembers(members: string[]): string[] {
  return members.filter(m => ACCOUNT_RE.test(m))
}
// Every cache the member-list internals key purely by this scope string (none of
// them hash the account list themselves — see membershipFingerprint above), so the
// fingerprint is what makes a membership edit invalidate the tag's caches at once
// rather than after whichever TTL happens to be longest (tab-counts alone holds
// 600s). `tagId` keeps two list tags with an identical membership from sharing
// one cache row; `listId` keeps two lists' tags namespaced apart too, though
// tag ids are already unique per list.
function listTagScope(listId: string, tagId: string, members: string[]): string {
  return `list-tag:${listId}:${tagId}:${membershipFingerprint(members)}`
}

export async function getListTagDetail(listId: string, presentation: ListTagPresentation, members: string[], opts: { summary?: boolean } = {}): Promise<TagDetail | null> {
  const valid = listTagMembers(members)
  if (!valid.length) return null
  const summary = opts.summary === true
  const scope = listTagScope(listId, presentation.tagId, valid)
  return buildTagDetailForMembers(presentation, valid, { summary, cacheKey: `explorer:${scope}${summary ? ':summary' : ''}`, scope })
}
export async function getListTagActivity(listId: string, tagId: string, members: string[], type = 'all', limit = 40, offset = 0, action?: string, filters: ValueListFilters = {}, from?: string, to?: string): Promise<ActivityRow[]> {
  const valid = listTagMembers(members)
  if (!valid.length) return []
  return getScopedAccountActivity(valid, listTagScope(listId, tagId, valid), type, limit, offset, action, filters, from, to)
}
// The cacheKey MUST name the list kind as well as the scope: both builders
// compose `explorer:<cacheKey>:<limit>:<offset>:<from>:<to>:<filterKey>`, so a
// bare shared scope made the unfiltered extrinsics and events keys byte-equal —
// whichever was asked first within the 8s TTL fed the OTHER list its payload,
// and the events tab crashed rendering extrinsic rows (CallPill on a row with
// no `name`). The addr-*/tag-* callers already carry this prefix.
export async function getListTagExtrinsics(listId: string, tagId: string, members: string[], limit = 25, offset = 0, filters: ExtrinsicListFilters = {}, from?: string, to?: string): Promise<ExtrinsicSummary[]> {
  const valid = listTagMembers(members)
  if (!valid.length) return []
  return getAccountExtrinsics(valid, limit, offset, `list-tag-extrinsics:${listTagScope(listId, tagId, valid)}`, filters, from, to)
}
export async function getListTagEvents(listId: string, tagId: string, members: string[], limit = 25, offset = 0, filters: EventListFilters = {}, from?: string, to?: string): Promise<EventRow[]> {
  const valid = listTagMembers(members)
  if (!valid.length) return []
  return getAccountEvents(valid, limit, offset, `list-tag-events:${listTagScope(listId, tagId, valid)}`, filters, from, to)
}
export async function getListTagVotes(listId: string, tagId: string, members: string[], limit = 25, offset = 0, from?: string, to?: string, filters: VoteListFilters = {}): Promise<VoteRow[]> {
  const valid = listTagMembers(members)
  if (!valid.length) return []
  return getScopedVotes(valid, listTagScope(listId, tagId, valid), limit, offset, from, to, filters)
}
export async function getListTagVotesByReferendum(listId: string, tagId: string, members: string[], limit = 25, offset = 0): Promise<VotesByReferendumPage> {
  const valid = listTagMembers(members)
  if (!valid.length) return { rows: [], total: 0, complete: true }
  return getScopedVotesByReferendum(valid, listTagScope(listId, tagId, valid), limit, offset)
}
// Mirrors getAddressTabCounts' simplicity (getAccountTabCounts's own in-process
// cache), not getTagTabCounts' persisted-snapshot/background-refresh machinery —
// that machinery exists to amortize a fixed set of code-defined tags, which a
// list tag is not.
export async function getListTagTabCounts(listId: string, tagId: string, members: string[]): Promise<TabCounts> {
  const valid = listTagMembers(members)
  if (!valid.length) return { extrinsics: 0, extrinsicsOnBehalf: 0, events: 0, votes: 0 }
  return getAccountTabCounts(valid, listTagScope(listId, tagId, valid))
}
export async function getListTagListTotal(listId: string, tagId: string, members: string[], query: ScopedListQuery): Promise<ScopedListTotal> {
  const valid = listTagMembers(members)
  if (!valid.length) return { total: 0, complete: true }
  return scopedListTotal(valid, listTagScope(listId, tagId, valid), query)
}
export async function getListTagValueEvents(listId: string, tagId: string, members: string[], from?: string, to?: string): Promise<ValueEvent[]> {
  const valid = listTagMembers(members)
  if (!valid.length) return []
  const scope = listTagScope(listId, tagId, valid)
  const historyAccounts = [...new Set(valid)]
  return getAccountValueEvents(historyAccounts, scope, from, to, VALUE_EVENT_DEFAULT_LIMIT, historyAccounts)
}

// daily activity (bar charts)
// Daily activity histogram, parameterized so the chart above a list mirrors the
// list's own tab + filters (activity type, action, token; vote conviction). The
// counts are event-level per category — the merged activity's cross-category
// exclusions and $-value filters aren't replicated here (a coarse histogram).
export interface DailyFilters { type?: string; action?: string; token?: string }
const TRANSFER_EVENTS = ['Balances.Transfer', 'Tokens.Transfer', 'Currencies.Transferred']
// This list, LIQUIDITY_AMOUNT_ARG and HISTOGRAM_SWAP_EVENTS_SQL mirror the event
// sets clickhouse/schema/003_materialized_views.sql ingests, and the parity is
// pinned by tests: they are trimmed together with the schema, never here alone.
const LIQUIDITY_EVENTS = ['XYK.LiquidityAdded', 'XYK.LiquidityRemoved', 'XYK.PoolCreated', 'XYK.PoolDestroyed', 'LBP.LiquidityAdded', 'LBP.LiquidityRemoved', 'XYKLiquidityMining.RewardClaimed']
// Every event the vote CATEGORY renders: the capital-locking conviction/Democracy
// votes plus the collective (Council / Technical Committee) ones the feed merges
// in. Used for the daily histogram's name set and for transfer subordination (a
// collective vote's extrinsic owns its fee/plumbing legs like any other activity).
// Governance rows are BSX-denominated whichever pallet cast them — a collective
// vote locks nothing but is still a BSX-tagged row in every feed (its VoteRow
// carries the BSX descriptor with no amount), so the BSX token predicates below
// and the histogram MV's `asset_refs` treat all four names alike.
const VOTE_EVENTS = ['ConvictionVoting.Voted', 'Democracy.Voted', ...COLLECTIVE_VOTE_EVENTS]
const sqlNames = (names: readonly string[]) => names.map(n => `'${n}'`).join(',')

export async function getDailyActivity(scope: string, filters: DailyFilters = {}): Promise<{ date: string; value: number }[]> {
  const type = normalizeActivityTypeKey(filters.type ?? 'all')
  const key = `${scope}:${type}:${filters.action ?? ''}:${filters.token ?? ''}`
  return cached(`explorer:daily:${key}`, 300000, async () => {
    const since = `block_timestamp > now() - INTERVAL 90 DAY`
    const daily = (table: string, where: string, uniq = '(block_height, event_index)') =>
      `SELECT toString(toDate(block_timestamp)) AS d, toUInt64(uniqExact(${uniq})) AS v FROM price_data.${table} WHERE ${since}${where ? ` AND ${where}` : ''} GROUP BY d ORDER BY d`
    // Token filter — mirror the activity table's per-category asset-id predicates so
    // the bars adjust to the selected token on every tab. The asset id lives in a
    // different arg field per category (currencyId for transfers, assetIn/assetOut
    // for swaps, assetId/poolId/assetA for liquidity). Voting is BSX-denominated, so
    // a non-BSX token yields no rows. The xcm daily source has no asset id to filter
    // on (raw_xcm_activity.assets_json is empty) — it stays unfiltered by token
    // (documented limitation).
    const tokenIds = assetIdsForToken(filters.token)
    const ids = tokenIds?.join(',')
    const sp = (s: string) => (s ? ` ${s}` : '')
    const transferTok = assetIdFilterSql(transferAssetIdSql(), tokenIds)
    const tradeTok = tokenIds == null ? '' : !tokenIds.length ? 'AND 0'
      : `AND (toUInt32(JSONExtractInt(args_json,'assetIn')) IN (${ids}) OR toUInt32(JSONExtractInt(args_json,'assetOut')) IN (${ids}))`
    const voteTok = tokenIds == null ? '' : tokenIds.includes(0) ? '' : 'AND 0'
    let query: string
    if (scope === 'activity' && type !== 'xcm') {
      let names: readonly string[]
      const ignoreToken = false
      if (type === 'transfer') names = TRANSFER_EVENTS
      else if (type === 'trade') names = SWAP_EVENTS
      else if (type === 'liquidity') names = liquidityActionEventNames(filters.action)
      else if (type === 'vote') names = VOTE_EVENTS
      else names = [...TRANSFER_EVENTS, ...SWAP_EVENTS, ...LIQUIDITY_EVENTS, ...VOTE_EVENTS]
      const assetFilter = ignoreToken || tokenIds == null ? '' : !tokenIds.length
        ? 'AND 0'
        : `AND hasAny(asset_refs, [${tokenIds.join(',')}])`
      // An action no event in this category produces selects nothing — the same answer
      // the list gives it — rather than an empty `IN ()`.
      const nameFilter = names.length ? `event_name IN (${sqlNames(names)})` : '0'
      query = `SELECT toString(day) AS d, toUInt64(uniqExact(tuple(block_height, event_name IN (${HISTOGRAM_SWAP_EVENTS_SQL}), activity_index))) AS v
               FROM price_data.activity_histogram_events
               WHERE day > today() - 90 AND ${nameFilter} ${assetFilter}
               GROUP BY day ORDER BY day`
    } else if (scope === 'events' || scope === 'extrinsics')
      query = `SELECT toString(day) AS d, toUInt64(groupBitmapMerge(identity_state)) AS v
               FROM price_data.daily_chain_identity_counts_v2
               WHERE kind='${scope}' AND day > today() - 90
               GROUP BY day ORDER BY day`
    else {
      // activity — per selected type; 'all' approximates the merged feed.
      if (type === 'transfer')
        query = daily('raw_events', `event_name IN (${sqlNames(TRANSFER_EVENTS)})${sp(transferTok)}`)
      else if (type === 'trade') {
        query = daily('raw_events', `event_name IN (${sqlNames(SWAP_EVENTS)})${sp(tradeTok)}`, '(block_height, extrinsic_index)')
      } else if (type === 'vote') {
        const side = filters.action === 'Aye' ? ` AND JSONExtractInt(args_json, 'vote', 'vote') >= 128`
          : filters.action === 'Nay' ? ` AND JSONExtractInt(args_json, 'vote', 'vote') < 128 AND JSONExtractString(args_json, 'vote', '__kind') = 'Standard'` : ''
        query = daily('raw_events', `event_name IN (${sqlNames(VOTE_EVENTS)})${side}${sp(voteTok)}`)
      } else if (type === 'xcm') {
        // raw_xcm_activity counts queue messages; assets_json is empty → token
        // filter N/A here.
        query = daily('raw_xcm_activity', '', '(block_height, source_index)')
      } else {
        // 'all' — union of raw_events categories; OR each category's own token
        // predicate so the count mirrors the merged activity for the selected token.
        const allEvents = sqlNames([...TRANSFER_EVENTS, ...SWAP_EVENTS, ...LIQUIDITY_EVENTS, ...VOTE_EVENTS])
        let where = `event_name IN (${allEvents})`
        if (tokenIds != null) {
          if (!tokenIds.length) where += ' AND 0'
          else {
            const parts = [
              `(event_name IN (${sqlNames(TRANSFER_EVENTS)}) AND toUInt32(${transferAssetIdSql()}) IN (${ids}))`,
              `(event_name IN (${sqlNames(SWAP_EVENTS)}) AND (toUInt32(JSONExtractInt(args_json,'assetIn')) IN (${ids}) OR toUInt32(JSONExtractInt(args_json,'assetOut')) IN (${ids})))`,
              `(event_name IN (${sqlNames(LIQUIDITY_EVENTS)}) AND ${liquidityAssetMatchExpr(tokenIds.join(','))})`,
            ]
            if (tokenIds.includes(0)) parts.push(`(event_name IN (${sqlNames(VOTE_EVENTS)}))`)
            where += ` AND (${parts.join(' OR ')})`
          }
        }
        query = daily('raw_events', where)
      }
    }
    const res = await client.query({ query, format: 'JSONEachRow' })
    const byDay = new Map((await res.json<{ d: string; v: string }>()).map(r => [r.d, Number(r.v)]))
    // Emit a continuous 90-day axis — sparse categories (e.g. liquidations)
    // would otherwise compress the timeline to only their active days.
    const day = 86_400_000
    const today = Math.floor(Date.now() / day) * day
    return Array.from({ length: 90 }, (_, i) => {
      const date = new Date(today - (89 - i) * day).toISOString().slice(0, 10)
      return { date, value: byDay.get(date) ?? 0 }
    })
  })
}

// Total row counts per list (for pagination page-counts / Last button).
export async function getListCounts(): Promise<{ blocks: number; extrinsics: number; events: number; transfers: number }> {
  return cached('explorer:counts', 60000, async () => {
    const q = async (sql: string) => Number((await (await client.query({ query: sql, format: 'JSONEachRow' })).json<{ c: string }>())[0]?.c ?? 0)
    const [blocks, extrinsics, events, transfers] = await Promise.all([
      q(`SELECT toString(uniqExact(block_height)) AS c FROM price_data.raw_blocks`),
      q(`SELECT toString(uniqExact((block_height, extrinsic_index))) AS c FROM price_data.raw_extrinsics WHERE coalesce(signer, effective_signer) IS NOT NULL`),
      // The two event totals stay plain counts: deduplicating 300M rows costs ~12s
      // per cold call, against an overcount of a couple of hundred replayed rows
      // (0.0001%) on a value that only sizes the pager.
      q(`SELECT toString(count()) AS c FROM price_data.raw_events`),
      q(`SELECT toString(count()) AS c FROM price_data.raw_events WHERE event_name IN ('Balances.Transfer','Tokens.Transfer','Currencies.Transferred')`),
    ])
    return { blocks, extrinsics, events, transfers }
  })
}

// Daily active vs new accounts (last 30 days) for the Accounts chart.
export async function getDailyAccounts(): Promise<{ date: string; active: number; new: number }[]> {
  return cached('explorer:daily-accounts', 300000, async () => {
    const since = `block_timestamp > now() - INTERVAL 30 DAY`
    const [activeRes, newRes] = await Promise.all([
      client.query({ query: `SELECT toString(toDate(block_timestamp)) AS d, toUInt64(uniqExact(coalesce(signer, effective_signer))) AS v FROM price_data.raw_extrinsics WHERE ${since} AND coalesce(signer, effective_signer) IS NOT NULL GROUP BY d ORDER BY d`, format: 'JSONEachRow' }),
      client.query({ query: `SELECT toString(toDate(first)) AS d, toUInt64(count()) AS v FROM (SELECT coalesce(signer, effective_signer) AS account_id, min(block_timestamp) AS first FROM price_data.raw_extrinsics WHERE coalesce(signer, effective_signer) IS NOT NULL GROUP BY account_id) WHERE ${'first'} > now() - INTERVAL 30 DAY GROUP BY d ORDER BY d`, format: 'JSONEachRow' }),
    ])
    const active = new Map((await activeRes.json<{ d: string; v: string }>()).map(r => [r.d, Number(r.v)]))
    const neu = new Map((await newRes.json<{ d: string; v: string }>()).map(r => [r.d, Number(r.v)]))
    const dates = [...new Set([...active.keys(), ...neu.keys()])].sort()
    return dates.map(d => ({ date: d, active: active.get(d) ?? 0, new: neu.get(d) ?? 0 }))
  })
}

// search
export interface SearchResult {
  type: 'block' | 'extrinsic' | 'address' | 'asset' | 'tag' | 'referendum' | 'pool'
  value: string
  label?: string
  desc?: string   // asset-type: the descriptive name (e.g. DOT → "Polkadot")
  asset?: AssetRef
  // Address-type enrichment so the search dropdown can render the account pill
  // (emoji + identity name) directly, without a follow-up address fetch.
  emoji?: string
  emojiName?: string
  emojiUrl?: string
  identity?: AccountIdentity | null
  // Tag-type enrichment so the dropdown can render the tag's icon/color glyph
  // (e.g. the Kraken logo) in front of the entry.
  icon?: string
  color?: string
  // Referendum-type enrichment. `pallet`+`index` is the referendum's real identity —
  // Democracy and OpenGov both index from 0, so the index alone cannot address it or
  // build its route (`/referendum/:pallet/:index`). `status` is the lifecycle word
  // (e.g. "deciding", "approved") so the dropdown needs no follow-up fetch.
  pallet?: ReferendumPallet
  // Pool-type enrichment: the venue and current TVL, so the dropdown can rank and
  // caption the hit without a follow-up fetch. `value` is the pool id, `asset` the
  // icon to draw — the largest leg of the pair.
  poolKind?: 'xyk'
  tvlUsd?: number | null
  index?: number
  status?: string
}

// Two in-memory account indexes, both built from the ~100k accounts the explorer
// knows (balance holders ∪ extrinsic signers), refreshed periodically:
//   • suffix → accountIds — each account's DISPLAYED-address last-3 chars (the
//     colored "code" on the pill), so the search box resolves e.g. "x7K" → 15393Vq…Ax7K.
//   • emoji glyph → accountIds — the avatar each account renders, so a search for
//     the spelled-out name ("Mushroom" → 🍄) finds those accounts.
// Both source rows are ordered by activity so the per-bucket caps keep the most
// prominent accounts (emoji names are shared by hundreds; the dropdown shows a few).
let acctSuffixIndex = new Map<string, string[]>()
let acctEmojiIndex = new Map<string, string[]>()
let accountSuffixRefreshTimer: ReturnType<typeof setInterval> | null = null
let accountSuffixInflight: Promise<void> | null = null
let accountsPrewarmTimer: ReturnType<typeof setInterval> | null = null
let accountsPrewarmInflight: Promise<void> | null = null
let activityLeaderboardTimer: ReturnType<typeof setInterval> | null = null
let tagCountsPrewarmTimer: ReturnType<typeof setInterval> | null = null
let tagCountsPrewarmInflight: Promise<void> | null = null
let tagDetailsPrewarmTimer: ReturnType<typeof setInterval> | null = null
let tagDetailsPrewarmInflight: Promise<void> | null = null

async function loadAccountSuffixIndexUncached(): Promise<void> {
  try {
    const res = await client.query({
      query: `SELECT account_id FROM (
                SELECT account_id, sum(activity) AS activity FROM (
                  SELECT account_id, count() AS activity
                  FROM price_data.account_asset_latest_balances
                  GROUP BY account_id
                  UNION ALL
                  SELECT coalesce(signer, effective_signer) AS account_id, count() AS activity
                  FROM price_data.raw_extrinsics
                  WHERE coalesce(signer, effective_signer) != ''
                  GROUP BY account_id
                ) WHERE account_id != '' GROUP BY account_id ORDER BY activity DESC
              )
              LIMIT 250000`,
      format: 'JSONEachRow',
      clickhouse_settings: { max_result_rows: '250000' },
    })
    const suf = new Map<string, string[]>()
    const emo = new Map<string, string[]>()
    for (const r of await res.json<{ account_id: string }>()) {
      const id = r.account_id
      if (!/^0x[0-9a-fA-F]{64}$/.test(id)) continue
      const disp = basiliskAddress(id) // Basilisk SS58, matching the pill
      if (!disp || disp.length < 3) continue
      const s = disp.slice(-3).toLowerCase()
      const sArr = suf.get(s)
      if (sArr) { if (sArr.length < 25) sArr.push(id) } else suf.set(s, [id])
      // Index by the rendered glyph, but skip accounts showing a custom image
      // (Discord avatar): their fallback emoji isn't what's displayed, so a name
      // match on it would be misleading.
      const ic = accountIcon(id)
      if (!ic.emojiUrl) {
        const eArr = emo.get(ic.emoji)
        if (eArr) { if (eArr.length < 25) eArr.push(id) } else emo.set(ic.emoji, [id])
      }
    }
    acctSuffixIndex = suf
    acctEmojiIndex = emo
  } catch (e) { console.error('[suffix-index] load failed', e) }
}

export function loadAccountSuffixIndex(): Promise<void> {
  if (accountSuffixInflight) return accountSuffixInflight
  const request = loadAccountSuffixIndexUncached().finally(() => {
    if (accountSuffixInflight === request) accountSuffixInflight = null
  })
  accountSuffixInflight = request
  return request
}

export function startAccountSuffixRefresh(): void {
  if (accountSuffixRefreshTimer) return
  accountSuffixRefreshTimer = setInterval(() => { void loadAccountSuffixIndex().catch(() => {}) }, 5 * 60_000)
  accountSuffixRefreshTimer.unref()
}
async function prewarmAccountDirectoryUncached(): Promise<void> {
  // Every page here reads whatever activity ranking is currently published, so this pass
  // does not build one — that runs on its own, much slower interval. It does publish
  // WHICH rows it rendered: those are the demand half of the ranking's pool, so the
  // Activity column fills in for the pages a reader actually opens rather than only for
  // the chain's busiest accounts (see demandPoolMembers).
  const sorts: AccountSort[] = ['value', 'identity', 'activity', 'volume']
  const rendered: string[] = []
  for (const sort of sorts) rendered.push(...directoryRowGkeys((await refreshAccountsPage(0, 50, sort))?.rows ?? []))
  rendered.push(...directoryRowGkeys((await refreshAccountsPage(50, 50, 'value'))?.rows ?? []))
  // Replaced whole, never appended to: a pass that failed partway must not narrow the
  // pool to what it managed, and a row that left the directory must leave the pool.
  if (rendered.length) directoryPoolGkeys = rendered
  // Then the detail pages' own shared read, on the same five-minute cycle: it is a third
  // of the snapshot's stale bound, so a skipped cycle costs a reader nothing and no
  // additional timer is needed. Last, and sequential, so the directory pages are never
  // held behind it.
  await prewarmHotActivitySnapshots()
}

let activityLeaderboardInflight: Promise<void> | null = null
function refreshActivityLeaderboard(): Promise<void> {
  if (activityLeaderboardInflight) return activityLeaderboardInflight
  const request = refreshActivityLeaderboardUncached().finally(() => {
    if (activityLeaderboardInflight === request) activityLeaderboardInflight = null
  })
  activityLeaderboardInflight = request
  return request
}

// The activity ranking's own pass. Separate from the directory prewarm because the two
// want completely different cadences: pages are cheap and want to be minutes fresh, while
// an exact per-account total costs seconds of ClickHouse and changes slowly.
export function startActivityLeaderboardRefresh(): void {
  if (activityLeaderboardTimer) return
  const cycle = async (): Promise<void> => {
    await refreshActivityLeaderboard().catch(error => console.warn('[explorer] activity leaderboard refresh failed', error))
  }
  void cycle()
  activityLeaderboardTimer = setInterval(() => { void cycle() }, ACTIVITY_LEADERBOARD_REFRESH_MS)
  activityLeaderboardTimer.unref()
}

function prewarmAccountDirectory(): Promise<void> {
  if (accountsPrewarmInflight) return accountsPrewarmInflight
  const request = prewarmAccountDirectoryUncached().finally(() => {
    if (accountsPrewarmInflight === request) accountsPrewarmInflight = null
  })
  accountsPrewarmInflight = request
  return request
}

// Persist every public sort plus page two in a bounded sequential background
// pass. Process restarts and browser-cold loads then read one tiny snapshot;
// stale-while-revalidate keeps the previous page available during refresh.
export function startAccountsPrewarm(): void {
  if (accountsPrewarmTimer) return
  void prewarmAccountDirectory().catch(() => {})
  accountsPrewarmTimer = setInterval(() => { void prewarmAccountDirectory().catch(() => {}) }, 5 * 60_000)
  accountsPrewarmTimer.unref()
}

async function prewarmTagTabCountsUncached(): Promise<void> {
  // Sequential by tag: the exact aggregation can be large for structural tags,
  // and concurrent full-history unions would contend with live ingestion.
  for (const tag of allTags()) {
    const membershipKey = tagMembershipList(tag.members)
    const result = await client.query({
      query: `SELECT membership_key, dateDiff('second', computed_at, now()) AS age
              FROM price_data.tag_activity_counts FINAL
              WHERE tag_id = {tagId:String} LIMIT 1`,
      query_params: { tagId: tag.tagId }, format: 'JSONEachRow',
    })
    const snapshot = (await result.json<{ membership_key: string; age: number }>())[0]
    const membershipMatches = snapshot?.membership_key === membershipKey
    // Establish complete coverage for every reproducible tag once. Thereafter
    // only tags actually requested by this API process need ten-minute refresh;
    // rescanning every structural tag forever would create continuous load.
    if (membershipMatches && (!hotTagCounts.has(tag.tagId) || Number(snapshot.age) < TAG_COUNT_REFRESH_MS / 1000)) continue
    await refreshTagTabCounts(tag.tagId, tag.members, membershipKey)
  }
}

function prewarmTagTabCounts(): Promise<void> {
  if (tagCountsPrewarmInflight) return tagCountsPrewarmInflight
  const request = prewarmTagTabCountsUncached().finally(() => {
    if (tagCountsPrewarmInflight === request) tagCountsPrewarmInflight = null
  })
  tagCountsPrewarmInflight = request
  return request
}

export function startTagCountsPrewarm(): void {
  if (tagCountsPrewarmTimer) return
  void prewarmTagTabCounts().catch(error => console.error('[tag-counts] prewarm failed', error))
  tagCountsPrewarmTimer = setInterval(() => { void prewarmTagTabCounts().catch(error => console.error('[tag-counts] refresh failed', error)) }, TAG_COUNT_REFRESH_MS)
  tagCountsPrewarmTimer.unref()
  const prewarmDetails = (): Promise<void> => {
    if (tagDetailsPrewarmInflight) return tagDetailsPrewarmInflight
    const request = (async () => {
      for (const tagId of hotTagDetails) {
        const tag = getTagRecord(tagId)
        // Reconstructing a tag whose stored payload a request would still accept
        // buys nothing: the payload moves with live prices, so every rebuild
        // differs and no content check can skip it — only its age can. Skipping
        // leaves the same guarantee (no request meets a cold snapshot) and stops
        // the multi-second balance/lock/money-market/LP/DCA/portfolio/volume
        // reconstruction running on unchanged membership every two minutes.
        if (tag?.members.length && await tagDetailSnapshotServesUntilNextTick(tagId, tagDetailMembershipKey(tag.members))) continue
        // A distinct cache key keeps foreground requests on the last complete
        // snapshot instead of joining this exact, multi-second reconstruction.
        await getTag(tagId, { refresh: true })
      }
    })().finally(() => {
      if (tagDetailsPrewarmInflight === request) tagDetailsPrewarmInflight = null
    })
    tagDetailsPrewarmInflight = request
    return request
  }
  void prewarmDetails().catch(error => console.error('[tag-detail] prewarm failed', error))
  tagDetailsPrewarmTimer = setInterval(() => { void prewarmDetails().catch(error => console.error('[tag-detail] refresh failed', error)) }, TAG_DETAIL_PREWARM_INTERVAL_MS)
  tagDetailsPrewarmTimer.unref()
}

export function stopExplorerBackgroundTasks(): void {
  if (accountSuffixRefreshTimer) clearInterval(accountSuffixRefreshTimer)
  if (accountsPrewarmTimer) clearInterval(accountsPrewarmTimer)
  if (activityLeaderboardTimer) clearInterval(activityLeaderboardTimer)
  if (tagCountsPrewarmTimer) clearInterval(tagCountsPrewarmTimer)
  if (tagDetailsPrewarmTimer) clearInterval(tagDetailsPrewarmTimer)
  accountSuffixRefreshTimer = null
  accountsPrewarmTimer = null
  activityLeaderboardTimer = null
  tagCountsPrewarmTimer = null
  tagDetailsPrewarmTimer = null
}

function accountsBySuffix(suffix: string): string[] {
  return acctSuffixIndex.get(suffix.toLowerCase()) ?? []
}
function accountsByEmoji(emoji: string): string[] {
  return acctEmojiIndex.get(emoji) ?? []
}

// Cap on account (address-type) results across all fuzzy matchers (identity name,
// emoji name, 3-letter code). Matters most for emoji-name searches like "fish",
// where hundreds of accounts share a glyph — the per-glyph index already keeps the
// most-active accounts first, so this just controls how many of them the dropdown
// surfaces. Kept modest so the dropdown stays scannable.
const MAX_ACCOUNT_RESULTS = 15

// Cap on referendum results (index or title match) in one search response.
const MAX_REFERENDUM_RESULTS = 8
// Pool-name hits are ranked by TVL, so five covers every pool a reader can
// plausibly mean while a broad substring ('pool') stays scannable.
const MAX_POOL_RESULTS = 5
// Bounded snapshot of the whole referendum directory (Democracy 0-206, OpenGov
// 0-369 as of writing — governance moves far slower than blocks or accounts, so
// this ceiling comfortably covers the foreseeable count). getReferenda caches this
// exact (limit, offset) for 60s regardless of the query text, so a burst of
// searches shares one ClickHouse read instead of one per keystroke.
const REFERENDA_SEARCH_DIRECTORY_LIMIT = 1000

function referendumSearchResult(r: ReferendumListRow): SearchResult {
  return { type: 'referendum', value: referendumTitleKey(r.pallet, r.index), label: r.title ?? undefined, pallet: r.pallet, index: r.index, status: r.status }
}

// Case-insensitive rank for a name/title substring match: exact, then prefix,
// then a word start ("spend" in "Treasury spend for X"), then any other
// substring — so a query naming the start of a name outranks one that only
// lands mid-word. Shared by the referendum-title matcher and the tag-name
// matcher below: without it, tag results came back in directory/insertion
// order, so an exact "Treasury" tag sat under any longer tag name containing the
// word merely because it was inserted first.
// The pool directory as a search source. Fail-soft: pool hits are additive, so
// a pools-index failure (or, in unit tests, an unwired poolService client) must
// cost the pool entries alone, never the whole search response.
async function poolDirectoryForSearch(): Promise<import('./poolService.ts').PoolListEntry[]> {
  try {
    const { getPoolsIndex } = await import('./poolService.ts')
    return (await getPoolsIndex()).pools
  } catch {
    return []
  }
}

function poolSearchResult(p: import('./poolService.ts').PoolListEntry): SearchResult {
  return {
    type: 'pool',
    value: String(p.poolId),
    label: p.name,
    poolKind: p.kind,
    tvlUsd: p.tvlUsd,
    // A pair shows its largest leg.
    asset: p.composition[0]?.asset,
  }
}

function nameMatchRank(name: string, ql: string): number {
  const t = name.toLowerCase()
  if (t === ql) return 0
  if (t.startsWith(ql)) return 1
  const idx = t.indexOf(ql)
  if (idx < 0) return -1
  return /[a-z0-9]/i.test(name[idx - 1]) ? 3 : 2
}

export async function search(q: string): Promise<SearchResult[]> {
  const query = q.trim()
  if (!query) return []
  // Single-flight cache: many users typing the same prefixes (and each user's
  // keystroke debounce) would otherwise hit ClickHouse per request.
  return cached(`explorer:search:${query.toLowerCase()}`, 10000, () => searchUncached(query))
}

async function searchUncached(query: string): Promise<SearchResult[]> {
  const results: SearchResult[] = []

  if (/^\d+$/.test(query)) {
    const h = Number(query)
    const res = await client.query({ query: `SELECT count() AS c FROM price_data.raw_blocks WHERE block_height = {h:UInt32}`, query_params: { h }, format: 'JSONEachRow' })
    if (Number((await res.json<{ c: string }>())[0]?.c ?? 0) > 0) results.push({ type: 'block', value: query })

    // Referendum index — exact match on either pallet first (both index from 0, so
    // one number can legitimately name two different referenda), then index-prefix
    // matches, off the same bounded directory snapshot below.
    const { getReferenda } = await import('./governanceService.ts')
    const directory = await getReferenda(REFERENDA_SEARCH_DIRECTORY_LIMIT, 0)
    const refHits = [
      ...directory.filter(r => String(r.index) === query),
      ...directory.filter(r => String(r.index) !== query && String(r.index).startsWith(query)),
    ].slice(0, MAX_REFERENDUM_RESULTS)
    for (const r of refHits) results.push(referendumSearchResult(r))

    // Pool id — the share/LP asset id the pool pages route by (e.g. 690).
    const poolHit = (await poolDirectoryForSearch()).find(p => p.poolId === h)
    if (poolHit) results.push(poolSearchResult(poolHit))
  }

  // extrinsic id "height-index"
  const extId = /^(\d+)-(\d+)$/.exec(query)
  if (extId) {
    const res = await client.query({
      query: `SELECT count() AS c FROM price_data.raw_extrinsics WHERE block_height = {h:UInt32} AND extrinsic_index = {i:UInt32}`,
      query_params: { h: Number(extId[1]), i: Number(extId[2]) },
      format: 'JSONEachRow',
    })
    if (Number((await res.json<{ c: string }>())[0]?.c ?? 0) > 0) results.push({ type: 'extrinsic', value: query })
  }

  const is64Hex = /^0x[0-9a-fA-F]{64}$/.test(query)
  let hashHit = false
  if (is64Hex) {
    const lc = query.toLowerCase()
    const [blockRes, extRes] = await Promise.all([
      client.query({ query: `SELECT block_height FROM price_data.raw_blocks WHERE block_hash = {h:String} LIMIT 1`, query_params: { h: lc }, format: 'JSONEachRow' }),
      client.query({ query: `SELECT extrinsic_hash FROM price_data.raw_extrinsics WHERE extrinsic_hash = {h:String} LIMIT 1`, query_params: { h: lc }, format: 'JSONEachRow' }),
    ])
    const blockHit = (await blockRes.json<{ block_height: number }>())[0]
    if (blockHit) { results.push({ type: 'block', value: String(blockHit.block_height) }); hashHit = true }
    const extHit = (await extRes.json<{ extrinsic_hash: string }>())[0]
    if (extHit) { results.push({ type: 'extrinsic', value: lc }); hashHit = true }
  }

  // A 64-hex value is ambiguous (could be an AccountId32 or a block/extrinsic hash);
  // only offer it as an account when it didn't resolve to a known hash.
  const seenAccounts = new Set<string>()
  const norm = normalizeAddress(query)
  if (norm?.accountId && (!is64Hex || !hashHit)) {
    const id = identityForAccount(norm.accountId)
    const ic = accountIcon(norm.accountId)
    results.push({
      type: 'address', value: norm.accountId, label: norm.ss58 ?? basiliskAddress(norm.accountId) ?? undefined,
      emoji: ic.emoji, emojiName: ic.emojiName, emojiUrl: ic.emojiUrl, identity: id,
    })
    seenAccounts.add(norm.accountId.toLowerCase())
  }

  // Tag name — ranked exact/prefix/word-start/substring match (same tiering
  // as the referendum-title matcher below), e.g. "kraken". Placed ahead of
  // every fuzzy account/identity matcher below: a name query naming a system
  // tag or a tag in the viewer's own lists should surface that tag before the
  // identities it happens to also match, not after — an exact address/hash/
  // block lookup above still wins outright, since this only fires on a query
  // containing letters. Without the ranking, an exact "Treasury" tag sorted
  // below any longer tag name containing the word, on directory order alone.
  if (/[A-Za-z]/.test(query)) {
    const { allTags } = await import('./tagService.ts')
    const ql = query.toLowerCase()
    const rankedTags = allTags()
      .map(t => ({ t, rank: nameMatchRank(t.name, ql) }))
      .filter(x => x.rank >= 0)
      .sort((a, b) => a.rank - b.rank || a.t.name.localeCompare(b.t.name))
    for (const { t } of rankedTags) results.push({ type: 'tag', value: t.tagId, label: t.name, icon: t.icon, color: t.color })

  }

  // Combined "3-letter code + emoji name" query (either order: "pmo pig",
  // "pig pmo") — intersect the suffix bucket with the account's rendered glyph.
  // High-precision (usually pinpoints one account), so it ranks first among the
  // fuzzy account matchers. Custom-avatar accounts are skipped like in the
  // emoji-name branch: their fallback emoji isn't what the pill displays.
  for (const combo of parseSuffixEmojiQuery(query)) {
    for (const id of accountsBySuffix(combo.suffix)) {
      if (seenAccounts.has(id.toLowerCase())) continue
      const ic = accountIcon(id)
      if (ic.emojiUrl || !(combo.glyphs.includes(ic.emoji) || combo.glyphs.includes(ic.emoji.replace(/️/g, '')))) continue
      if (results.filter(r => r.type === 'address').length >= MAX_ACCOUNT_RESULTS) break
      seenAccounts.add(id.toLowerCase())
      results.push({
        type: 'address', value: id, label: basiliskAddress(id) ?? undefined,
        emoji: ic.emoji, emojiName: ic.emojiName ?? emojiNameFor(ic.emoji) ?? undefined, identity: identityForAccount(id),
      })
    }
  }

  // Asset symbol/name match — always run and surfaced high, so an account whose
  // identity contains the query (e.g. "BSXKobi") never hides the asset itself
  // (e.g. BSX). Ranked: exact symbol, then symbol prefix, then symbol substring,
  // then name substring; shortest symbol wins ties.
  if (/[A-Za-z]/.test(query)) {
    const ql = query.toLowerCase()
    const ranked = allExplorerAssets()
      .map(a => {
        const sym = a.symbol.toLowerCase(), name = (a.name ?? '').toLowerCase()
        const rank = sym === ql ? 0 : sym.startsWith(ql) ? 1 : sym.includes(ql) ? 2 : name.includes(ql) ? 3 : -1
        return { a, rank }
      })
      .filter(x => x.rank >= 0)
      .sort((x, y) => x.rank - y.rank || x.a.symbol.length - y.a.symbol.length)
      .slice(0, 6)
    for (const { a } of ranked) results.push({ type: 'asset', value: String(a.assetId), label: a.symbol, desc: a.name ?? undefined, asset: a })
  }

  // Pool name — the /liquidity directory ('BSX / KSM', 'vDOT / DOT', …).
  // Matching hits are ordered by TVL, not match tier: a reader typing a fragment
  // shared by several pools ('pool', 'DOT') means the big one far more often than
  // the best string match.
  if (/[A-Za-z]/.test(query)) {
    const ql = query.toLowerCase()
    const poolHits = (await poolDirectoryForSearch())
      .filter(p => nameMatchRank(p.name, ql) >= 0)
      .sort((a, b) => (b.tvlUsd ?? -1) - (a.tvlUsd ?? -1))
      .slice(0, MAX_POOL_RESULTS)
    for (const p of poolHits) results.push(poolSearchResult(p))
  }

  // Identity name — case-insensitive substring on Identity.IdentityOf display
  // (e.g. "kraken", "stakernode"). Returns the matching accounts as address
  // results, deduped against a direct address match above.
  if (/[A-Za-z]/.test(query)) {
    for (const m of searchIdentitiesByDisplay(query, 5)) {
      if (seenAccounts.has(m.accountId.toLowerCase())) continue
      seenAccounts.add(m.accountId.toLowerCase())
      const mic = accountIcon(m.accountId)
      results.push({
        type: 'address', value: m.accountId, label: basiliskAddress(m.accountId) ?? undefined,
        emoji: mic.emoji, emojiName: mic.emojiName, emojiUrl: mic.emojiUrl, identity: m.identity,
      })
    }
  }

  // Emoji name — the spelled-out avatar each account shows (e.g. "Mushroom" → 🍄,
  // "Fox" → 🦊, "Shark" → 🦈). Resolve the name to its glyph(s), then surface the
  // most-active accounts that render with that emoji (from the emoji index).
  if (/[A-Za-z]/.test(query)) {
    for (const glyph of emojisMatchingName(query)) {
      if (results.filter(r => r.type === 'address').length >= MAX_ACCOUNT_RESULTS) break
      for (const id of accountsByEmoji(glyph)) {
        if (seenAccounts.has(id.toLowerCase())) continue
        if (results.filter(r => r.type === 'address').length >= MAX_ACCOUNT_RESULTS) break
        seenAccounts.add(id.toLowerCase())
        const ic = accountIcon(id)
        results.push({
          type: 'address', value: id, label: basiliskAddress(id) ?? undefined,
          emoji: ic.emoji, emojiName: ic.emojiName ?? emojiNameFor(ic.emoji) ?? undefined, identity: identityForAccount(id),
        })
      }
    }
  }

  // Account "3-letter code" — the colored last-3 chars shown on each account pill
  // (e.g. "x7K" → 15393Vq…Ax7K). Match short base58/hex-ish tokens against the
  // display-suffix index; exact-case matches first.
  if (/^[0-9A-Za-z]{2,6}$/.test(query)) {
    const matches = accountsBySuffix(query).slice()
    matches.sort((a, b) => {
      const da = basiliskAddress(a), db = basiliskAddress(b)
      const ea = da?.endsWith(query) ? 0 : 1, eb = db?.endsWith(query) ? 0 : 1
      return ea - eb
    })
    for (const id of matches) {
      if (seenAccounts.has(id.toLowerCase())) continue
      if (results.filter(r => r.type === 'address').length >= MAX_ACCOUNT_RESULTS) break
      seenAccounts.add(id.toLowerCase())
      const ic = accountIcon(id)
      results.push({
        type: 'address', value: id, label: basiliskAddress(id) ?? undefined,
        emoji: ic.emoji, emojiName: ic.emojiName, emojiUrl: ic.emojiUrl, identity: identityForAccount(id),
      })
    }
  }

  // Referendum title — case-insensitive substring (e.g. "treasury spend"), ranked
  // prefix/word-start first and capped, off the same bounded directory snapshot
  // the digit branch above uses.
  if (/[A-Za-z]/.test(query)) {
    const { getReferenda } = await import('./governanceService.ts')
    const ql = query.toLowerCase()
    const directory = await getReferenda(REFERENDA_SEARCH_DIRECTORY_LIMIT, 0)
    const ranked = directory
      .map(r => (r.title ? { r, rank: nameMatchRank(r.title, ql) } : null))
      .filter((x): x is { r: ReferendumListRow; rank: number } => x != null && x.rank >= 0)
      .sort((a, b) => a.rank - b.rank)
      .slice(0, MAX_REFERENDUM_RESULTS)
    for (const { r } of ranked) results.push(referendumSearchResult(r))
  }

  return results
}

function safeJson(s: string | null | undefined): unknown {
  if (!s) return null
  try { return JSON.parse(s) } catch { return s }
}
