import { createClickHouseClient } from '../db/client.js'
import { config } from '../config.js'
import { hasFlag, integerOption, stringOption } from '../util/cliArgs.js'
import {
  COINGECKO_HISTORY_DAYS,
  addUtcDays,
  binanceKlinesUrl,
  coingeckoMarketChartUrl,
  KsmReferenceIndex,
  missingSettledDays,
  parseBinanceKlines,
  parseCoinGeckoMarketChart,
  planReferenceSources,
  selectRowsForDays,
  utcDayFromMs,
  utcDayToMs,
  type ReferenceRow,
} from '../price/reference.js'
import { fetchJson, insertReferenceRows, loadReferenceIndex } from '../price/referenceService.js'

// Backfill of price_data.ksm_usd_reference — the settled daily KSM/USD closes
// every historical Basilisk price is anchored on.
//
// Two sources, spliced at CoinGecko's 365-day history limit (its free API
// answers a longer window with error 10012): CoinGecko for the recent year,
// Binance KSMUSDT daily klines for everything before it, back past Basilisk's
// July 2021 genesis.
//
// Idempotent and resumable by construction: it writes only days that have no
// settled close yet, so re-running fills the gaps and touches nothing else. That
// is also what keeps history deterministic — a day's close, once stored, is
// never rewritten by a later run whose splice line has moved, so replaying an
// old block range always reproduces the same USD prices. `--refresh` is the
// deliberate exception.
//
// Usage:
//   npm run backfill:ksm-reference
//   npm run backfill:ksm-reference -- --from=2021-07-01 --to=2022-12-31
//   npm run backfill:ksm-reference -- --refresh          (rewrite stored days)
//   npm run backfill:ksm-reference -- --dry-run

// Basilisk's genesis block is in July 2021. Binance's KSMUSDT daily series
// predates it, so the default range covers the chain's whole life.
const BASILISK_GENESIS_DAY = '2021-07-01'
const BINANCE_PAGE_LIMIT = 1_000
const MS_PER_DAY = 86_400_000
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function dayOption(name: string, fallback: string): string {
  const value = stringOption(name)
  if (value == null) return fallback
  if (!DAY_PATTERN.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`--${name} must be a UTC day as YYYY-MM-DD (got ${value})`)
  }
  return value
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const dryRun = hasFlag('dry-run')
const refresh = hasFlag('refresh')
const historyDays = integerOption('coingecko-days', COINGECKO_HISTORY_DAYS, { min: 1, max: 365 })
const today = utcDayFromMs(Date.now())
const fromDay = dayOption('from', BASILISK_GENESIS_DAY)
const toDay = dayOption('to', addUtcDays(today, -1))

async function fetchCoinGeckoCloses(days: string[]): Promise<ReferenceRow[]> {
  if (days.length === 0) return []
  const url = coingeckoMarketChartUrl(config.COINGECKO_API_URL, config.KSM_REFERENCE_COIN_ID, historyDays)
  console.log(`[Reference] CoinGecko: requesting ${historyDays} daily points for ${days.length} missing day(s)`)
  // The response reaches one day past the splice line (its oldest midnight point
  // closes the day before it), so it is narrowed to the days actually assigned
  // to it — the boundary stays exactly where planReferenceSources put it rather
  // than wherever the response happened to start.
  return selectRowsForDays(parseCoinGeckoMarketChart(await fetchJson(url)), days)
}

/**
 * Walk Binance's daily klines forward from the oldest missing day.
 *
 * `startTime` pages 1,000 rows at a time and the response is ascending, so each
 * page resumes one day past the last row it returned. A short page means the
 * series has run out.
 */
