// The KSM/USD reference — the one external number the Basilisk valuation model
// rests on.
//
// Basilisk quotes exactly two assets in USD. KSM (asset 1) takes its price from
// an off-chain reference stored in `price_data.ksm_usd_reference`; BSX (asset 0)
// is priced from it through the BSX/KSM XYK pool's reserve ratio. Every other
// asset is deliberately unpriced, and the BSX/USDT pool is deliberately NOT a
// pricing input — the chain is quiet enough that it sits un-arbitraged.
//
// Everything here is pure — day arithmetic, decimal formatting, the two-source
// splice, the response parsers and the anchor-selection rule — so the whole
// model is testable without the network or ClickHouse. The I/O lives in
// `referenceService.ts` (read cache + live poll) and
// `scripts/backfill-ksm-reference.ts` (history).

/** KSM. The reference asset: its USD price comes from off-chain, not a pool. */
export const KSM_ASSET_ID = 1

/**
 * Reference grain.
 *
 * `close` — the settled close of a UTC day that has ended. Written once and
 *   never rewritten, so a replay of an old block range reproduces it exactly.
 * `live`  — an intraday poll of the CURRENT day. Provisional by construction and
 *   only ever consulted for blocks inside the live window (see `lookup`).
 *
 * The two grains are separate rows for the same day on purpose: a settled close
 * must never depend on a replacement having happened, and a live row must never
 * be able to overwrite one.
 */
export type ReferenceGrain = 'close' | 'live'

export type ReferenceSource = 'binance' | 'coingecko' | 'coingecko-live'

export interface ReferenceRow {
  /** UTC day, `YYYY-MM-DD`. Lexical order is chronological order. */
  day: string
  grain: ReferenceGrain
  /** USD price as a fixed 12-decimal string — the scale `price_data.prices` uses. */
  usd_price: string
  source: ReferenceSource
}

export interface ReferenceLookup {
  usdPrice: string
  day: string
  grain: ReferenceGrain
  source: ReferenceSource
  /** Whole UTC days between the row's day and the block's own day. */
  staleDays: number
}

/** The scale of `price_data.prices.usd_price`, carried end to end as a string. */
export const PRICE_DECIMALS = 12

/**
 * How recent a block must be for a provisional intraday row to value it.
 *
 * Outside this window valuation is settled-closes-only and therefore replayable;
 * inside it the live poll is allowed to keep the head's USD price current. 48h is
 * two full day boundaries, so a block is only ever provisional until the day it
 * belongs to has closed and been settled.
 */
export const DEFAULT_LIVE_WINDOW_MS = 48 * 60 * 60 * 1000

/**
 * How far back a settled close may be reused when days are missing.
 *
 * A gap in the reference (a source outage during a backfill) must not silently
 * value a week of blocks at one stale price. Past this bound the anchor is
 * absent and nothing is priced — explicit incompleteness rather than a plausible
 * fallback.
 */
export const MAX_SETTLED_STALENESS_DAYS = 7

const MS_PER_DAY = 86_400_000

// CoinGecko's free API rejects a history request beyond 365 days (error 10012),
// so it covers the recent year and Binance covers everything older. The splice
// is one day inside the hard limit so a run that straddles midnight cannot ask
// for a day the API has just dropped.
export const COINGECKO_HISTORY_DAYS = 365

export function utcDayFromMs(ms: number): string {
  return new Date(ms - (ms % MS_PER_DAY)).toISOString().slice(0, 10)
}

export function utcDayToMs(day: string): number {
  const ms = Date.parse(`${day}T00:00:00.000Z`)
  if (!Number.isFinite(ms)) throw new Error(`Invalid UTC day: ${day}`)
  return ms
}

export function addUtcDays(day: string, delta: number): string {
  return utcDayFromMs(utcDayToMs(day) + delta * MS_PER_DAY)
}

export function utcDaysBetween(fromDay: string, toDay: string): string[] {
  const days: string[] = []
  for (let ms = utcDayToMs(fromDay); ms <= utcDayToMs(toDay); ms += MS_PER_DAY) {
    days.push(utcDayFromMs(ms))
  }
  return days
}

function truncateFixedPoint(sign: string, integerPart: string, fraction: string): string {
  return `${sign}${integerPart || '0'}.${fraction.padEnd(PRICE_DECIMALS, '0').slice(0, PRICE_DECIMALS)}`
}

/**
 * Normalize an external price to the fixed 12-decimal string the rest of the
 * pipeline uses. Returns null for anything that is not a usable positive price.
 *
 * A string source (Binance klines are fixed-point strings) keeps its own digits —
 * they are never routed through a double. A JSON number (CoinGecko) is already a
 * double by the time it is parsed, so it is formatted once, here, deterministically.
 */
