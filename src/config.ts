import {
  integerFromEnvironment,
  minutesFromEnvironment,
  stringFromEnvironment,
} from './util/env.js'
import { KSM_ASSET_ID } from './price/reference.js'

export interface Config {
  // RPC endpoint for live data and finalization checks
  RPC_URL: string
  RPC_RATE_LIMIT: number
  RPC_CAPACITY: number
  RPC_HEAD_POLL_MS: number

  // ClickHouse connection settings
  CLICKHOUSE_URL: string
  CLICKHOUSE_DB: string
  CLICKHOUSE_PASSWORD: string

  // Processing parameters
  BATCH_SIZE: number
  SNAPSHOT_INTERVAL_MINUTES: number
  RAW_FLUSH_BLOCKS: number
  RAW_FLUSH_INTERVAL_MS: number

  // The only assets that carry a USD price anywhere in this platform.
  PRICED_ASSET_IDS: number[]
  // Minimum bottleneck liquidity for a graph path to be used as a price observation.
  GRAPH_MIN_PATH_LIQUIDITY_USD: number

  // KSM/USD reference (src/price/reference.ts)
  KSM_REFERENCE_LIVE_WINDOW_HOURS: number
  KSM_REFERENCE_POLL_MS: number
  KSM_REFERENCE_COIN_ID: string
  KSM_REFERENCE_SYMBOL: string
  COINGECKO_API_URL: string
  BINANCE_API_URL: string
}

export const config: Config = {
  // Ingestion is RPC-only and always will be: SQD publishes no Basilisk archive,
  // so there is no gateway URL or API key to configure. The default is the public
  // Basilisk archive node, which serves state from genesis.
  RPC_URL: stringFromEnvironment('RPC_URL', 'https://rpc.basilisk.cloud'),
  RPC_RATE_LIMIT: integerFromEnvironment('RPC_RATE_LIMIT', 100), // requests per second
  RPC_CAPACITY: integerFromEnvironment('RPC_CAPACITY', 20), // max concurrent RPC requests
  // How often the SQD live follower polls the chain for a new head (the RPC
  // endpoints are HTTPS, so heads arrive by polling, not subscription). The
  // upstream default of 5000ms was the single largest controllable slice of
  // block-to-explorer latency; a chain_getHeader every 750ms is trivial load on
  // an RPC that runs on the same host (measured: 0 errors/retries in 6h at 2000ms,
  // and the poll does not appear in raw-live's cost at all — its per-block wall
  // time is ClickHouse insert round-trips).
  // 750ms rather than 2000ms because the poll interval has to stay well under a
  // block: at a 2s block time 2000ms is exactly one poll per block, so any jitter
  // costs a full block of lag and a missed poll is invisible. At 6s it oversampled
  // 3:1; 750ms keeps roughly that ratio at 2s and 8:1 today.
  RPC_HEAD_POLL_MS: integerFromEnvironment('RPC_HEAD_POLL_MS', 750),

  // ClickHouse connection
  CLICKHOUSE_URL: stringFromEnvironment('CLICKHOUSE_HOST', 'http://localhost:18123'),
  CLICKHOUSE_DB: 'price_data',
  CLICKHOUSE_PASSWORD: process.env.CLICKHOUSE_PASSWORD ?? '',

  // Processing tuning parameters
  BATCH_SIZE: integerFromEnvironment('BATCH_SIZE', 50_000), // rows per ClickHouse insert (tunable based on performance)
  // Chain time between full asset registry scans in live mode. Measured in the
  // blocks' own timestamps rather than a block count, so the scan rate is fixed
  // through a block-time change (100 min is what the previous SNAPSHOT_INTERVAL
  // of 1,000 blocks meant at 6 s; at 2 s that same count would have scanned every
  // ~33 min). The deprecated SNAPSHOT_INTERVAL is still read, at 6 s per block.
  SNAPSHOT_INTERVAL_MINUTES: minutesFromEnvironment('SNAPSHOT_INTERVAL_MINUTES', 100, { name: 'SNAPSHOT_INTERVAL' }),
  // Raw flush accumulation while behind chain head — see src/raw/flushPolicy.ts.
  // At head every batch still flushes immediately, so these only shape catch-up
  // and backfill, where the small-part churn actually accumulates.
  RAW_FLUSH_BLOCKS: integerFromEnvironment('RAW_FLUSH_BLOCKS', 10, { min: 1 }),
  RAW_FLUSH_INTERVAL_MS: integerFromEnvironment('RAW_FLUSH_INTERVAL_MS', 5_000, { min: 0 }),

  // Basilisk publishes exactly two USD prices, and nothing here is a placeholder
  // for a third. KSM (1) is the anchor — its price comes from the off-chain
  // reference table, not from a pool — and BSX (0) is derived from it through the
  // BSX/KSM XYK pool's reserve ratio. Every other asset is unpriced by design:
  // the book is quiet enough that its other venues do not carry an arbitraged
  // price, and the surfaces that read prices already render a missing one.
  //
  // The BSX/USDT pool is deliberately not an input. It currently implies roughly
  // 2.8x the BSX price the KSM pool does — the same un-arbitraged staleness that
  // disqualifies the rest of the book — so it is a cross-check, never a source.
  //
  // 0 is BSX, the native asset. Spelled as a literal rather than imported from
  // nativeAsset.ts, which reads this module and would form an import cycle.
  PRICED_ASSET_IDS: [0, KSM_ASSET_ID],
  // 0 (no gate) on purpose: any positive floor permanently unprices an asset
  // whose only venue sits below it, and the surfaces that read prices — account
  // valuations, asset charts — treat "no price" as "does not exist". The gate is
  // also not what protects deep assets: the weighted median prefers the deepest
  // path, so a dust pool can only ever price an asset with no deeper venue.
  GRAPH_MIN_PATH_LIQUIDITY_USD: integerFromEnvironment('GRAPH_MIN_PATH_LIQUIDITY_USD', 0, { min: 0 }),

  // How recent a block must be for the live intraday poll to value it; older
  // blocks read settled daily closes only, which is what makes a replay
  // reproducible. See KsmReferenceIndex.lookup for the full rule.
  KSM_REFERENCE_LIVE_WINDOW_HOURS: integerFromEnvironment('KSM_REFERENCE_LIVE_WINDOW_HOURS', 48, { min: 1 }),
  // Live poll cadence. The reference moves on market time, not block time, so
  // this is wall-clock; two minutes keeps the head's USD price current at ~720
  // requests/day against a public API with no key.
  KSM_REFERENCE_POLL_MS: integerFromEnvironment('KSM_REFERENCE_POLL_MS', 120_000, { min: 15_000 }),
  KSM_REFERENCE_COIN_ID: stringFromEnvironment('KSM_REFERENCE_COIN_ID', 'kusama'),
  KSM_REFERENCE_SYMBOL: stringFromEnvironment('KSM_REFERENCE_SYMBOL', 'KSMUSDT'),
  COINGECKO_API_URL: stringFromEnvironment('COINGECKO_API_URL', 'https://api.coingecko.com/api/v3'),
  BINANCE_API_URL: stringFromEnvironment('BINANCE_API_URL', 'https://api.binance.com'),
}