async function fetchBinanceCloses(fromDay: string, toDay: string): Promise<ReferenceRow[]> {
  const rows: ReferenceRow[] = []
  let cursorMs = utcDayToMs(fromDay)
  const endMs = utcDayToMs(toDay)
  while (cursorMs <= endMs) {
    const url = binanceKlinesUrl(config.BINANCE_API_URL, config.KSM_REFERENCE_SYMBOL, cursorMs, BINANCE_PAGE_LIMIT)
    const page = parseBinanceKlines(await fetchJson(url))
    if (page.length === 0) break
    for (const row of page) rows.push(row)
    const lastMs = utcDayToMs(page[page.length - 1].day)
    if (lastMs < cursorMs) break
    cursorMs = lastMs + MS_PER_DAY
    console.log(`[Reference] Binance: ${rows.length} day(s) through ${page[page.length - 1].day}`)
    if (page.length < BINANCE_PAGE_LIMIT) break
  }
  return rows
}

async function main(): Promise<void> {
  if (fromDay > toDay) throw new Error(`--from (${fromDay}) is after --to (${toDay})`)
  const client = createClickHouseClient()
  try {
    const index = await loadReferenceIndex(client)
    console.log(
      `[Reference] Stored: ${index.settledDayCount} settled day(s)` +
      (index.settledDayCount ? ` (${index.earliestSettledDay()} → ${index.latestSettledDay()})` : ''),
    )

    // --refresh rewrites the requested range; the default run only fills holes.
    const wanted = refresh
      ? missingSettledDays(new KsmReferenceIndex(), fromDay, toDay, today)
      : missingSettledDays(index, fromDay, toDay, today)
    if (wanted.length === 0) {
      console.log(`[Reference] Nothing to do: ${fromDay} → ${toDay} is already settled`)
      return
    }
    console.log(`[Reference] Missing ${wanted.length} settled day(s) in ${wanted[0]} → ${wanted[wanted.length - 1]}`)

    const plan = planReferenceSources(wanted, today, historyDays)
    const byDay = new Map<string, ReferenceRow>()
    const failures: string[] = []

    // Each source fills its own assignment first, then covers for the other. A
    // source being down costs the days only it can reach, never the whole run.
    if (plan.coingeckoDays.length > 0) {
      try {
        for (const row of await fetchCoinGeckoCloses(plan.coingeckoDays)) byDay.set(row.day, row)
      } catch (error) {
        failures.push(`coingecko: ${describeError(error)}`)
        console.error(`[Reference] CoinGecko history failed: ${describeError(error)}`)
      }
    }

    const stillMissing = wanted.filter(day => !byDay.has(day))
    if (stillMissing.length > 0) {
      try {
        const closes = await fetchBinanceCloses(stillMissing[0], stillMissing[stillMissing.length - 1])
        for (const row of closes) {
          if (!byDay.has(row.day)) byDay.set(row.day, row)
        }
      } catch (error) {
        failures.push(`binance: ${describeError(error)}`)
        console.error(`[Reference] Binance klines failed: ${describeError(error)}`)
      }
    }

    const rows = wanted.map(day => byDay.get(day)).filter((row): row is ReferenceRow => row != null)
    const uncovered = wanted.filter(day => !byDay.has(day))
    const perSource = new Map<string, number>()
    for (const row of rows) perSource.set(row.source, (perSource.get(row.source) ?? 0) + 1)

    if (dryRun) {
      console.log(`[Reference] Dry run: would write ${rows.length} day(s)`)
    } else {
      await insertReferenceRows(client, rows)
      console.log(`[Reference] Wrote ${rows.length} settled day(s)`)
    }
    for (const [source, count] of [...perSource].sort()) {
      console.log(`[Reference]   ${source}: ${count} day(s)`)
    }

    // Report gaps rather than failing: a partial reference is usable (the blocks
    // it covers get priced, the rest explicitly do not) and re-running fills it.
    if (uncovered.length > 0) {
      console.warn(
        `[Reference] ${uncovered.length} day(s) not covered by any source: ` +
        `${uncovered[0]} → ${uncovered[uncovered.length - 1]}` +
        (uncovered.length <= 10 ? ` (${uncovered.join(', ')})` : ''),
      )
    }
    if (failures.length > 0) console.warn(`[Reference] Source failures: ${failures.join('; ')}`)
  } finally {
    await client.close()
  }
}

main().catch(error => {
  console.error('[Reference] Backfill failed:', error)
  process.exitCode = 1
})