export function formatUsdPrice(value: number | string): string | null {
  if (typeof value === 'string') {
    const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(value.trim())
    if (match == null || (match[2] === '' && (match[3] ?? '') === '')) return null
    const formatted = truncateFixedPoint(match[1], match[2], match[3] ?? '')
    return isPositivePrice(formatted) ? formatted : null
  }
  // toFixed switches to exponential notation above 1e21 and loses meaning long
  // before that; a reference price outside this range is a broken feed, not a
  // number to round.
  if (!Number.isFinite(value) || value <= 0 || value >= 1e15) return null
  const formatted = value.toFixed(PRICE_DECIMALS)
  return isPositivePrice(formatted) ? formatted : null
}

function isPositivePrice(formatted: string): boolean {
  return !formatted.startsWith('-') && /[1-9]/.test(formatted)
}

function compareDays(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * In-memory index over the reference table.
 *
 * The table holds at most two rows per day for the chain's whole life (a few
 * thousand), so the read path loads all of it and answers every block from
 * memory rather than querying per block.
 */
export class KsmReferenceIndex {
  private readonly closeDays: string[] = []
  private readonly closes = new Map<string, ReferenceRow>()
  private readonly lives = new Map<string, ReferenceRow>()

  constructor(rows: Iterable<ReferenceRow> = []) {
    for (const row of rows) this.put(row)
  }

  put(row: ReferenceRow): void {
    if (row.grain === 'live') {
      this.lives.set(row.day, row)
      return
    }
    if (!this.closes.has(row.day)) {
      const at = this.lowerBound(row.day)
      this.closeDays.splice(at, 0, row.day)
    }
    this.closes.set(row.day, row)
  }

  get settledDayCount(): number {
    return this.closeDays.length
  }

  latestSettledDay(): string | null {
    return this.closeDays[this.closeDays.length - 1] ?? null
  }

  earliestSettledDay(): string | null {
    return this.closeDays[0] ?? null
  }

  hasSettled(day: string): boolean {
    return this.closes.has(day)
  }

  /** Index of the first stored settled day >= `day`. */
  private lowerBound(day: string): number {
    let low = 0
    let high = this.closeDays.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (compareDays(this.closeDays[mid], day) < 0) low = mid + 1
      else high = mid
    }
    return low
  }

  /** The newest settled close strictly before `day`, or null. */
  latestSettledBefore(day: string): ReferenceRow | null {
    const at = this.lowerBound(day) - 1
    if (at < 0) return null
    return this.closes.get(this.closeDays[at]) ?? null
  }

  /**
   * The KSM anchor for a block, and the whole determinism rule in one place.
   *
   * SETTLED (canonical): the close of the last UTC day that ENDED before the
   * block's own UTC day. It carries no information from after the block, it is
   * written once and never rewritten, and it is the only thing consulted for a
   * block older than the live window — so replays and repairs of historical
   * ranges reproduce identical rows forever.
   *
   * LIVE (bounded exception): a block whose timestamp is within `liveWindowMs`
   * of now takes the provisional intraday row for its OWN day when one exists.
   * That value is not replayable — it is whatever the poll last saw — which is
   * exactly why the exception expires: once the block ages past the window the
   * settled rule takes over and the answer becomes fixed.
   *
   * Missing days are walked back over, bounded by `maxStaleDays`; past that the
   * anchor is absent and nothing gets a USD price.
   */
  lookup(
    blockTimestampMs: number,
    nowMs: number,
    options: { liveWindowMs?: number; maxStaleDays?: number } = {},
  ): ReferenceLookup | null {
    const liveWindowMs = options.liveWindowMs ?? DEFAULT_LIVE_WINDOW_MS
    const maxStaleDays = options.maxStaleDays ?? MAX_SETTLED_STALENESS_DAYS
    const blockDay = utcDayFromMs(blockTimestampMs)

    if (nowMs - blockTimestampMs <= liveWindowMs) {
      const live = this.lives.get(blockDay)
      if (live) return { usdPrice: live.usd_price, day: live.day, grain: 'live', source: live.source, staleDays: 0 }
    }

    const settled = this.latestSettledBefore(blockDay)
    if (settled == null) return null
    const staleDays = Math.round((utcDayToMs(blockDay) - utcDayToMs(settled.day)) / MS_PER_DAY)
    if (staleDays > maxStaleDays) return null
    return { usdPrice: settled.usd_price, day: settled.day, grain: 'close', source: settled.source, staleDays }
  }
}

// backfill planning

/**
 * Oldest day the CoinGecko history call can be trusted to cover, given today.
 * Days older than this belong to Binance.
 */
export function coingeckoEarliestDay(today: string, historyDays: number = COINGECKO_HISTORY_DAYS): string {
  return addUtcDays(today, -(historyDays - 1))
}

export interface ReferenceSourcePlan {
  coingeckoDays: string[]
  binanceDays: string[]
}

/**
 * Split the days a backfill still needs between the two sources at the 365-day
 * line. CoinGecko is the chosen source wherever it reaches; Binance carries the
 * rest, back past Basilisk's July 2021 genesis.
 */
