import type { ClickHouseClient } from '../db/client.ts'
import { cachedSwr } from './cache.ts'
import {
  accountRef, ensurePrices, hasExplorerClient, initExplorerService,
  type AccountRef, type AssetRef, type PriceInfo,
} from './explorerService.ts'
import { assetDescriptor } from './explorerAssets.ts'

// Liquidity-pool read models: the asset Liquidity tab and the XYK pool detail
// pages. Current state comes from the latest raw_block_snapshots row (one cached
// read shared by both surfaces, so an asset card and the pool page it links to
// can never disagree); history comes from the MV-backed xyk_pool_reserve_history
// table on the shared 600-block grid, bucketed daily. Bucketed USD uses only day
// candles fully closed by the bucket boundary, so history series end at
// yesterday — current values live in the current-state sections. Pool TVL is
// null unless every leg is priced.

let client: ClickHouseClient
/**
 * Wires this service's ClickHouse handle.
 *
 * TRANSITIVE COUPLING, stated on purpose: every value this service produces is
 * priced through `explorerService.ensurePrices`, so a process that initializes only
 * this service gets an EMPTY price map — `refreshPrices` swallows the failure — and
 * silently reports every pool as unpriced instead of failing. That is what the
 * public API's platform TVL first did. So a handle is supplied for a process that
 * has none, and only then: repointing an explorerService that is already wired
 * would let a caller with a scratch or long-op client take over the live price
 * loader's connection, which nothing would surface.
 */
export function initPoolService(c: ClickHouseClient): void {
  client = c
  if (!hasExplorerClient()) initExplorerService(c)
}

// XYK trade fee is a runtime constant: Permill 0.3% (3/1000).
const XYK_FEE_PERMILL = 3000

const asset = (id: number): AssetRef => assetDescriptor(id)

function priceOf(prices: Map<number, PriceInfo>, assetId: number): number | null {
  return prices.get(assetId)?.price ?? null
}

function usdOf(prices: Map<number, PriceInfo>, assetId: number, raw: bigint): number | null {
  const px = priceOf(prices, assetId)
  if (px == null) return null
  const amt = Number(raw) / 10 ** asset(assetId).decimals
  return Number.isFinite(amt) ? amt * px : null
}

// response shapes

export interface PoolCompositionEntry { asset: AssetRef; amount: string; usd: number | null; sharePct: number | null }
export interface AssetLiquiditySource {
  kind: 'xyk'
  poolId: number | null
  name: string
  tvlUsd: number | null
  assetAmount: string
  assetUsd: number | null
  assetSharePct: number | null
  // Per-asset reserves of the pool.
  composition: PoolCompositionEntry[]
}
export interface FormerLiquiditySource {
  kind: 'xyk'
  poolId: number | null
  name: string
  lastActiveBlock: number | null
  lastActiveAt: string | null
}
export interface AssetLiquiditySeries { key: string; label: string; amounts: (number | null)[]; usd: (number | null)[] }
export interface AssetLiquidityResponse {
  asset: AssetRef
  totalAmount: string
  totalUsd: number | null
  sources: AssetLiquiditySource[]
  former: FormerLiquiditySource[]
  history: { buckets: string[]; series: AssetLiquiditySeries[] }
}

export interface PoolDetailAsset {
  asset: AssetRef
  amount: string
  usd: number | null
  sharePct: number | null
}
export interface PoolDetailResponse {
  kind: 'xyk'
  poolId: number
  name: string
  account: AccountRef
  shareToken: AssetRef
  createdBlock: number | null
  createdAt: string | null
  destroyed: boolean
  tvlUsd: number | null
  totalIssuance: string
  feePermill: number | null
  assets: PoolDetailAsset[]
  history: {
    buckets: string[]
    tvlUsd: (number | null)[]
    composition: { asset: AssetRef; amounts: (number | null)[]; usd: (number | null)[] }[]
  }
}

// current state (latest snapshot, shared by both pool surfaces)

export interface XykPoolSnapshot {
  lpAssetId: number | null
  poolAccount: string
  assetA: number
  assetB: number
  reserveA: bigint
  reserveB: bigint
  createdBlock: number | null
}
export interface CurrentPools {
  blockHeight: number
  xykByLp: Map<number, XykPoolSnapshot>
  xykByAccount: Map<string, XykPoolSnapshot>
}

