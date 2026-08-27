// Idempotent, range-aware recompute jobs for the read models that a plain
// materialized view cannot express (they need cross-row netting, joins,
// valuation or a stateful lifecycle walk). The runner (derivations/runner.ts)
// calls each every cycle; every function here is safe to call repeatedly.
//
//   - account_trade_volume               partition-diff incremental (no tracking table)
//   - xyk_farm_principal_intervals       bounded full recompute, atomic staging swap
//   - xyk_lp_total_shares_history        bounded full recompute, atomic staging swap
//
// The two reconstructions write their full result into a `<table>_staging` twin
// and EXCHANGE it with the live table (see atomicFullReplace below) — the live
// table is always exactly the latest full run, with no stale rows left behind by
// a shifted ReplacingMergeTree key and no unbounded run_id growth.
// account_trade_volume rebuilds stale month-partitions in its own `_staging`
// twin and publishes each via atomic REPLACE PARTITION. Both the live tables and
// their staging twins are declared in clickhouse/schema (001_tables.sql) —
// nothing here creates a table.

import type { ClickHouseClient } from '../db/client.ts'
import { buildPartitionInsertSql } from '../services/accountTradeVolume.ts'
import { allExplorerAssets } from '../services/explorerAssets.ts'
import {
  buildXykFarmIntervals,
  type XykFarmLifecycleEvent,
  type XykFarmLifecycleKind,
} from '../services/xykFarmIntervals.ts'

export interface DerivationResult {
  model: string
  rows: number
}

// ───────────────────── staging publication guard ─────────────────────
// Every publication below TRUNCATEs its staging twin, fills it, then swaps it
// into place. Two processes doing that to the same twin corrupt each other: the
// second TRUNCATE wipes the first one's half-written rows, and the first swap
// then publishes a truncated read model with no error anywhere. The derivations
// container is a singleton, but a manual `DERIVATIONS_ONESHOT=1` run alongside it
// races exactly this way.
//
// ClickHouse has no advisory lock, so detect the overlap: any in-flight
// non-SELECT query naming this twin means another publication is already under
// way. Skipping costs one poll interval, and the next cycle republishes. This
// narrows rather than closes the check-then-truncate window — it turns the likely
// operator mistake into a skipped cycle instead of silently wrong data. The
// query_kind filter is what keeps this probe from matching itself.
export function stagingBusySql(): string {
  return `SELECT count() AS n FROM system.processes
          WHERE query_kind != 'Select' AND position(query, {staging:String}) > 0`
}

async function stagingBusy(client: ClickHouseClient, stagingTable: string): Promise<boolean> {
  const res = await client.query({
    query: stagingBusySql(),
    query_params: { staging: stagingTable },
    format: 'JSONEachRow',
  })
  return Number((await res.json<{ n: string }>())[0]?.n ?? 0) > 0
}

// ───────────────────── atomic full-replace helper ─────────────────────
// The reconstruction jobs below (xyk farm
// intervals, xyk total shares) each recompute their whole read model from
// scratch every run. They used to append rows with a fresh run_id, relying on
// ReplacingMergeTree(run_id) + FINAL to collapse old rows on their stable
// business key. That breaks under out-of-order backward backfill: a corrected
// event can shift a row's `valid_from_block`/`valid_from_event`, which is part
// of the ORDER BY key, so the new row lands at a *different* key than the old
// one — FINAL has no key collision to collapse, and the stale row lingers
// forever (plus run_id rows accumulate without bound).
//
// Instead, write the full recompute into a `<table>_staging` twin (declared next
// to its parent in clickhouse/schema — 001_tables.sql for these three,
// 006_public.sql for pool_swap_hourly) and EXCHANGE it with the
// live table — a single atomic rename swap with no reader-visible gap. The live
// table is then always exactly the latest full run: no stale keys, no unbounded
// run_id growth. Truncate staging both before writing (clean slate if a prior
// run crashed mid-way) and after the swap (drop the now-superseded old data
// promptly rather than let it double the table's disk footprint until the next
// run).
async function atomicFullReplace(
  client: ClickHouseClient,
  liveTable: string,
  write: (stagingTable: string) => Promise<void>,
): Promise<void> {
  const stagingTable = `${liveTable}_staging`
  if (await stagingBusy(client, stagingTable)) {
    console.log(`[derivations] ${liveTable} skipped: ${stagingTable} busy in another process`)
    return
  }
  await client.command({ query: `TRUNCATE TABLE ${stagingTable}` })
  await write(stagingTable)
  await client.command({ query: `EXCHANGE TABLES ${liveTable} AND ${stagingTable}` })
  await client.command({ query: `TRUNCATE TABLE ${stagingTable}` })
}

