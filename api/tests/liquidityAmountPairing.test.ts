import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LIQUIDITY_AMOUNT_ARG, liquidityAmountFromArgs, liquidityActionEventNames } from '../src/services/explorerService.ts'

const schema = readFileSync(new URL('../../clickhouse/schema/003_materialized_views.sql', import.meta.url), 'utf8')

// A liquidity row displays one amount against one asset_id, and the event arg that
// holds that amount differs per event. A generic presence chain
// (claimed → amount → shares) pairs them wrongly: `shares` is denominated in the
// pool's LP share token, which on Basilisk is NEVER the asset a row displays —
// XYK.LiquidityRemoved is {who, assetA, assetB, shares}, so a fallthrough renders
// share units at assetA's price. Every derivation of the display amount (the
// service's arg map plus both materialized views) must therefore leave `shares`
// alone: no XYK liquidity event is share-denominated, so nothing may read it.
const SHARE_DENOMINATED = Object.entries(LIQUIDITY_AMOUNT_ARG)
  .filter(([, arg]) => arg === 'shares')
  .map(([name]) => name)
  .sort()

// One statement out of the declarative schema, so a `shares` read belonging to a
// different view can never satisfy the assertions below.
function mvStatement(target: string): string {
  const statement = schema.split(/^CREATE MATERIALIZED VIEW /m).find(s => s.startsWith(target))
  expect(statement, `${target} missing from 003_materialized_views.sql`).toBeTruthy()
  return statement as string
}

describe('liquidity display amount pairing', () => {
  it('decides an amount arg for every event the liquidity read model ingests', () => {
    const ingested = mvStatement('IF NOT EXISTS price_data.liquidity_activity_mv')
    const where = ingested.slice(ingested.lastIndexOf('WHERE event_name IN ('))
    const names = [...new Set([...where.matchAll(/'([A-Za-z]+\.[A-Za-z]+)'/g)].map(m => m[1]))].sort()

    expect(names.length).toBeGreaterThan(0)
    expect(Object.keys(LIQUIDITY_AMOUNT_ARG).sort()).toEqual(names)
  })

  // The arg map was pinned to the view, and the view to the arg map, but the LIST
  // the feed actually selects on sat outside the loop: a name could be added to
  // two of the three and still render. Close it — all three carry one set.
  it('selects exactly the events it decides an amount for', () => {
    expect(liquidityActionEventNames().sort()).toEqual(Object.keys(LIQUIDITY_AMOUNT_ARG).sort())
  })

  // Arg shapes as emitted on chain — one per liquidity event name.
  it('reads only the arg denominated in the row\'s displayed asset', () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ['XYK.LiquidityAdded', { who: 'x', assetA: 0, assetB: 5, amountA: '600', amountB: '7' }, ''],
      ['XYK.LiquidityRemoved', { who: 'x', assetA: 1000085, assetB: 5, shares: '21174522741' }, ''],
      ['XYK.PoolCreated', { who: 'x', assetA: 0, assetB: 5, initialSharesAmount: '500', shareToken: 9, pool: 'p' }, ''],
      ['XYK.PoolDestroyed', { who: 'x', assetA: 222, assetB: 0, shareToken: 1001296, pool: 'p' }, ''],
      // Basilisk block 1,972,469 seeded its first LBP and 1,994,210 drained it;
      // both carry amountA/amountB against assetA/assetB, so like XYK's add there
      // is no arg in the row's own denomination and the amount stays empty.
      ['LBP.LiquidityAdded', { who: 'x', assetA: 1, assetB: 6, amountA: '1000000000000000', amountB: '380250000000000000' }, ''],
      ['LBP.LiquidityRemoved', { who: 'x', assetA: 1, assetB: 6, amountA: '3984504060182772', amountB: '173639750351813024' }, ''],
      ['XYKLiquidityMining.RewardClaimed', { who: 'x', claimed: '400', rewardCurrency: 0, depositId: '1' }, '400'],
    ]

    expect(cases.map(([name]) => name).sort()).toEqual(Object.keys(LIQUIDITY_AMOUNT_ARG).sort())
    for (const [name, args, expected] of cases) {
      expect(liquidityAmountFromArgs(name, args), name).toBe(expected)
    }
  })

  it('never reads shares as a display amount, in the arg map or either view', () => {
    expect(SHARE_DENOMINATED).toEqual([])
    // A bare `JSONHas(args_json, 'shares')` fallthrough anywhere in either view is
    // exactly the mispairing this pin exists to catch, guarded or not: no event
    // these views ingest displays its amount in share units.
    for (const target of ['IF NOT EXISTS price_data.liquidity_activity_mv', 'IF NOT EXISTS price_data.account_activity_v3_mv']) {
      expect(mvStatement(target), `${target} reads shares`).not.toContain("args_json, 'shares'")
    }
  })
})
