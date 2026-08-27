import Fastify from 'fastify'
import cors from '@fastify/cors'
import compress from '@fastify/compress'
import { config } from './config.ts'
import { createClickHouseClient, createLongOpClickHouseClient } from './db/client.ts'
import {
  drainAccountSwapActivityQueue,
  seedAccountSwapActivityQueue,
  startAccountSwapActivityQueueDrain,
  stopAccountSwapActivityQueueDrain,
} from './db/accountSwapQueue.ts'
import { loadAssets, stopAssetsRefresh } from './services/assetsService.ts'
import { assetsRoutes } from './routes/assets.ts'
import { indexerRoutes } from './routes/indexer.ts'
import { explorerRoutes } from './routes/explorer.ts'
import { poolsRoutes } from './routes/pools.ts'
import { liveRoutes } from './routes/live.ts'
import { initLiveHeadService, stopLiveHeadService } from './services/liveHeadService.ts'
import { startNodeApi, stopNodeApi } from './services/nodeApi.ts'
import { tagRoutes } from './routes/tags.ts'
import { loadExplorerAssets, stopExplorerAssetsRefresh } from './services/explorerAssets.ts'
import { loadRuntimeErrorNames, stopRuntimeErrorNamesRefresh } from './services/runtimeErrorNames.ts'
import {
  initExplorerService,
  loadAccountSuffixIndex,
  startAccountSuffixRefresh,
  startAccountsPrewarm,
  startActivityLeaderboardRefresh,
  startTagCountsPrewarm,
  stopExplorerBackgroundTasks,
} from './services/explorerService.ts'
import { initTagService, loadTags, seedDefaultTags, syncStructuralTags, startStructuralTagRefresh, reconcileTagPresentation, retireUnknownTagMemberships } from './services/tagService.ts'
import { initIdentityService, loadIdentities, startIdentityRefresh, stopIdentityRefresh } from './services/identityService.ts'
import { initGovernanceService } from './services/governanceService.ts'
import {
  initReferendumTitleService,
  loadReferendumTitles,
  startReferendumTitleRefresh,
  stopReferendumTitleRefresh,
} from './services/referendumTitleService.ts'
import { initProxyMultisigService } from './services/proxyMultisigService.ts'
import { initLockBreakdownService } from './services/lockBreakdownService.ts'
import { initPoolService } from './services/poolService.ts'
import { startBackgroundRefresh, stopBackgroundRefresh } from './services/backgroundRefresh.ts'
import { initAccountAffinityService } from './services/accountAffinityService.ts'

const fastify = Fastify({ logger: true })

const client = createClickHouseClient()

// All routes are anonymous reads. A fixed wildcard avoids reflecting arbitrary
// origins (and the resulting Vary: Origin fragmentation in shared caches).
await fastify.register(cors, { origin: '*' })
// JSON payloads (history series, activities, holders) shrink ~10× under gzip —
// directly cuts transfer time for every concurrent client.
await fastify.register(compress, { global: true, encodings: ['br', 'gzip', 'deflate'] })

