import type { ClickHouseClient } from '../db/client.js'
import { config } from '../config.js'
import {
  COINGECKO_HISTORY_DAYS,
  KSM_ASSET_ID,
  KsmReferenceIndex,
  addUtcDays,
  coingeckoMarketChartUrl,
  coingeckoSimplePriceUrl,
  missingSettledDays,
  parseCoinGeckoMarketChart,
  parseCoinGeckoSimplePrice,
  selectRowsForDays,
  utcDayFromMs,
  type ReferenceRow,
} from './reference.js'
import type { PriceMap } from './types.ts'

// The read side of the KSM/USD reference, plus the live poll that keeps it
// current at the chain head.
//
// The whole table is at most two rows per day for the chain's life — a few
// thousand — so it is loaded once and every block is answered from memory. No
// block ever issues a query, and no path here is reachable from an API request.
//
// The rule that decides WHICH stored row values a block lives in
// KsmReferenceIndex.lookup (reference.ts); this module only supplies rows.

const REFERENCE_TABLE = 'price_data.ksm_usd_reference'
const RELOAD_INTERVAL_MS = 5 * 60_000
const FETCH_TIMEOUT_MS = 15_000
// How much of the recent past the live loop settles for itself. Anything older
// is the backfill's job — this exists so a day does not stay provisional just
// because nobody ran a script, not to become a second backfill.
const SETTLE_RECENT_DAYS = 30
// Spacing between settle attempts while days are still missing, so a source
// outage costs a request an hour rather than one per poll.
const SETTLE_RETRY_MS = 3_600_000

interface ReferenceQueryRow {
  day: string
  grain: string
  usd_price: string
  source: string
}

export async function loadReferenceIndex(client: ClickHouseClient): Promise<KsmReferenceIndex> {
  const result = await client.query({
    query: `SELECT toString(day) AS day, grain, toString(usd_price) AS usd_price, source
            FROM ${REFERENCE_TABLE} FINAL
            ORDER BY day, grain`,
    format: 'JSONEachRow',
  })
  const rows = await result.json<ReferenceQueryRow>()
  return new KsmReferenceIndex(rows.map(row => ({
    day: row.day,
    grain: row.grain === 'live' ? 'live' : 'close',
    usd_price: row.usd_price,
    source: row.source as ReferenceRow['source'],
  })))
}

export async function insertReferenceRows(client: ClickHouseClient, rows: ReferenceRow[]): Promise<void> {
  if (rows.length === 0) return
  // `ingested_at` is left to the table's DEFAULT now(), which is what orders
  // replacements: a re-backfill of the same (day, grain) always carries a later
  // version than the row it corrects.
  await client.insert({ table: REFERENCE_TABLE, values: rows, format: 'JSONEachRow' })
}