export function planReferenceSources(
  missingDays: string[],
  today: string,
  historyDays: number = COINGECKO_HISTORY_DAYS,
): ReferenceSourcePlan {
  const boundary = coingeckoEarliestDay(today, historyDays)
  const coingeckoDays: string[] = []
  const binanceDays: string[] = []
  for (const day of missingDays) {
    if (compareDays(day, boundary) >= 0) coingeckoDays.push(day)
    else binanceDays.push(day)
  }
  return { coingeckoDays, binanceDays }
}

/**
 * Settled days a backfill should hold: everything in the requested range that
 * has no stored close yet. The current UTC day is never included — it has not
 * closed, so no source can publish its close.
 */
export function missingSettledDays(
  index: KsmReferenceIndex,
  fromDay: string,
  toDay: string,
  today: string,
): string[] {
  const lastSettledDay = addUtcDays(today, -1)
  const end = compareDays(toDay, lastSettledDay) <= 0 ? toDay : lastSettledDay
  if (compareDays(fromDay, end) > 0) return []
  return utcDaysBetween(fromDay, end).filter(day => !index.hasSettled(day))
}

// external responses

export function coingeckoMarketChartUrl(baseUrl: string, coinId: string, days: number): string {
  return `${baseUrl.replace(/\/+$/, '')}/coins/${coinId}/market_chart?vs_currency=usd&days=${days}&interval=daily`
}

export function coingeckoSimplePriceUrl(baseUrl: string, coinId: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/simple/price?ids=${coinId}&vs_currencies=usd`
}

export function binanceKlinesUrl(baseUrl: string, symbol: string, startTimeMs: number, limit: number): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/v3/klines?symbol=${symbol}&interval=1d&startTime=${startTimeMs}&limit=${limit}`
}

/**
 * CoinGecko daily history → settled daily closes.
 *
 * A `interval=daily` point is the price AT a UTC midnight, so the point stamped
 * `D 00:00` is the close of day `D-1`, not of day `D` (verified against Binance:
 * CoinGecko 2026-08-27T00:00 = 3.5596 against Binance's 2026-08-26 close of
 * 3.56, and the same one-day offset holds on every neighbouring day). The final
 * element of the response is the CURRENT price at an arbitrary time of day
 * rather than a midnight; it is not a close and is dropped.
 */
export function parseCoinGeckoMarketChart(body: unknown): ReferenceRow[] {
  const prices = (body as { prices?: unknown })?.prices
  if (!Array.isArray(prices)) return []
  const rows: ReferenceRow[] = []
  for (const point of prices) {
    if (!Array.isArray(point) || point.length < 2) continue
    const [timestamp, value] = point as [unknown, unknown]
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) continue
    if (timestamp % MS_PER_DAY !== 0) continue
    const usd_price = formatUsdPrice(value as number)
    if (usd_price == null) continue
    rows.push({ day: addUtcDays(utcDayFromMs(timestamp), -1), grain: 'close', usd_price, source: 'coingecko' })
  }
  return rows
}

export function parseCoinGeckoSimplePrice(body: unknown, coinId: string): string | null {
  const entry = (body as Record<string, unknown> | null)?.[coinId]
  const value = (entry as { usd?: unknown } | undefined)?.usd
  return typeof value === 'number' ? formatUsdPrice(value) : null
}

/**
 * Binance `KSMUSDT` daily klines → settled daily closes.
 *
 * A kline is `[openTime, open, high, low, close, …]` with `openTime` at the UTC
 * midnight that STARTS the day, so its close belongs to that same day. The last
 * kline of a live response is the day in progress and is dropped by the caller's
 * settled-day filter. USDT is taken as USD — the reference is a market rate, and
 * the peg's basis drift is far below the precision this model claims.
 */
export function parseBinanceKlines(body: unknown): ReferenceRow[] {
  if (!Array.isArray(body)) return []
  const rows: ReferenceRow[] = []
  for (const kline of body) {
    if (!Array.isArray(kline) || kline.length < 5) continue
    const openTime = kline[0]
    if (typeof openTime !== 'number' || !Number.isFinite(openTime)) continue
    if (openTime % MS_PER_DAY !== 0) continue
    const close = kline[4]
    const usd_price = typeof close === 'string' || typeof close === 'number' ? formatUsdPrice(close) : null
    if (usd_price == null) continue
    rows.push({ day: utcDayFromMs(openTime), grain: 'close', usd_price, source: 'binance' })
  }
  return rows
}

/** Keep only the rows a caller still needs, in ascending day order. */
export function selectRowsForDays(rows: ReferenceRow[], days: Iterable<string>): ReferenceRow[] {
  const wanted = new Set(days)
  const byDay = new Map<string, ReferenceRow>()
  for (const row of rows) {
    if (wanted.has(row.day)) byDay.set(row.day, row)
  }
  return [...byDay.values()].sort((left, right) => compareDays(left.day, right.day))
}
