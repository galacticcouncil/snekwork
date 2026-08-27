// The chain whose Identity storage the snapshot reads.
//
// The Identity pallet is keyed by the 32-byte AccountId, so the same public key
// can carry a registration on several chains at once. Snekwork deliberately
// reads only the local chain: a name registered here is what the account asked
// to be called here, and pulling in ecosystem-wide names is a product surface
// this explorer does not carry.

export const BASILISK_CHAIN_KEY = 'basilisk'

export interface IdentityChain {
  key: string           // stored in account_identities.chain
  url: string           // RPC endpoint serving Identity.* storage
  block: number | null  // pinned anchor, or null for the finalized head
  priority: number      // 0 = highest
}

export function localIdentityChain(url: string): IdentityChain {
  return { key: BASILISK_CHAIN_KEY, url, block: null, priority: 0 }
}
