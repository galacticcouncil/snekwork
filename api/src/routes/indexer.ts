import type { FastifyInstance } from 'fastify'
import type { ClickHouseClient } from '../db/client.ts'
import { SUBSTRATE_RPC_URL } from '../services/substrateRpc.ts'
import { createChainHeadSampler } from '../services/chainHeadSampler.ts'

interface IndexerStatus {
  blockHeight: number
  blockTimestamp: string
  lagSeconds: number
  chainBlockHeight: number
  blocksBehindHead: number
  // false when the chain-head RPC sample is unavailable: chainBlockHeight then
  // falls back to the raw pipeline's own head, so "behind by 0" means "not behind
  // raw ingestion", not "in sync with the chain". A liveness indicator has to know
  // the difference — both pipelines stall together.
  chainHeadSampled: boolean
  /** age of the chain-head sample in seconds; null when there has never been one */
  chainHeadSampleAgeSeconds: number | null
  rawFinalizedRangeCount: number
  rawFinalizedFromBlock: number
  rawFinalizedToBlock: number
}

const TTL_MS = 5_000
const CHAIN_HEAD_REFRESH_MS = 5_000
// Hard ceiling on one refresh attempt. `fetch` carries its own AbortSignal, but a
// call that never settles at all (DNS, a wedged connection pool) would leave the
// re-entrancy guard held forever: observed 2026-08-31, when one non-settling
// refresh froze chainBlockHeight for 47h while every other timer in the process
// kept ticking and /indexer went on reporting `blocksBehindHead: 0`.
const CHAIN_HEAD_TIMEOUT_MS = 10_000
// Beyond this a sample is not evidence of anything; report it as unsampled rather
// than let a stale head masquerade as a fresh one.
const CHAIN_HEAD_STALE_MS = 60_000

function uintValue(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

async function fetchChainBlockHeight(): Promise<number | null> {
  // The node the rest of the api already reads chain state from; the public
  // endpoint is a last resort and is not reachable from inside the compose network.
  const rpcUrl = process.env.CHAIN_RPC_URL?.trim() || process.env.RPC_URL?.trim() || SUBSTRATE_RPC_URL
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'chain_getHeader', params: [] }),
      signal: AbortSignal.timeout(3_000),
    })
    if (!response.ok) return null
    const json = await response.json() as { result?: { number?: unknown } }
    const encoded = json.result?.number
    if (typeof encoded !== 'string' || !/^0x[0-9a-f]+$/i.test(encoded)) return null
    const height = Number.parseInt(encoded.slice(2), 16)
    return Number.isSafeInteger(height) && height > 0 ? height : null
  } catch {
    return null
  }
}

export async function indexerRoutes(fastify: FastifyInstance, opts: { client: ClickHouseClient }) {
  let cache: { data: IndexerStatus; fetchedAt: number } | null = null
  let inflight: Promise<IndexerStatus> | null = null
  const sampler = createChainHeadSampler({
    fetchHeight: fetchChainBlockHeight,
    timeoutMs: CHAIN_HEAD_TIMEOUT_MS,
    staleMs: CHAIN_HEAD_STALE_MS,
  })

  // Chain RPC is sampled at startup and on a bounded background interval. HTTP
  // requests only read this snapshot and ClickHouse-backed status.
  await sampler.refresh()
  const chainHeadTimer = setInterval(() => { void sampler.refresh() }, CHAIN_HEAD_REFRESH_MS)
  chainHeadTimer.unref()
  fastify.addHook('onClose', async () => { clearInterval(chainHeadTimer) })

  fastify.get('/indexer', async () => {
    if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache.data
    if (inflight) return inflight

    // height is null once the sample goes stale, so a stale head cannot pass for fresh
    const { height, ageMs } = sampler.current()
    const request = loadIndexerStatus(opts.client, height, ageMs).then(data => {
      cache = { data, fetchedAt: Date.now() }
      return data
    }).finally(() => {
      if (inflight === request) inflight = null
    })
    inflight = request
    return request
  })
}