// ───────────────────────── account_trade_volume ─────────────────────────
// Per-account NET trade volume: routed/DCA trades collapsed to their net
// input/output so intermediate routing hops are not double-counted. The netting
// is a per-trade cross-row aggregation with a block-time ohlc valuation, so it
// cannot be a plain per-row MV. Whole CH month-partitions are rebuilt in a
// staging twin and published atomically (REPLACE PARTITION), so re-runs are
// idempotent and readers never observe a missing month. The netting/valuation
// SQL and the swap-row filter live in services/accountTradeVolume.ts (single
// source of truth, imported above) — this module only decides which partitions
// to rebuild and how they are published.

// Ingest-time incremental partition selection, gated on price coverage.
//
// A DISTINCT-block / row COUNT comparison is wrong here: derived rows are a
// filtered SUBSET of source blocks — the netting SELECT drops unpriced, net-zero
// (HAVING volume_usd > 0) and non-64hex-account swaps — so a partition's source
// block count is (almost) always > its derived block count. Counts therefore
// never match and every partition would rebuild every cycle.
//
// Instead we compare ingest-time watermarks. A month-partition is a rebuild
// candidate when:
//   - it has NO derived rows yet (LEFT JOIN miss), OR
//   - the newest raw swap row (max ingested_at) is newer than the newest derived
//     row (max computed_at) in that partition.
// This is subset-safe (watermarks don't depend on which rows survive the filter)
// and correct under out-of-order backward backfill: freshly backfilled raw rows
// carry a newer ingested_at than the partition's derived computed_at, re-triggering
// it; steady-state partitions (no new/rewritten raw) have max ingested_at <=
// max computed_at and are skipped.
//
// Price-coverage gate: the valuation depends on ohlc prices, which the main
// (price) pipeline writes on its own schedule — behind raw on a fresh database
// and during backward backfill. Computing a partition before its prices exist
// would bake in dropped (unpriced → HAVING) trades, and no later signal would
// re-mark it stale. So a candidate is only returned once the priced range
// covers it: min(blocks) at-or-below the partition's first block AND max(blocks)
// at-or-past the partition's last source swap block. Price backfill descends
// contiguously (supervisor), so coverage is monotone and each partition
// computes exactly once it is priceable — and an empty blocks table (brand-new
// DB) yields no candidates at all.
//
// The source watermarks come from price_data.swap_source_partition_watermarks
// (clickhouse/schema), an MV over the same swap-row filter. Asking raw_events
// directly meant a full-table aggregate every cycle: the derived partition key
// is toYYYYMM(toDateTime(block_height * 12)) — a synthetic block-space clock, not
// the chain's block time, identical at all five sites and not to be re-pinned at a
// block-time change (see clickhouse/schema/001_tables.sql above
// account_trade_volume) — which ClickHouse cannot invert into a primary-key range, and raw_events is partitioned on real
// block_timestamp, so neither form of pruning applied. max() is idempotent under
// replay, so the MV holds the same watermarks in ~50 rows. Dropping raw rows
// would leave a watermark high rather than low, which re-marks a partition stale
// rather than hiding staleness.
export function stalePartitionsSql(): string {
  return `
    SELECT toString(src.p) AS p, toString(src.src_ingest) AS src_ingest, toString(src.src_max_ts) AS src_max_ts
    FROM (
      SELECT p,
             max(src_ingest) AS src_ingest,
             max(src_maxb) AS src_maxb,
             max(src_max_ts) AS src_max_ts
      FROM price_data.swap_source_partition_watermarks
      GROUP BY p
    ) AS src
    LEFT JOIN (
      -- Synthetic block-space partition clock (the 12 is not the chain's block
      -- time); this expression and the intDiv(..., 12) inverse below must stay in
      -- step with account_trade_volume's PARTITION BY.
      SELECT toYYYYMM(toDateTime(block_height * 12)) AS p, max(computed_at) AS der_computed
      FROM price_data.account_trade_volume
      GROUP BY p
    ) AS der ON src.p = der.p
    CROSS JOIN (
      SELECT min(block_height) AS priced_from, max(block_height) AS priced_to
      FROM price_data.blocks
    ) AS pc
    -- ClickHouse LEFT JOINs use type defaults unless join_use_nulls=1; this
    -- client deliberately leaves the default in place. A missing DateTime is
    -- therefore epoch, not NULL. Testing IS NULL here silently skipped every
    -- source partition that had never produced a derived row.
    WHERE (der.der_computed = toDateTime(0) OR src.src_ingest > der.der_computed)
      AND pc.priced_from <= intDiv(toUnixTimestamp(parseDateTimeBestEffort(concat(toString(src.p), '01'))), 12)
      AND pc.priced_to >= src.src_maxb
    ORDER BY src.p`
}

