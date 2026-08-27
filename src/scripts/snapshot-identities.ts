import type { RpcClient } from '@subsquid/rpc-client'
import { createClickHouseClient } from '../db/client.js'
import { config } from '../config.js'
import { hasFlag, integerOption, optionalIntegerOption } from '../util/cliArgs.js'
import { createSnapshotRpcClient, loadSnapshotRuntime, resolveSnapshotAnchor, runSnapshotProcess } from './snapshotRuntime.js'
import { localIdentityChain, type IdentityChain } from './identityChains.js'
import {
  readStorageMap,
  registrationFrom,
  resolveIdentityRows,
  subIdentityFrom,
  tombstoneRow,
  usernameFrom,
  type AccountIdentityRow,
  type ChainIdentityState,
} from './identitySources.js'

// On-chain identity snapshot.
//
// Walks the chain's Identity storage at a single anchor block and writes one
// price_data.account_identities row per account that resolves to a display name —
// its own registration, else "Parent/Sub" for a sub-identity, else its primary
// username.
//
// Usage:
//   npx tsx src/scripts/snapshot-identities.ts [--dry-run] [--loop]
//                                              [--block=N] [--page-size=500]
//
// State availability: reads STATE at the anchor. A pruned node only keeps recent
// state, so a --block anchor needs an archive RPC; the head default always works.

const dryRun = hasFlag('dry-run')
// --loop runs an initial snapshot immediately, then re-snapshots every
// --refresh-hours, so the service self-populates on `docker compose up` and keeps
// identities fresh without any manual step.
const loop = hasFlag('loop')
const refreshHours = integerOption('refresh-hours', 1)
const pageSize = integerOption('page-size', 500)
const flushThreshold = integerOption('flush', 5_000)
// Anchor override for a manual run.
const blockOverride = optionalIntegerOption('block')

const client = createClickHouseClient()
const chain = localIdentityChain(config.RPC_URL)

async function insertRows(rows: AccountIdentityRow[]): Promise<number> {
  if (dryRun || rows.length === 0) return 0
  for (let offset = 0; offset < rows.length; offset += flushThreshold) {
    await client.insert({
      table: 'price_data.account_identities',
      values: rows.slice(offset, offset + flushThreshold),
      format: 'JSONEachRow',
    })
  }
  return rows.length
}

async function displayedAccounts(chain: string): Promise<Set<string>> {
  const res = await client.query({
    query: `
      SELECT account_id
      FROM price_data.account_identities FINAL
      WHERE chain = {chain:String} AND display != ''`,
    query_params: { chain },
    format: 'JSONEachRow',
  })
  const rows = await res.json<{ account_id: string }>()
  return new Set(rows.map(row => row.account_id))
}

async function snapshotChain(chain: IdentityChain): Promise<void> {
  let rpc: RpcClient | null = null
  const startedAt = Date.now()
  try {
    rpc = createSnapshotRpcClient(chain.url)
    const { hash, height } = await resolveSnapshotAnchor(rpc, blockOverride ?? chain.block)
    const { runtime, timestamp } = await loadSnapshotRuntime(rpc, hash)

    const state: ChainIdentityState = {
      registrations: await readStorageMap(runtime, hash, 'Identity.IdentityOf', pageSize, registrationFrom),
      subs: await readStorageMap(runtime, hash, 'Identity.SuperOf', pageSize, subIdentityFrom),
      usernames: await readStorageMap(runtime, hash, 'Identity.UsernameOf', pageSize, value => usernameFrom(value) || null),
    }

    const rows = resolveIdentityRows(state, chain, timestamp)
    // An identity cleared on chain has to disappear here too, or the explorer keeps
    // showing a name its owner removed. A dry run stays off ClickHouse entirely, so
    // it can prove the decode works without a database to compare against.
    const live = new Set(rows.map(row => row.account_id))
    const retired = dryRun ? [] : [...await displayedAccounts(chain.key)]
      .filter(accountId => !live.has(accountId))
      .map(accountId => tombstoneRow(chain, accountId, timestamp))

    const inserted = await insertRows([...rows, ...retired])

    console.log(JSON.stringify({
      type: 'identity_snapshot_chain',
      chain: chain.key,
      priority: chain.priority,
      rpc_url: chain.url,
      anchor_block: height,
      pinned: chain.block != null || blockOverride != null,
      registrations: state.registrations.size,
      subs: state.subs.size,
      usernames: state.usernames.size,
      displayed: rows.length,
      retired: retired.length,
      rows_inserted: inserted,
      dry_run: dryRun,
      seconds: Math.round((Date.now() - startedAt) / 1000),
    }))
  } finally {
    rpc?.close()
  }
}

async function runOnce(): Promise<void> {
  console.log(JSON.stringify({
    type: 'identity_snapshot_start',
    dry_run: dryRun,
    page_size: pageSize,
    chain: chain.key,
  }))

  let failed = 0
  try {
    await snapshotChain(chain)
  } catch (error) {
    failed++
    console.error(JSON.stringify({ type: 'identity_snapshot_chain_error', chain: chain.key, rpc_url: chain.url, reason: (error as Error).message }))
  }

  console.log(JSON.stringify({ type: 'identity_snapshot_done', chains_failed: failed, dry_run: dryRun }))
}

void runSnapshotProcess({
  loop,
  refreshHours,
  runOnce,
  close: async () => {
    await client.close()
  },
})