async function loadIndexerStatus(
  client: ClickHouseClient,
  sampledChainBlockHeight: number | null,
  chainHeadSampleAgeMs: number | null = null,
): Promise<IndexerStatus> {
  // Main indexer head, raw worker head, and finalized raw coverage come from
  // ClickHouse. If the background chain-head sample is unavailable, use the raw
  // checkpoint so the endpoint remains explicit about indexed status.
  const [mainRes, rawRes, rawCoverageRes] = await Promise.all([
    client.query({
      query: `
          SELECT
            toUInt64(max(block_height)) AS block_height,
            toString(max(block_timestamp)) AS block_timestamp
          FROM price_data.blocks
        `,
      format: 'JSONEachRow',
    }),
    client.query({
      query: `
          SELECT toUInt64(max(last_block)) AS block_height
          FROM price_data.raw_ingestion_state FINAL
        `,
      format: 'JSONEachRow',
    }),
    client.query({
      query: `
          WITH
            ordered AS (
              SELECT
                from_block,
                to_block,
                max(to_block) OVER (
                  ORDER BY from_block ASC, to_block ASC
                  ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                ) AS prev_max_to
              FROM price_data.raw_ingestion_ranges FINAL
              WHERE status = 'completed'
            ),
            marked AS (
              SELECT
                from_block,
                to_block,
                if(prev_max_to = 0 OR from_block > prev_max_to + 1, 1, 0) AS starts_new
              FROM ordered
            ),
            grouped AS (
              SELECT
                from_block,
                to_block,
                sum(starts_new) OVER (
                  ORDER BY from_block ASC, to_block ASC
                  ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                ) AS island
              FROM marked
            ),
            islands AS (
              SELECT
                island,
                min(from_block) AS from_block,
                max(to_block) AS to_block,
                count() AS range_count
              FROM grouped
              GROUP BY island
            )
          SELECT
            toUInt64(range_count) AS range_count,
            toUInt64(from_block) AS from_block,
            toUInt64(to_block) AS to_block
          FROM islands
          ORDER BY to_block DESC
          LIMIT 1
        `,
      format: 'JSONEachRow',
    }),
  ])
  const mainRows = await mainRes.json<{ block_height: string; block_timestamp: string }>()
  const rawRows = await rawRes.json<{ block_height: string }>()
  const rawCoverageRows = await rawCoverageRes.json<{
    range_count: string
    from_block: string
    to_block: string
  }>()
  const main = mainRows[0]
  const raw = rawRows[0]
  const rawCoverage = rawCoverageRows[0]
  const blockTs = main?.block_timestamp ?? ''
  const blockHeight = uintValue(main?.block_height)
  const rawBlockHeight = uintValue(raw?.block_height)
  const chainBlockHeight = sampledChainBlockHeight ?? Math.max(rawBlockHeight, blockHeight)
  const blockTimeMs = blockTs ? Date.parse(`${blockTs.replace(' ', 'T')}Z`) : Number.NaN
  const lagSeconds = Number.isFinite(blockTimeMs)
    ? Math.max(0, Math.floor((Date.now() - blockTimeMs) / 1000))
    : 0
  const data: IndexerStatus = {
    blockHeight,
    blockTimestamp: blockTs,
    lagSeconds,
    chainBlockHeight,
    blocksBehindHead: Math.max(0, chainBlockHeight - blockHeight),
    chainHeadSampled: sampledChainBlockHeight != null,
    chainHeadSampleAgeSeconds: chainHeadSampleAgeMs == null
      ? null
      : Math.max(0, Math.floor(chainHeadSampleAgeMs / 1000)),
    rawFinalizedRangeCount: uintValue(rawCoverage?.range_count),
    rawFinalizedFromBlock: uintValue(rawCoverage?.from_block),
    rawFinalizedToBlock: uintValue(rawCoverage?.to_block),
  }
  return data
}