interface SnapshotXykPool { pool_account: string; asset_a: number; asset_b: number; reserve_a: string; reserve_b: string }

function safeJson(s: string | null | undefined): unknown {
  if (!s) return null
  try { return JSON.parse(s) } catch { return null }
}

export async function loadCurrentPools(): Promise<CurrentPools> {
  return cachedSwr('explorer:pools:current', 30_000, 300_000, async () => {
    const [snapRes, regRes] = await Promise.all([
      client.query({
        query: `SELECT block_height,
                       JSONExtractRaw(payload_json, 'xyk') AS x
                FROM price_data.raw_block_snapshots
                WHERE block_height = (SELECT max(block_height) FROM price_data.raw_block_snapshots)
                LIMIT 1`,
        format: 'JSONEachRow',
      }),
      client.query({
        query: `SELECT lp_asset_id, pool_account, asset_a, asset_b, created_block FROM price_data.xyk_pool_registry FINAL`,
        format: 'JSONEachRow',
      }),
    ])
    const snap = (await snapRes.json<{ block_height: number; x: string }>())[0]
    const registry = await regRes.json<{ lp_asset_id: number; pool_account: string; asset_a: number; asset_b: number; created_block: number }>()

    // A pool pair account can be reused across create → destroy → recreate
    // cycles; the live incarnation is the newest registry row for the account.
    const regByAccount = new Map<string, { lp: number; createdBlock: number }>()
    for (const r of registry) {
      const prev = regByAccount.get(r.pool_account)
      if (!prev || r.created_block > prev.createdBlock) regByAccount.set(r.pool_account, { lp: r.lp_asset_id, createdBlock: r.created_block })
    }
    const xykByLp = new Map<number, XykPoolSnapshot>()
    const xykByAccount = new Map<string, XykPoolSnapshot>()
    const xykPools = (safeJson(snap?.x) as { pools?: SnapshotXykPool[] } | null)?.pools ?? []
    for (const p of xykPools) {
      const reg = regByAccount.get(p.pool_account)
      const pool: XykPoolSnapshot = {
        lpAssetId: reg?.lp ?? null,
        poolAccount: p.pool_account,
        assetA: p.asset_a,
        assetB: p.asset_b,
        reserveA: BigInt(p.reserve_a),
        reserveB: BigInt(p.reserve_b),
        createdBlock: reg?.createdBlock ?? null,
      }
      xykByAccount.set(p.pool_account, pool)
      if (pool.lpAssetId != null) xykByLp.set(pool.lpAssetId, pool)
    }

    return { blockHeight: Number(snap?.block_height ?? 0), xykByLp, xykByAccount }
  })
}

// pure helpers (unit-tested)

// Composition entries valued at current prices. sharePct is a USD share and is
// only computable when every leg is priced — the same all-legs rule as tvlUsd,
// so a bar and its TVL cap can never disagree.
export function buildComposition(prices: Map<number, PriceInfo>, legs: { assetId: number; raw: bigint }[]): { entries: PoolCompositionEntry[]; tvlUsd: number | null } {
  const usd = legs.map(l => usdOf(prices, l.assetId, l.raw))
  const tvlUsd = usd.every(u => u != null) ? (usd as number[]).reduce((s, u) => s + u, 0) : null
  const entries = legs.map((l, i) => ({
    asset: asset(l.assetId),
    amount: l.raw.toString(),
    usd: usd[i],
    sharePct: tvlUsd != null && tvlUsd > 0 ? (usd[i]! / tvlUsd) * 100 : null,
  }))
  return { entries, tvlUsd }
}

