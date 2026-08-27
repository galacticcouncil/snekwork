import { ApiPromise, HttpProvider } from '@polkadot/api'
import { SUBSTRATE_RPC_URL } from './substrateRpc.ts'

// One connected ApiPromise for the whole process, owned here.
//
// It exists for the two readers that need decoded runtime metadata or a live
// storage value the indexed data cannot answer: `runtimeConstants.ts` (a
// `#[pallet::constant]` is decoded into `api.consts` when the metadata loads, so
// reading one is a property access, not a round trip) and the governance
// service's live referendum tally.
//
// Every reader must tolerate `null`: the connection is established
// asynchronously at startup and stays null when the node is unreachable. The
// explorer renders completely without it — a reader answers with the indexed
// value or with nothing, never with a guess.

let api: ApiPromise | null = null
let connecting = false

export function nodeApi(): ApiPromise | null { return api }

export function startNodeApi(): void {
  if (api || connecting) return
  connecting = true
  void ApiPromise.create({ provider: new HttpProvider(SUBSTRATE_RPC_URL), noInitWarn: true, throwOnConnect: false })
    .then(created => { api = created })
    .catch(error => {
      console.error('[node] RPC connection failed; runtime constants and live tallies unavailable:', error instanceof Error ? error.message : error)
    })
    .finally(() => { connecting = false })
}

export function stopNodeApi(): void {
  const a = api
  api = null
  if (a) void a.disconnect().catch(() => { /* closing */ })
}