// Public, short-lived HTTP caching aligned with each endpoint's internal
// single-flight TTL, so browsers (and any fronting proxy/CDN) can reuse
// responses instead of re-hitting the API. Longest-prefix match wins.
const CACHE_CONTROL: [RegExp, number][] = [
  [/^\/assets$/, 300],
  // The Live surfaces poll on the chain's block cadence and their server caches
  // are invalidated per ingested block (head-keyed keys), so a 5s browser cache
  // would be the freshness bottleneck. 2s only matters for rapid tab switches —
  // consecutive polls at today's cadence never hit it either way.
  [/^\/explorer\/(stats|blocks|extrinsics|events|activity)$/, 2],
  [/^\/explorer\/address\/[^/]+\/close-accounts/, 900],
  [/^\/explorer\/address\/[^/]+\/history/, 120],
  [/^\/explorer\/(address|tag)\/[^/]+\/counts/, 600],
  [/^\/explorer\/(daily|accounts-daily)/, 300],
  [/^\/explorer\/(address|tag)\//, 8],
  [/^\/explorer\/search/, 10],
  // `assets` (no trailing slash) is the asset directory — 30s in-process TTL, so
  // let clients reuse it just as long. Without this it fell through to the 2s
  // catch-all and browsers re-fetched the biggest list payload constantly.
  [/^\/explorer\/assets/, 30],
  // The call/event name catalogue: an hour, matching its in-process TTL. The
  // list changes only when a runtime upgrade adds or removes a name, and every
  // filter box on the site reads the same copy.
  [/^\/explorer\/filter-names$/, 3600],
  // Pool surfaces: current state refreshes every 30-60s server-side, the heavy
  // history models every 300s — match the shortest internal freshness window.
  [/^\/explorer\/pool\//, 30],
  [/^\/explorer\/asset\/\d+\/liquidity/, 60],
  [/^\/explorer\/(holders|asset)\//, 15],
  // Directory ranking is SWR-cached with a 60s freshness window server-side;
  // matching client reuse cuts request volume without adding staleness.
  // (accounts-daily is matched by its earlier rule.)
  [/^\/explorer\/accounts/, 30],
  [/^\/explorer\//, 5],
]
fastify.addHook('onSend', async (req, reply) => {
  if (req.method !== 'GET' || reply.statusCode !== 200 || reply.getHeader('cache-control')) return
  const path = req.url.split('?')[0]
  const rule = CACHE_CONTROL.find(([re]) => re.test(path))
  if (rule) reply.header('cache-control', `public, max-age=${rule[1]}`)
})

fastify.get('/health', async () => {
  return { status: 'ok' }
})

// Drain in-flight requests and close the ClickHouse keep-alive pool when Docker
// replaces the API container. This prevents half-open requests during deploys.
fastify.addHook('onClose', async () => {
  stopLiveHeadService()
  stopNodeApi()
  stopAssetsRefresh()
  stopExplorerAssetsRefresh()
  stopRuntimeErrorNamesRefresh()
  stopIdentityRefresh()
  stopReferendumTitleRefresh()
  stopBackgroundRefresh()
  stopAccountSwapActivityQueueDrain()
  stopExplorerBackgroundTasks()
  await client.close()
})

await fastify.register(assetsRoutes)
await fastify.register(indexerRoutes, { client })
await fastify.register(explorerRoutes)
await fastify.register(poolsRoutes)
await fastify.register(liveRoutes)
await fastify.register(tagRoutes)

async function start() {
  try {
    // Request-time on-behalf timestamp formatting (chTimestampString) and multisig
    // date-window bounds (msAnchorWindow), both in explorerService.ts, reproduce
    // ClickHouse's session-timezone semantics only when this server runs UTC.
    // Fail fast rather than silently desynchronizing on-behalf rows from
    // SQL-sourced rows if that configuration ever drifts.
    const tzRes = await client.query({ query: 'SELECT timezone() AS tz', format: 'JSONEachRow' })
    const [{ tz }] = await tzRes.json<{ tz: string }>()
    if (tz !== 'UTC') {
      fastify.log.error(
        `[API] ClickHouse session timezone is '${tz}', not 'UTC'. chTimestampString and msAnchorWindow in explorerService.ts assume UTC and would silently desynchronize on-behalf rows from SQL-sourced rows.`,
      )
      process.exit(1)
    }
    // The schema is created by the schema-bootstrap service before this process
    // starts (Compose depends_on: service_completed_successfully), so no schema
    // work runs here. Seed/drain the account-swap-activity queue on a long-op
    // client, off the public request client (20s timeout, 4 GB cap).
    const bootstrapClient = createLongOpClickHouseClient()
    try {
      await seedAccountSwapActivityQueue(bootstrapClient)
      await drainAccountSwapActivityQueue(bootstrapClient, { maxBatches: 100 })
    } finally {
      await bootstrapClient.close()
    }
    await loadAssets(client)
    initExplorerService(client)
    // The schema is declarative and every read model is correct-by-construction
    // (materialized views + the derivations runner), so services start
    // immediately against whatever raw has been ingested — there are no
    // readiness gates or historical backfills to wait on.
    initTagService(client)
    initIdentityService(client)
    initReferendumTitleService(client)
    initGovernanceService(client)
    initProxyMultisigService(client)
    initLockBreakdownService(client)
    initPoolService(client)
    initLiveHeadService(client)
    // The one shared node connection: runtime metadata constants and the live
    // referendum tally read through it. Everything degrades to the indexed data
    // when it is unavailable.
    startNodeApi()
    // The node-full refreshers share one coordinated scheduler so they never
    // stack concurrent RPC bursts on the archive node; started after their
    // clients are set.
    startBackgroundRefresh()
    initAccountAffinityService(client)
    await Promise.all([loadExplorerAssets(client), loadRuntimeErrorNames(client)])
    // Referendum titles come from SubSquare (the chain has none), so they are held
    // in memory like identities and read on every vote row the explorer renders.
    await Promise.all([loadTags(), loadIdentities(), loadReferendumTitles().catch(() => {})])
    // Seed the fixed default tag set on a fresh database (no-op once tags exist),
    // so a clean `docker compose up` reaches the expected state with no manual step.
    await seedDefaultTags()
    // Structural system-account tags (AMM pools, LM pots, sovereigns) derive
    // from indexed data — recreated automatically after a fresh reindex.
    await syncStructuralTags().catch(e => console.warn('[tags] structural sync failed', e))
    startStructuralTagRefresh()
    // Colors are code-canonical; push any code-side color edits onto already-seeded
    // rows (seed/sync never rewrite existing memberships). No-op when already in sync.
    await reconcileTagPresentation().catch(e => console.warn('[tags] presentation reconcile failed', e))
    await retireUnknownTagMemberships().catch(e => console.warn('[tags] retire reconcile failed', e))
    startIdentityRefresh()
    startReferendumTitleRefresh()
    // Account 3-letter-code search index — load in the background (a distinct-account
    // scan), don't block startup; refresh periodically.
    void loadAccountSuffixIndex().catch(() => {})
    startAccountSuffixRefresh()
    startAccountSwapActivityQueueDrain(client)
    await fastify.listen({ port: config.port, host: config.host })
    console.log(`[API] Server listening on ${config.host}:${config.port}`)
    // Prewarm the hottest account/tag reconstruction paths so the first real
    // request does not pay the cold-cache cost.
    startAccountsPrewarm()
    startTagCountsPrewarm()
    // The directory's activity ranking, on its own slow interval: it recounts a few
    // aged-out members per cycle rather than the whole pool per prewarm.
    startActivityLeaderboardRefresh()
  } catch (err) {
    fastify.log.error(err)
    await fastify.close().catch(async closeError => {
      fastify.log.error(closeError)
      await client.close().catch(() => {})
    })
    process.exit(1)
  }
}

let shuttingDown = false
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  fastify.log.info({ signal }, 'shutting down')
  try {
    await fastify.close()
  } catch (err) {
    fastify.log.error(err)
    process.exitCode = 1
  }
  process.exit(process.exitCode ?? 0)
}

process.once('SIGTERM', () => { void shutdown('SIGTERM') })
process.once('SIGINT', () => { void shutdown('SIGINT') })

void start()