// A partition whose valuation legitimately nets to nothing writes zero rows, so
// the derived side never gets a computed_at and the LEFT JOIN miss marks it stale
// forever — three early synthetic partitions were rebuilt on every cycle despite
// writing nothing. Remember the source watermark each rebuild consumed
// (in memory, not a completion-marker table) and skip a candidate whose source has
// not advanced since. A restart costs one extra pass per such partition, not one
// per cycle; a backfilled row raises src_ingest and re-marks it stale, so this
// stays correct under backward backfill.
const rebuiltSourceWatermark = new Map<string, string>()

export function resetRebuiltSourceWatermarkForTest(): void {
  rebuiltSourceWatermark.clear()
}

// Candidates whose source actually moved since the last rebuild this process did.
export function partitionsNeedingRebuild(
  candidates: { p: string; src_ingest: string }[],
  lastRebuilt: ReadonlyMap<string, string>,
): string[] {
  return candidates.filter(c => lastRebuilt.get(c.p) !== c.src_ingest).map(c => c.p)
}

interface StalePartition { p: string; src_ingest: string; src_max_ts: string }

// src is ORDER BY p ascending → rebuild oldest partition first.
async function stalePartitions(client: ClickHouseClient): Promise<StalePartition[]> {
  const res = await client.query({ query: stalePartitionsSql(), format: 'JSONEachRow' })
  return res.json<StalePartition>()
}

// Recompute only the partitions whose source/derived coverage diverges. The
// netting SQL bakes in per-asset decimal factors and the price-alias universe,
// so an empty registry (fresh DB before assets are indexed, or a failed
// loadExplorerAssets — the runner also skips this job on load failure) must
// not bake wrongly-valued partitions: bail out instead.
//
// Publication is atomic per partition: the rebuild lands in the `_staging`
// twin first, then REPLACE PARTITION swaps it into the live table in one
// operation — readers see the old partition until the swap, never a gap
// (the old DROP PARTITION + INSERT exposed an empty month mid-rebuild).
export async function runAccountTradeVolume(client: ClickHouseClient): Promise<DerivationResult> {
  const model = 'account_trade_volume'
  if (!allExplorerAssets().length) {
    console.log('[derivations] account_trade_volume skipped: asset registry empty')
    return { model, rows: 0 }
  }
  const live = 'price_data.account_trade_volume'
  const staging = `${live}_staging`
  const candidates = await stalePartitions(client)
  const stale = partitionsNeedingRebuild(candidates, rebuiltSourceWatermark)
  if (!stale.length) return { model, rows: 0 }
  if (await stagingBusy(client, staging)) {
    console.log(`[derivations] ${model} skipped: ${staging} busy in another process`)
    return { model, rows: 0 }
  }
  const ingestByPartition = new Map(candidates.map(c => [c.p, c.src_ingest]))
  // The partition's last swap block time, straight off the watermark projection.
  // It bounds the valuation's ohlc right side from above — see
  // buildPartitionInsertSql.
  const maxBlockTimeByPartition = new Map(candidates.map(c => [c.p, c.src_max_ts]))
  for (const p of stale) {
    // Clean slate in staging for this partition (a prior crashed run may have
    // left rows); DROP PARTITION on an absent partition is a no-op.
    await client.command({ query: `ALTER TABLE ${staging} DROP PARTITION ${p}` })
    await client.command({ query: buildPartitionInsertSql(p, staging, maxBlockTimeByPartition.get(p)) })
    await client.command({ query: `ALTER TABLE ${live} REPLACE PARTITION ${p} FROM ${staging}` })
    await client.command({ query: `ALTER TABLE ${staging} DROP PARTITION ${p}` })
    // Only after the swap succeeded: a failed rebuild must stay a candidate.
    const consumed = ingestByPartition.get(p)
    if (consumed != null) rebuiltSourceWatermark.set(p, consumed)
  }
  const res = await client.query({
    // Synthetic block-space partition clock, same constant as the PARTITION BY.
    query: `SELECT count() AS n FROM price_data.account_trade_volume
            WHERE toYYYYMM(toDateTime(block_height * 12)) IN (${stale.join(',')})`,
    format: 'JSONEachRow',
  })
  return { model, rows: Number((await res.json<{ n: string }>())[0]?.n ?? 0) }
}