// Continuous daily axis (inclusive), 'YYYY-MM-DD'.
export function dailyGrid(firstDay: string, lastDay: string): string[] {
  const out: string[] = []
  const start = Date.parse(`${firstDay}T00:00:00Z`)
  const end = Date.parse(`${lastDay}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return out
  for (let t = start; t <= end; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10))
  return out
}

// Align sparse day→value points onto the grid, carrying the last value forward
// only between the series' first sample and `lastDay` (default: its last
// sample). Outside that range the series is null — a delisted asset or
// destroyed pool ends at its last real sample instead of forward-filling to
// now, and never gets a fabricated zero.
export function carrySeries(grid: string[], points: Map<string, number>, lastDay?: string): (number | null)[] {
  let first: string | null = null
  let lastPoint: string | null = null
  for (const d of points.keys()) {
    if (first == null || d < first) first = d
    if (lastPoint == null || d > lastPoint) lastPoint = d
  }
  const end = lastDay ?? lastPoint
  const out: (number | null)[] = []
  let current: number | null = null
  for (const d of grid) {
    if (first == null || d < first || (end != null && d > end)) { out.push(null); continue }
    const v = points.get(d)
    if (v != null) current = v
    out.push(current)
  }
  return out
}

// Keep the N series with the largest peak value and fold the rest into one
// 'other' series (per-bucket sum of the folded series, null when none of them
// has a value). Ties break by key so the fold is deterministic.
export function foldTopSeries(series: AssetLiquiditySeries[], topN: number): AssetLiquiditySeries[] {
  if (series.length <= topN) return series
  const peak = (s: AssetLiquiditySeries) => s.amounts.reduce<number>((m, v) => (v != null && v > m ? v : m), 0)
  const ranked = [...series].sort((a, b) => peak(b) - peak(a) || (a.key < b.key ? -1 : 1))
  const top = ranked.slice(0, topN)
  const rest = ranked.slice(topN)
  const n = rest[0]?.amounts.length ?? 0
  const amounts: (number | null)[] = []
  const usd: (number | null)[] = []
  for (let i = 0; i < n; i++) {
    let a: number | null = null
    let u: number | null = null
    for (const s of rest) {
      if (s.amounts[i] != null) a = (a ?? 0) + s.amounts[i]!
      if (s.usd[i] != null) u = (u ?? 0) + s.usd[i]!
    }
    amounts.push(a)
    usd.push(u)
  }
  // Preserve the original (value-ordered) top series order, then Other.
  const keep = new Set(top.map(s => s.key))
  return [...series.filter(s => keep.has(s.key)), { key: 'other', label: 'Other', amounts, usd }]
}

// The last day whose 1d candle is fully closed (yesterday, UTC).
function lastClosedDay(): string {
  return new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
}

// Daily closes for a set of assets (price-alias applied), day → close. The 1d
// candle for day D closes at D+1 00:00 UTC, so it is fully closed for every
// bucket the histories chart (they end at yesterday).
async function dailyCloses(assetIds: number[]): Promise<Map<number, Map<string, number>>> {
  const out = new Map<number, Map<string, number>>()
  if (!assetIds.length) return out
  const wanted = [...new Set(assetIds)]
  const res = await client.query({
    query: `SELECT asset_id, toString(toDate(interval_start)) AS d, toFloat64(argMaxMerge(close_state)) AS close
            FROM price_data.ohlc_1d
            WHERE asset_id IN {ids:Array(UInt32)}
            GROUP BY asset_id, interval_start`,
    query_params: { ids: wanted },
    format: 'JSONEachRow',
  })
  for (const r of await res.json<{ asset_id: number; d: string; close: number }>()) {
    if (!(r.close > 0)) continue
    let m = out.get(r.asset_id)
    if (!m) { m = new Map(); out.set(r.asset_id, m) }
    m.set(r.d, r.close)
  }
  return out
}

// asset liquidity (the Liquidity tab)

function currentSourcesForAsset(pools: CurrentPools, prices: Map<number, PriceInfo>, assetId: number): AssetLiquiditySource[] {
  const out: AssetLiquiditySource[] = []

  for (const pool of pools.xykByAccount.values()) {
    if (pool.assetA !== assetId && pool.assetB !== assetId) continue
    const { entries, tvlUsd } = buildComposition(prices, [
      { assetId: pool.assetA, raw: pool.reserveA },
      { assetId: pool.assetB, raw: pool.reserveB },
    ])
    const idx = pool.assetA === assetId ? 0 : 1
    out.push({
      kind: 'xyk', poolId: pool.lpAssetId, name: xykName(pool.assetA, pool.assetB),
      tvlUsd,
      assetAmount: (idx === 0 ? pool.reserveA : pool.reserveB).toString(),
      assetUsd: entries[idx].usd,
      assetSharePct: entries[idx].sharePct,
      composition: entries,
    })
  }

  out.sort((a, b) => (b.assetUsd ?? -1) - (a.assetUsd ?? -1))
  // Long tails exist (DOT sits in 100+ dust XYK pools): the card grid renders
  // the top sources with their composition bars, everything below folds into
  // compact rows that keep every value field — the full breakdown stays one
  // click away on the pool page, so nothing is silently dropped.
  for (const s of out.slice(COMPOSITION_CARD_LIMIT)) s.composition = []
  return out
}

// How many sources keep their inline composition (the tab's card grid).
export const COMPOSITION_CARD_LIMIT = 12

function xykName(a: number, b: number): string {
  return `${asset(a).symbol} / ${asset(b).symbol}`
}

export async function countLiquiditySources(assetId: number): Promise<number> {
  const [pools, prices] = await Promise.all([loadCurrentPools(), ensurePrices()])
  return currentSourcesForAsset(pools, prices, assetId).length
}

async function formerSourcesForAsset(pools: CurrentPools, assetId: number): Promise<FormerLiquiditySource[]> {
  const out: FormerLiquiditySource[] = []
  const xykRegRes = await client.query({
    query: `SELECT lp_asset_id, pool_account, asset_a, asset_b FROM price_data.xyk_pool_registry FINAL
            WHERE asset_a = {id:Int32} OR asset_b = {id:Int32}`,
    query_params: { id: assetId }, format: 'JSONEachRow',
  })

  const goneXyk = (await xykRegRes.json<{ lp_asset_id: number; pool_account: string; asset_a: number; asset_b: number }>())
    .filter(r => !pools.xykByAccount.has(r.pool_account))
  if (goneXyk.length) {
    const lastRes = await client.query({
      query: `SELECT pool_account, max(block_height) AS b, toString(argMax(block_timestamp, block_height)) AS ts
              FROM price_data.xyk_pool_reserve_history WHERE pool_account IN {accs:Array(String)} GROUP BY pool_account`,
      query_params: { accs: goneXyk.map(r => r.pool_account) }, format: 'JSONEachRow',
    })
    const lastByAccount = new Map<string, { b: number; ts: string }>()
    for (const r of await lastRes.json<{ pool_account: string; b: number; ts: string }>()) lastByAccount.set(r.pool_account, { b: Number(r.b), ts: r.ts })
    // A pair account is reused across incarnations — one former entry per account.
    const seen = new Set<string>()
    for (const r of goneXyk) {
      if (seen.has(r.pool_account)) continue
      seen.add(r.pool_account)
      const last = lastByAccount.get(r.pool_account)
      out.push({
        kind: 'xyk', poolId: r.lp_asset_id, name: xykName(r.asset_a, r.asset_b),
        // Pools that died before snapshot coverage have no sampled history —
        // explicit null, never an invented amount or date.
        lastActiveBlock: last?.b ?? null, lastActiveAt: last?.ts ?? null,
      })
    }
  }

  return out.sort((a, b) => (b.lastActiveBlock ?? -1) - (a.lastActiveBlock ?? -1))
}

async function assetLiquidityHistory(pools: CurrentPools, assetId: number): Promise<AssetLiquidityResponse['history']> {
  const dec = asset(assetId).decimals
  const end = lastClosedDay()

  // Per-day last sample per source. Amounts are parsed from raw strings and
  // display-normalized once, at the edge.
  const seriesPoints: { key: string; label: string; live: boolean; points: Map<string, number> }[] = []

  // XYK: every pool (live or destroyed) that ever contained the asset, from the
  // registry; the asset-side reserve is picked per sampled row because the
  // snapshot's pair order is authoritative per row.
  const xykRegRes = await client.query({
    query: `SELECT DISTINCT pool_account FROM price_data.xyk_pool_registry FINAL WHERE asset_a = {id:Int32} OR asset_b = {id:Int32}`,
    query_params: { id: assetId }, format: 'JSONEachRow',
  })
  const xykAccounts = (await xykRegRes.json<{ pool_account: string }>()).map(r => r.pool_account)
  if (xykAccounts.length) {
    const res = await client.query({
      query: `SELECT pool_account, toString(toDate(block_timestamp)) AS d,
                     toString(argMax(if(asset_a = {id:Int32}, toUInt256OrZero(reserve_a_raw), toUInt256OrZero(reserve_b_raw)), block_height)) AS v,
                     argMax(if(asset_a = {id:Int32}, asset_b, asset_a), block_height) AS partner
              FROM price_data.xyk_pool_reserve_history
              WHERE pool_account IN {accs:Array(String)} AND (asset_a = {id:Int32} OR asset_b = {id:Int32})
              GROUP BY pool_account, d ORDER BY pool_account, d`,
      query_params: { id: assetId, accs: xykAccounts }, format: 'JSONEachRow',
    })
    const byAccount = new Map<string, { partner: number; points: Map<string, number> }>()
    for (const r of await res.json<{ pool_account: string; d: string; v: string; partner: number }>()) {
      let e = byAccount.get(r.pool_account)
      if (!e) { e = { partner: r.partner, points: new Map() }; byAccount.set(r.pool_account, e) }
      e.partner = r.partner
      e.points.set(r.d, Number(BigInt(r.v)) / 10 ** dec)
    }
    for (const [account, e] of byAccount) {
      seriesPoints.push({
        key: `xyk:${account.slice(2, 10)}`,
        label: xykName(assetId, e.partner),
        live: pools.xykByAccount.has(account),
        points: e.points,
      })
    }
  }

  if (!seriesPoints.length) return { buckets: [], series: [] }

  let firstDay: string | null = null
  for (const s of seriesPoints) {
    for (const d of s.points.keys()) if (firstDay == null || d < firstDay) firstDay = d
  }
  const buckets = dailyGrid(firstDay!, end)

  const closes = (await dailyCloses([assetId])).get(assetId) ?? new Map<string, number>()
  const series: AssetLiquiditySeries[] = seriesPoints.map(s => {
    const amounts = carrySeries(buckets, s.points, s.live ? end : undefined)
    const usd = amounts.map((a, i) => {
      if (a == null) return null
      const px = closes.get(buckets[i])
      return px != null ? a * px : null
    })
    return { key: s.key, label: s.label, amounts, usd }
  })

  return { buckets, series: foldTopSeries(series, 5) }
}

// ── Every pool, largest first ─────────────────────────────────────────────────
//
// A pool is not a single number: it is a MIXTURE, so each entry carries its own
// composition and the page draws it, which is what tells a balanced pair apart
// from one holding a sliver against a whale.
//
// Everything here comes from the snapshot loadCurrentPools already caches, so
// the whole index is one pass over data the asset and pool pages share.
export interface PoolListEntry {
  kind: 'xyk'
  poolId: number | null            // LP share asset id
  name: string
  tvlUsd: number | null
  sharePct: number | null          // of all pooled value
  composition: PoolCompositionEntry[]
}
export interface PoolListResponse {
  totalTvlUsd: number | null
  pools: PoolListEntry[]
}

export async function getPoolsIndex(): Promise<PoolListResponse> {
  return cachedSwr('explorer:pools:index', 60_000, 300_000, async () => {
    const [pools, prices] = await Promise.all([loadCurrentPools(), ensurePrices()])
    const entries: PoolListEntry[] = []

    for (const pool of pools.xykByLp.values()) {
      const { entries: composition, tvlUsd } = buildComposition(prices, [
        { assetId: pool.assetA, raw: pool.reserveA },
        { assetId: pool.assetB, raw: pool.reserveB },
      ])
      entries.push({
        kind: 'xyk', poolId: pool.lpAssetId, name: `${asset(pool.assetA).symbol} / ${asset(pool.assetB).symbol}`,
        tvlUsd, sharePct: null, composition,
      })
    }

    return rankPools(entries)
  })
}

// Largest first, and each pool's share of everything pooled. A pool whose legs
// cannot all be priced has no TVL to rank by and sorts last rather than being
// dropped — it still holds tokens, they just have nothing to be worth, and the
// page says so. Kept pure so both rules stay pinned: most pools are unpriced, so
// "drop the unpriced" would quietly delete most of the list, and "treat unpriced
// as zero" would rank them among the empty ones as if that were measured.
export function rankPools(entries: PoolListEntry[]): PoolListResponse {
  const pools = [...entries].sort((a, b) => (b.tvlUsd ?? -1) - (a.tvlUsd ?? -1))
  const totalTvlUsd = pools.reduce((s, e) => s + (e.tvlUsd ?? 0), 0) || null
  for (const e of pools) {
    e.sharePct = totalTvlUsd != null && totalTvlUsd > 0 && e.tvlUsd != null ? (e.tvlUsd / totalTvlUsd) * 100 : null
  }
  return { totalTvlUsd, pools }
}

export async function getAssetLiquidity(assetId: number): Promise<AssetLiquidityResponse> {
  return cachedSwr(`explorer:asset-liquidity:${assetId}`, 60_000, 300_000, async () => {
    const [pools, prices] = await Promise.all([loadCurrentPools(), ensurePrices()])
    const sources = currentSourcesForAsset(pools, prices, assetId)
    const [former, history] = await Promise.all([
      formerSourcesForAsset(pools, assetId),
      assetLiquidityHistory(pools, assetId),
    ])
    let totalAmount = 0n
    for (const s of sources) totalAmount += BigInt(s.assetAmount)
    const totalUsd = usdOf(prices, assetId, totalAmount)
    return { asset: asset(assetId), totalAmount: totalAmount.toString(), totalUsd, sources, former, history }
  })
}

// pool detail (keyed by the LP share asset id)

async function blockTimestamp(block: number): Promise<string | null> {
  const res = await client.query({
    query: `SELECT toString(block_timestamp) AS ts FROM price_data.blocks WHERE block_height = {b:UInt32} LIMIT 1`,
    query_params: { b: block }, format: 'JSONEachRow',
  })
  return (await res.json<{ ts: string }>())[0]?.ts ?? null
}

async function xykDetail(lpAssetId: number, pools: CurrentPools, prices: Map<number, PriceInfo>): Promise<PoolDetailResponse | null> {
  const regRes = await client.query({
    query: `SELECT lp_asset_id, pool_account, asset_a, asset_b, created_block FROM price_data.xyk_pool_registry FINAL WHERE lp_asset_id = {id:Int32} LIMIT 1`,
    query_params: { id: lpAssetId }, format: 'JSONEachRow',
  })
  const reg = (await regRes.json<{ lp_asset_id: number; pool_account: string; asset_a: number; asset_b: number; created_block: number }>())[0]
  if (!reg) return null

  const current = pools.xykByAccount.get(reg.pool_account)
  // The account is shared across incarnations: this lp is only live if it is
  // the incarnation the snapshot maps to.
  const live = current != null && current.lpAssetId === lpAssetId
  const [histRes, sharesRes, createdAt] = await Promise.all([
    client.query({
      query: `SELECT toString(toDate(block_timestamp)) AS d,
                     argMax(asset_a, block_height) AS aa, argMax(asset_b, block_height) AS ab,
                     toString(argMax(toUInt256OrZero(reserve_a_raw), block_height)) AS ra,
                     toString(argMax(toUInt256OrZero(reserve_b_raw), block_height)) AS rb
              FROM price_data.xyk_pool_reserve_history WHERE pool_account = {acc:String}
              GROUP BY d ORDER BY d`,
      query_params: { acc: reg.pool_account }, format: 'JSONEachRow',
    }),
    client.query({
      query: `SELECT toString(argMax(total_shares_raw, block_height)) AS total FROM price_data.xyk_lp_total_shares_history WHERE lp_asset_id = {id:Int32} HAVING count() > 0`,
      query_params: { id: lpAssetId }, format: 'JSONEachRow',
    }),
    blockTimestamp(reg.created_block),
  ])
  const histRows = await histRes.json<{ d: string; aa: number; ab: number; ra: string; rb: string }>()
  const totalShares = (await sharesRes.json<{ total: string }>())[0]?.total ?? '0'

  const legs = live
    ? [{ assetId: current.assetA, raw: current.reserveA }, { assetId: current.assetB, raw: current.reserveB }]
    : [{ assetId: reg.asset_a, raw: 0n }, { assetId: reg.asset_b, raw: 0n }]
  const lastHist = histRows[histRows.length - 1]
  if (!live && lastHist) {
    legs[0] = { assetId: lastHist.aa, raw: BigInt(lastHist.ra) }
    legs[1] = { assetId: lastHist.ab, raw: BigInt(lastHist.rb) }
  }
  const { entries, tvlUsd } = live
    ? buildComposition(prices, legs)
    : { entries: legs.map(l => ({ asset: asset(l.assetId), amount: l.raw.toString(), usd: null, sharePct: null })), tvlUsd: null }

  const end = lastClosedDay()
  const histAssetIds = [...new Set(histRows.flatMap(r => [r.aa, r.ab]))]
  const closes = await dailyCloses(histAssetIds)
  const buckets = histRows.length ? dailyGrid(histRows[0].d, live ? end : lastHist.d) : []

  const compPoints = new Map<number, Map<string, number>>()
  for (const r of histRows) {
    for (const [id, raw] of [[r.aa, r.ra], [r.ab, r.rb]] as [number, string][]) {
      const dec = assetDescriptor(id).decimals
      let m = compPoints.get(id)
      if (!m) { m = new Map(); compPoints.set(id, m) }
      m.set(r.d, Number(BigInt(raw)) / 10 ** dec)
    }
  }
  const composition = histAssetIds.map(id => {
    const amounts = carrySeries(buckets, compPoints.get(id) ?? new Map())
    const dayCloses = closes.get(id)
    const usd = amounts.map((a, i) => {
      if (a == null) return null
      const px = dayCloses?.get(buckets[i])
      return px != null ? a * px : null
    })
    return { asset: assetDescriptor(id), amounts, usd }
  })
  const tvlSeries = buckets.map((_, i) => {
    let sum = 0
    let any = false
    for (const c of composition) {
      if (c.amounts[i] == null) continue
      any = true
      if (c.usd[i] == null) return null
      sum += c.usd[i]!
    }
    return any ? sum : null
  })

  return {
    kind: 'xyk',
    poolId: lpAssetId,
    name: xykName(legs[0].assetId, legs[1].assetId),
    account: accountRef(reg.pool_account),
    shareToken: asset(lpAssetId),
    createdBlock: reg.created_block,
    createdAt,
    destroyed: !live,
    tvlUsd,
    totalIssuance: totalShares,
    feePermill: XYK_FEE_PERMILL,
    assets: entries,
    history: { buckets, tvlUsd: tvlSeries, composition },
  }
}

export async function getPoolDetail(poolId: number): Promise<PoolDetailResponse | null> {
  return cachedSwr(`explorer:pool:${poolId}:model`, 30_000, 300_000, async () => {
    const [pools, prices] = await Promise.all([loadCurrentPools(), ensurePrices()])
    return xykDetail(poolId, pools, prices)
  })
}

// ── Liquidity providers ───────────────────────────────────────────────────────
//
// Who owns a pool: the holders of its fungible share token. The list ranks by
// shares and reconciles EXACTLY against the pool's own totals — Σ share
// balances = total issuance for every live pool.
//
// Custody that this list deliberately does NOT re-attribute: share tokens held
// by other custodial accounts appear as those accounts, which are tagged — the
// deep breakdown is the custodian's own LP list, one click away. XYK farm
// principal IS re-attributed (below), because the intervals table gives the
// per-owner split exactly.

// modl + "XYK///LM" — the XYK liquidity-mining pot that holds farm-deposited LP
// share tokens (its balance matches the open farm principal to the raw unit).
const XYK_LM_ACCOUNT = ('0x' + Buffer.from('modlXYK///LM', 'latin1').toString('hex')).padEnd(66, '0')

export interface PoolLpRow {
  rank: number
  account: AccountRef
  shares: string
  // Share-token principal currently deposited in an XYK liquidity-mining farm,
  // attributed to its economic owner. Already included in `shares`.
  farmedShares: string | null
  sharePct: number | null
  valueUsd: number | null
}
export interface PoolLpsResponse {
  poolId: number
  shareToken: AssetRef
  totalShares: string
  tvlUsd: number | null
  total: number
  lps: PoolLpRow[]
}

export interface PoolLpEntry { accountId: string; shares: bigint; farmedShares: bigint }

// Fold direct share-token balances with farm-attributed principal. Attributed
// custody REPLACES the LM pot's balance — never adds to it — so the fold
// conserves the total exactly; any pot remainder the intervals do not cover
// (normally zero, possibly a mid-block race between the balance snapshot and
// the interval rebuild) stays visible on the tagged pot account rather than
// being scaled away or fabricated onto owners.
export function foldPoolLpEntries(
  direct: { accountId: string; balance: bigint }[],
  farmed: { accountId: string; shares: bigint }[],
  potAccountId: string,
  resolve: (id: string) => string = id => id,
): PoolLpEntry[] {
  const byAccount = new Map<string, PoolLpEntry>()
  const entry = (id: string): PoolLpEntry => {
    let e = byAccount.get(id)
    if (!e) { e = { accountId: id, shares: 0n, farmedShares: 0n }; byAccount.set(id, e) }
    return e
  }
  for (const d of direct) entry(resolve(d.accountId)).shares += d.balance
  let farmedTotal = 0n
  for (const f of farmed) farmedTotal += f.shares
  if (farmedTotal > 0n) {
    const pot = byAccount.get(resolve(potAccountId))
    if (pot) pot.shares -= pot.shares < farmedTotal ? pot.shares : farmedTotal
    for (const f of farmed) {
      const e = entry(resolve(f.accountId))
      e.shares += f.shares
      e.farmedShares += f.shares
    }
  }
  return [...byAccount.values()]
    .filter(e => e.shares > 0n)
    .sort((a, b) => (a.shares === b.shares ? (a.accountId < b.accountId ? -1 : 1) : (b.shares > a.shares ? 1 : -1)))
}

// Fraction of `total` that `shares` is, exact to 1e-12 via integer scaling —
// share amounts exceed 2^53, so a float division of the raw values would drift.
const SHARE_FRACTION_SCALE = 10n ** 12n
export function shareFraction(shares: bigint, total: bigint): number | null {
  if (total <= 0n) return null
  return Number((shares * SHARE_FRACTION_SCALE) / total) / 1e12
}

async function loadPoolLpEntries(poolId: number): Promise<PoolLpEntry[]> {
  const [balRes, farmRes] = await Promise.all([
    client.query({
      // Latest-balance aggregate only (the same source the holders page reads):
      // share tokens are plain substrate Tokens balances, and Σ balances equals
      // the pool's total issuance exactly, so there is nothing to top up.
      query: `SELECT account_id, toString(bal) AS balance FROM (
                SELECT account_id, toUInt256OrZero(argMaxMerge(total_state)) AS bal
                FROM price_data.account_asset_latest_balances
                WHERE asset_id = {asset:String} GROUP BY account_id
              ) WHERE bal > 0`,
      query_params: { asset: String(poolId) }, format: 'JSONEachRow',
    }),
    client.query({
      query: `SELECT account_id, toString(sum(toInt256(principal_shares_raw))) AS shares
              FROM price_data.xyk_farm_principal_intervals FINAL
              WHERE lp_asset_id = {id:Int32} AND valid_to_block = 0
              GROUP BY account_id`,
      query_params: { id: poolId }, format: 'JSONEachRow',
    }),
  ])
  const direct = (await balRes.json<{ account_id: string; balance: string }>())
    .map(r => ({ accountId: r.account_id, balance: BigInt(r.balance) }))
  const farmed = (await farmRes.json<{ account_id: string; shares: string }>())
    .map(r => ({ accountId: r.account_id, shares: BigInt(r.shares) }))
    .filter(f => f.shares > 0n)
  return foldPoolLpEntries(direct, farmed, XYK_LM_ACCOUNT)
}

// Paginated LP list for a pool, ranked by shares. Share % and value are
// fractions of the SAME totalIssuance/tvlUsd the pool page shows, so the two
// surfaces can never disagree. The full ranked fold is cached once per pool;
// pages are deterministic slices of it.
export async function getPoolLps(poolId: number, limit: number, offset: number): Promise<PoolLpsResponse | null> {
  const detail = await getPoolDetail(poolId)
  if (!detail) return null
  const entries = await cachedSwr(`explorer:pool-lps:${poolId}`, 30_000, 300_000, () => loadPoolLpEntries(poolId))
  const totalShares = BigInt(detail.totalIssuance || '0')
  const lps = entries.slice(offset, offset + limit).map((e, i) => {
    const frac = shareFraction(e.shares, totalShares)
    return {
      rank: offset + i + 1,
      account: accountRef(e.accountId),
      shares: e.shares.toString(),
      farmedShares: e.farmedShares > 0n ? e.farmedShares.toString() : null,
      sharePct: frac != null ? frac * 100 : null,
      valueUsd: frac != null && detail.tvlUsd != null ? detail.tvlUsd * frac : null,
    }
  })
  return {
    poolId,
    shareToken: detail.shareToken,
    totalShares: detail.totalIssuance,
    tvlUsd: detail.tvlUsd,
    total: entries.length,
    lps,
  }
}
