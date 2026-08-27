import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { swapEventAmounts } from '../src/services/explorerService.ts'
import { QUEUE_AMOUNT_IN_SQL, QUEUE_AMOUNT_OUT_SQL } from '../src/db/accountSwapQueue.ts'

const schema = readFileSync(new URL('../../clickhouse/schema/003_materialized_views.sql', import.meta.url), 'utf8')

// XYK.BuyExecuted and LBP.BuyExecuted carry the same two field names and mean the
// opposite by them: XYK is (amount = received, buyPrice = paid), LBP is (amount =
// paid, buyPrice = received). Verified against the Router.RouteExecuted of the same
// extrinsic over the whole legacy era — LBP buyPrice = amountOut in 26/26 routed
// buys, XYK amount = amountOut in 396/446 (the rest multi-hop, where a single leg
// is not the route total). Sells agree across both pallets.
//
// The disagreement is silent: both events validate, both amounts are plausible
// integers, and only the decimals differ. So nothing but a pinned expectation stops
// a layer from reading one with the other's order, and every surface that renders a
// legacy swap is asserted here at once — the one that regresses is the one nobody
// re-derived.
const PAID = { 'XYK.SellExecuted': 'amount', 'LBP.SellExecuted': 'amount', 'XYK.BuyExecuted': 'buyPrice', 'LBP.BuyExecuted': 'amount' }
const RECEIVED = { 'XYK.SellExecuted': 'salePrice', 'LBP.SellExecuted': 'salePrice', 'XYK.BuyExecuted': 'amount', 'LBP.BuyExecuted': 'buyPrice' }
const LEGACY_EVENTS = Object.keys(PAID) as (keyof typeof PAID)[]

// One statement out of the declarative schema, so an extraction belonging to a
// different view can never satisfy the assertions below.
function mvStatement(target: string): string {
  const statement = schema.split(/^CREATE MATERIALIZED VIEW /m).find(s => s.startsWith(`IF NOT EXISTS price_data.${target} `))
  expect(statement, `${target} missing from 003_materialized_views.sql`).toBeTruthy()
  return statement as string
}

// The expression a `… AS <alias>` column is built from, recovered by matching
// parentheses backwards from the alias. Reading the real expression rather than
// grepping the whole statement keeps one column's extraction from satisfying an
// assertion about another's.
function expressionFor(sql: string, alias: string): string {
  const at = sql.indexOf(` AS ${alias}`)
  expect(at, `${alias} not found in this statement`).toBeGreaterThan(0)
  let depth = 0
  for (let i = at - 1; i >= 0; i--) {
    if (sql[i] === ')') depth++
    else if (sql[i] === '(' && --depth === 0) return sql.slice(i, at)
  }
  throw new Error(`unbalanced expression for ${alias}`)
}

// The arg the multiIf chain decides for `event`: the first branch whose condition
// names it, whichever equality form the branch is written in.
function chainArg(expr: string, event: string): string {
  const name = event.replace('.', '\\.')
  const match = expr.match(new RegExp(
    `event_name (?:= '${name}'|IN \\([^)]*'${name}'[^)]*\\))\\s*,\\s*JSONExtractString\\(args_json, ?'([A-Za-z]+)'\\)`,
  ))
  return match ? match[1] : 'NO-BRANCH'
}

const SWAP_VIEWS = ['swap_activity_mv', 'asset_swap_activity_mv', 'account_swap_activity_queue_mv']

describe('legacy buy orientation', () => {
  it('splits the buy arm by pallet in every swap materialized view', () => {
    for (const view of SWAP_VIEWS) {
      const sql = mvStatement(view)
      const amountIn = expressionFor(sql, 'amount_in')
      const amountOut = expressionFor(sql, 'amount_out')
      for (const event of LEGACY_EVENTS) {
        expect(chainArg(amountIn, event), `${view} amount_in for ${event}`).toBe(PAID[event])
        expect(chainArg(amountOut, event), `${view} amount_out for ${event}`).toBe(RECEIVED[event])
      }
    }
  })

  // account_activity_v3 renders one amount against one asset, and its swap
  // convention is the amount RECEIVED valued at assetOut. An LBP buy's `amount` is
  // what was PAID, so reading it here prices the input leg's integer at the output
  // asset — the unbounded error, since the two assets rarely share decimals.
  it('renders the received side against assetOut in account_activity_v3_mv', () => {
    const sql = mvStatement('account_activity_v3_mv')
    const rawAmount = expressionFor(sql, 'raw_amount')
    for (const event of LEGACY_EVENTS) {
      expect(chainArg(rawAmount, event), `account_activity_v3_mv raw_amount for ${event}`).toBe(RECEIVED[event])
    }
    expect(expressionFor(sql, 'asset_id')).toContain(`'LBP.BuyExecuted')), JSONExtractInt(args_json, 'assetOut')`)
  })

  it('reads the same orientation in the trade-detail helper', () => {
    for (const event of LEGACY_EVENTS) {
      const args = { amount: 'A', salePrice: 'S', buyPrice: 'B' }
      const amounts = swapEventAmounts(event, { assetIn: 1, assetOut: 2, ...args })
      expect(amounts.amountIn, `${event} in`).toBe(args[PAID[event] as keyof typeof args])
      expect(amounts.amountOut, `${event} out`).toBe(args[RECEIVED[event] as keyof typeof args])
    }
  })

  it('reads the same orientation in the queue seed catch-up', () => {
    for (const event of LEGACY_EVENTS) {
      expect(chainArg(QUEUE_AMOUNT_IN_SQL, event), `queue seed in for ${event}`).toBe(PAID[event])
      expect(chainArg(QUEUE_AMOUNT_OUT_SQL, event), `queue seed out for ${event}`).toBe(RECEIVED[event])
    }
  })

  // The watermark view only maxes ingest/block/timestamp over the same rows, so it
  // carries no amount to orient. Pinned so a later edit that adds one is forced
  // through this file rather than inheriting a folded arm by copy.
  it('nets no amounts in the swap watermark view', () => {
    const sql = mvStatement('swap_source_partition_watermarks_mv')
    for (const arg of ['buyPrice', 'salePrice', 'amountIn', 'amountOut']) expect(sql, arg).not.toContain(arg)
  })
})