// ───────────────────────── lp_lifecycle_events ─────────────────────────
// The reconstruction below needs a handful of decoded fields from the XYK NFT +
// liquidity-mining lifecycle. That is a pure row-wise filter and decode, so it
// belongs in a materialized view rather than in a job —
// price_data.lp_lifecycle_events (clickhouse/schema) does the JSONExtract calls
// once at insert time. The job re-applies its own predicate against the decoded
// `collection` column. FINAL deduplicates a replayed range on the projection's
// (block_height, event_index) replacement key.
const LP_LIFECYCLE_SOURCE = 'price_data.lp_lifecycle_events FINAL'

// ─────────────────── xyk_farm_principal_intervals ───────────────────
// Bounded full recompute of the XYK farm deposits via the pure
// buildXykFarmIntervals domain function; result is swapped into the live
// table atomically (see atomicFullReplace).

// The Uniques collection the XYK liquidity-mining pallet mints its deposit NFTs
// into, from the runtime constant `xykLiquidityMining.nftCollectionId`. The only
// place the API layer names it; lp_lifecycle_events_mv carries the matching
// literal on the schema side (clickhouse/schema/003_materialized_views.sql), and
// the test below holds the two together.
export const XYK_FARM_NFT_COLLECTION_ID = '1'

export const XYK_FARM_EVENT_KIND: Record<string, XykFarmLifecycleKind> = {
  'Uniques.Issued': 'nft_issue',
  'Uniques.Transferred': 'nft_transfer',
  'Uniques.Burned': 'nft_burn',
  'XYKLiquidityMining.SharesDeposited': 'shares_deposited',
  'XYKLiquidityMining.SharesRedeposited': 'shares_redeposited',
  'XYKLiquidityMining.DepositDestroyed': 'deposit_destroyed',
}

interface XykFarmRawRow {
  block: number
  extrinsic: number | null
  event: number
  ts: number
  event_name: string
  item: string
  depositId: string
  owner: string
  from: string
  to: string
  lpToken: number
  amount: string
}

interface XykFarmIntervalRow {
  account_id: string
  deposit_id: string
  lp_asset_id: number
  principal_shares_raw: string
  valid_from_block: number
  valid_from_extrinsic: number
  valid_from_event: number
  valid_from_ts: number
  valid_to_block: number
  valid_to_extrinsic: number
  valid_to_event: number
  source_event_kind: string
  run_id: number
}

// The XYK-farm half of lp_lifecycle_events.
export function xykFarmLifecycleSelectSql(): string {
  return `
      SELECT block_height AS block, extrinsic_index AS extrinsic, event_index AS event,
        toUInt32(toUnixTimestamp(block_timestamp)) AS ts, event_name,
        item, deposit_id AS depositId,
        owner, from_account AS from, to_account AS to,
        lp_token AS lpToken, amount
      FROM ${LP_LIFECYCLE_SOURCE}
      WHERE (event_name IN ('Uniques.Issued','Uniques.Transferred','Uniques.Burned') AND collection='${XYK_FARM_NFT_COLLECTION_ID}')
         OR event_name IN ('XYKLiquidityMining.SharesDeposited','XYKLiquidityMining.SharesRedeposited','XYKLiquidityMining.DepositDestroyed')
      ORDER BY block_height, event_index`
}

export async function runXykFarmIntervals(client: ClickHouseClient): Promise<DerivationResult> {
  const runId = Date.now()
  const res = await client.query({ query: xykFarmLifecycleSelectSql(), format: 'JSONEachRow' })
  const rows = await res.json<XykFarmRawRow>()

  const events: XykFarmLifecycleEvent[] = rows.map(r => ({
    kind: XYK_FARM_EVENT_KIND[r.event_name],
    depositId: (r.event_name.startsWith('Uniques.') ? r.item : r.depositId) || '',
    owner: r.owner || undefined,
    from: r.from || undefined,
    to: r.to || undefined,
    lpAssetId: r.event_name.startsWith('XYKLiquidityMining.Shares') ? r.lpToken : undefined,
    principalShares: r.event_name.startsWith('XYKLiquidityMining.Shares') ? r.amount : undefined,
    block: r.block,
    extrinsic: r.extrinsic ?? null,
    event: r.event,
    ts: r.ts,
  }))

  const intervals = buildXykFarmIntervals(events)
  const intervalRows: XykFarmIntervalRow[] = intervals.map(iv => ({
    account_id: iv.accountId,
    deposit_id: iv.depositId,
    lp_asset_id: iv.lpAssetId,
    principal_shares_raw: iv.principalShares,
    valid_from_block: iv.validFrom.block,
    valid_from_extrinsic: iv.validFrom.extrinsic ?? -1,
    valid_from_event: iv.validFrom.event,
    valid_from_ts: iv.validFrom.ts,
    valid_to_block: iv.validTo?.block ?? 0,
    valid_to_extrinsic: iv.validTo ? (iv.validTo.extrinsic ?? -1) : 0,
    valid_to_event: iv.validTo?.event ?? 0,
    source_event_kind: iv.sourceEventKind,
    run_id: runId,
  }))

  await atomicFullReplace(client, 'price_data.xyk_farm_principal_intervals', async stagingTable => {
    const BATCH = 50_000
    for (let i = 0; i < intervalRows.length; i += BATCH) {
      await client.insert({
        table: stagingTable,
        values: intervalRows.slice(i, i + BATCH),
        format: 'JSONEachRow',
      })
    }
  })
  return { model: 'xyk_farm_intervals', rows: intervalRows.length }
}