export async function fetchJson(url: string, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

export interface KsmReferenceServiceOptions {
  /** Poll CoinGecko and write live rows. Off for bounded/backfill runs. */
  live?: boolean
  pollMs?: number
  liveWindowMs?: number
  now?: () => number
  fetchJson?: (url: string) => Promise<unknown>
}

/**
 * Serves the KSM anchor for a block and, in live mode, keeps the reference fresh.
 *
 * The live loop does two things per cycle: it writes the current day's
 * provisional row from `simple/price`, and — when a recent day still has no
 * settled close — it settles what it can from the daily history. The second half
 * is what makes the deterministic path converge without an operator running the
 * backfill every morning.
 *
 * A CoinGecko failure is never fatal. The newest stored row keeps serving and the
 * staleness is logged; only the freshness of the head's USD price degrades.
 */
export class KsmReferenceService {
  private readonly client: ClickHouseClient
  private readonly live: boolean
  private readonly pollMs: number
  private readonly liveWindowMs: number
  private readonly now: () => number
  private readonly fetchJson: (url: string) => Promise<unknown>
  private index = new KsmReferenceIndex()
  private loadedAtMs = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private polling = false
  private lastPollOkMs = 0
  private lastMissingLogDay = ''
  private lastSettleAttemptMs = 0

  constructor(client: ClickHouseClient, options: KsmReferenceServiceOptions = {}) {
    this.client = client
    this.live = options.live === true
    this.pollMs = options.pollMs ?? config.KSM_REFERENCE_POLL_MS
    this.liveWindowMs = options.liveWindowMs ?? config.KSM_REFERENCE_LIVE_WINDOW_HOURS * 3_600_000
    this.now = options.now ?? Date.now
    this.fetchJson = options.fetchJson ?? (url => fetchJson(url))
  }

  async start(): Promise<void> {
    await this.reload()
    const settled = this.index.settledDayCount
    if (settled === 0) {
      console.warn(
        '[Reference] price_data.ksm_usd_reference is empty: no KSM anchor, so no asset gets a USD price. ' +
        'Run `npm run backfill:ksm-reference`.',
      )
    } else {
      console.log(
        `[Reference] Loaded ${settled} settled KSM/USD days ` +
        `(${this.index.earliestSettledDay()} → ${this.index.latestSettledDay()})`,
      )
    }
    if (!this.live) return
    await this.poll()
    this.timer = setInterval(() => { void this.poll() }, this.pollMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer != null) clearInterval(this.timer)
    this.timer = null
  }

  async reload(): Promise<void> {
    this.index = await loadReferenceIndex(this.client)
    this.loadedAtMs = this.now()
  }

  /**
   * The price seed for a block: KSM at its reference price, or nothing.
   *
   * An absent anchor yields an empty map, which prices nothing at all — the
   * pipeline writes no USD price rather than inventing one.
   */
  seedFor(blockTimestampMs: number): PriceMap {
    const anchor = this.index.lookup(blockTimestampMs, this.now(), { liveWindowMs: this.liveWindowMs })
    const seed: PriceMap = new Map()
    if (anchor == null) {
      const day = utcDayFromMs(blockTimestampMs)
      if (day !== this.lastMissingLogDay) {
        this.lastMissingLogDay = day
        console.warn(`[Reference] No KSM/USD reference within range of ${day}: assets are unpriced for those blocks`)
      }
      return seed
    }
    seed.set(KSM_ASSET_ID, anchor.usdPrice)
    return seed
  }

  /** Reload from ClickHouse when the in-memory copy has aged out. */
  async refreshIfStale(): Promise<void> {
    if (this.now() - this.loadedAtMs < RELOAD_INTERVAL_MS) return
    try {
      await this.reload()
    } catch (error) {
      console.error('[Reference] Reload failed, serving the loaded reference:', error)
      this.loadedAtMs = this.now()
    }
  }

  /** One live cycle: the timer's body, re-entrancy guarded and never throwing. */
  async poll(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      const nowMs = this.now()
      const today = utcDayFromMs(nowMs)
      const price = parseCoinGeckoSimplePrice(
        await this.fetchJson(coingeckoSimplePriceUrl(config.COINGECKO_API_URL, config.KSM_REFERENCE_COIN_ID)),
        config.KSM_REFERENCE_COIN_ID,
      )
      if (price == null) throw new Error('response carried no usd price')
      const row: ReferenceRow = { day: today, grain: 'live', usd_price: price, source: 'coingecko-live' }
      await insertReferenceRows(this.client, [row])
      this.index.put(row)
      this.lastPollOkMs = nowMs
      await this.settleRecentDays(today, nowMs)
    } catch (error) {
      this.warnStale(error)
    } finally {
      this.polling = false
    }
  }

  /**
   * Settle the recent days the backfill has not, so a day does not stay
   * provisional just because nobody ran a script. Bounded to
   * SETTLE_RECENT_DAYS and retried at most hourly; older history stays
   * `backfill:ksm-reference`'s job.
   *
   * Requests the same full daily window the backfill uses rather than a narrow
   * one: that response shape is the verified one (points at UTC midnights, each
   * closing the previous day), and the guard above means it is asked for at most
   * once an hour and not at all once the recent days are settled.
   */
  private async settleRecentDays(today: string, nowMs: number): Promise<void> {
    const wanted = missingSettledDays(this.index, addUtcDays(today, -SETTLE_RECENT_DAYS), today, today)
    if (wanted.length === 0) return
    if (nowMs - this.lastSettleAttemptMs < SETTLE_RETRY_MS) return
    this.lastSettleAttemptMs = nowMs

    const url = coingeckoMarketChartUrl(config.COINGECKO_API_URL, config.KSM_REFERENCE_COIN_ID, COINGECKO_HISTORY_DAYS)
    const rows = selectRowsForDays(parseCoinGeckoMarketChart(await this.fetchJson(url)), wanted)
    if (rows.length === 0) return
    await insertReferenceRows(this.client, rows)
    for (const row of rows) this.index.put(row)
    console.log(`[Reference] Settled ${rows.length} day(s): ${rows[0].day} → ${rows[rows.length - 1].day} (coingecko)`)
  }

  private warnStale(error: unknown): void {
    const newest = this.index.latestSettledDay()
    const ageMinutes = this.lastPollOkMs > 0 ? Math.round((this.now() - this.lastPollOkMs) / 60_000) : null
    console.warn(
      `[Reference] CoinGecko poll failed (${error instanceof Error ? error.message : String(error)}); ` +
      `serving the stored reference` +
      (newest ? `, newest settled day ${newest}` : ' (no settled days stored)') +
      (ageMinutes == null ? ', never polled successfully' : `, last successful poll ${ageMinutes}m ago`),
    )
  }
}