// ─────────────────── xyk_lp_total_shares_history ───────────────────
// Reconstructs the total outstanding supply of each XYK LP (shareToken) as a step
// function over block height, from raw_balance_observations (approach A, no RPC):
// token issuance == sum of all holder balances, and substrate Tokens balances are
// captured from genesis, so cumulative net balance deltas reproduce issuance
// exactly. XYK.LiquidityAdded omits the minted-share amount, so events alone
// cannot do this. The result is swapped into the live table atomically (see
// atomicFullReplace) rather than appended per (lp_asset_id, block).

// Single source of truth for the live table name: runXykTotalShares passes
// this to atomicFullReplace as `liveTable`, and xykTotalSharesInsertSql derives
// its staging INSERT target from the same constant. Keeping these structurally
// tied (rather than two hand-matched literals) means a future rename can't
// silently orphan the INSERT from the table atomicFullReplace actually swaps.
const XYK_TOTAL_SHARES_TABLE = 'price_data.xyk_lp_total_shares_history'

// The pool set. price_data.xyk_pool_registry is the MV over XYK.PoolCreated and
// decodes shareToken with the same expression this used to run inline, so the two
// sets are equal by construction — but the registry is 729 rows against a 302M-row
// raw_events scan the event-name index barely prunes.
const XYK_SHARE_TOKENS_SQL = 'SELECT DISTINCT lp_asset_id AS lp FROM price_data.xyk_pool_registry FINAL'

// The single INSERT…SELECT for the total-shares reconstruction, keyed by run id.
// Targets the staging twin (never the live table directly) so the run's
// result becomes visible only via the atomic EXCHANGE in runXykTotalShares.
// Exported so its shape can be unit-tested without a live ClickHouse.
export function xykTotalSharesInsertSql(runId: number): string {
  const stepSelect = `
      WITH lps AS (
        ${XYK_SHARE_TOKENS_SQL}
      ),
      row_deltas AS (
        SELECT asset_id AS lp, block_height,
          toInt256(assumeNotNull(total)) - lagInFrame(toInt256(assumeNotNull(total)), 1, toInt256(0))
            OVER (PARTITION BY asset_id, account_id ORDER BY block_height, observation_id) AS delta
        FROM price_data.xyk_lp_share_observations FINAL
        WHERE asset_id IN (SELECT lp FROM lps)
      ),
      per_block AS (SELECT lp, block_height, sum(delta) AS bd FROM row_deltas GROUP BY lp, block_height)
      SELECT lp AS lp_asset_id, block_height,
        toString(sum(bd) OVER (PARTITION BY lp ORDER BY block_height ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)) AS total_shares_raw
      FROM per_block`
  return `INSERT INTO ${XYK_TOTAL_SHARES_TABLE}_staging
        SELECT lp_asset_id, block_height, total_shares_raw, ${runId} AS run_id, now() AS ingested_at
        FROM (${stepSelect})`
}

export async function runXykTotalShares(client: ClickHouseClient): Promise<DerivationResult> {
  const runId = Date.now()
  const liveTable = XYK_TOTAL_SHARES_TABLE
  // No memory carve-out: windowing 1.2M projected rows in their stored order
  // fits the long-op client's default cap, where the 244M-row scan and sort this
  // replaced needed 8 GB.
  await atomicFullReplace(client, liveTable, async () => {
    await client.command({ query: xykTotalSharesInsertSql(runId) })
  })
  const res = await client.query({
    query: `SELECT count() AS n FROM ${liveTable} WHERE run_id = ${runId}`,
    format: 'JSONEachRow',
  })
  return { model: 'xyk_total_shares', rows: Number((await res.json<{ n: string }>())[0]?.n ?? 0) }
}
