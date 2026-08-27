/**
 * Basilisk runtime eras
 *
 * Basilisk has run 35 runtime spec versions since genesis and, unlike the
 * Hydration codebase this indexer was forked from, its history reaches all the
 * way back to a V13-metadata chain with a different AMM (`Exchange`), positional
 * tuple events and pre-`frozen` balance shapes. The block heights below are the
 * first block of each spec version that actually changes a shape this indexer
 * decodes; they are documentation and reporting aids.
 *
 * Decode paths must NOT branch on these numbers. Every codec in `src/types` has
 * an `.is(block)` probe that inspects the block's own metadata, and that is what
 * the call sites use — a back-ported or re-ordered runtime then still routes to
 * the codec that genuinely matches. The constants exist so that logs, comments
 * and (in the legacy-decode phase) the landmark table can name an era.
 */
import type { Block } from './types/support.ts'
import * as storage from './types/storage.ts'

export const BASILISK_ERAS = {
  /** Genesis runtime. V13 metadata, positional tuple events, `Exchange` AMM. */
  GENESIS: { specVersion: 16, firstBlock: 0 },
  /** XYK.PoolCreated/PoolDestroyed gain shareToken + pool account; XCM locations move to V1. */
  XYK_LIFECYCLE_POOL_ACCOUNT: { specVersion: 19, firstBlock: 129_697 },
  /** V14 (self-describing) metadata; before this the type bundle is required. */
  METADATA_V14: { specVersion: 25, firstBlock: 395_664 },
  /** XYK/LBP swap + lifecycle events become named structs. */
  NAMED_EVENT_FIELDS: { specVersion: 55, firstBlock: 1_322_823 },
  /** `Exchange` pallet removed; XYK liquidity mining added. */
  EXCHANGE_REMOVED: { specVersion: 81, firstBlock: 2_144_141 },
  /** System.Account AccountData gains `frozen` + `flags`. */
  ACCOUNT_DATA_FLAGS: { specVersion: 108, firstBlock: 5_030_935 },
  /** Broadcast pallet introduced, emitting `Broadcast.Swapped`. */
  BROADCAST_SWAPPED: { specVersion: 124, firstBlock: 8_374_452 },
  /** `Broadcast.Swapped` replaced by `Broadcast.Swapped3`; XCM locations move to V5. */
  BROADCAST_SWAPPED3: { specVersion: 128, firstBlock: 12_663_601 },
} as const

/**
 * What each shape era actually CARRIES on Basilisk mainnet.
 *
 * Runtime metadata says which shapes a block CAN emit; these are the blocks where
 * one first did. They come from a block-by-block sweep of System.Events over
 * blocks 0 .. 2,144,141 — the whole pre-Broadcast history — reading every block
 * whose System.EventCount exceeded the idle baseline (2 events before spec 25,
 * 3 from spec 25 on) and decoding it with that block's own runtime.
 *
 * The sweep's negative results are the load-bearing part, and they are why the
 * legacy decoders below can be written once and left alone:
 *
 *  - The first 1,535,701 blocks carry NO AMM event of any kind. Basilisk shipped
 *    with transfers disabled; blocks 0 .. 395,663 (the whole V13/tuple span) hold
 *    not one Tokens, Currencies or Balances event either, and 395,664 .. 1,400,000
 *    is sudo-driven crowdloan vesting and plain transfers.
 *  - So the positional-TUPLE eras of XYK.Sell/BuyExecuted (v16, v19) and
 *    LBP.Sell/BuyExecuted (v16) were never once emitted: the first XYK pool is
 *    created at spec 65, ten specs after v55 turned those events into named
 *    structs, and the first LBP pool at spec 76.
 *  - The `Exchange` pallet — Basilisk's genesis intention-matching AMM, present
 *    specs 16..76 — emitted ZERO events across its entire life. Not one
 *    IntentionRegistered, so not one resolved AMM or direct trade.
 *  - AssetRegistry.AssetLocations is empty for the whole V0 (spec 16..18) XCM
 *    shape and stays empty until between blocks 1,000,000 and 2,000,000, by which
 *    time locations are stored in V1.
 *
 * The decoders for those shapes are still implemented and tested: a shape the
 * metadata declares is a shape a block may legally carry, and the alternative is
 * silently dropping it. What the sweep buys is the knowledge that none of them
 * can be restating live numbers today.
 */
export const BASILISK_FIRST_SEEN = {
  /** First XYK pool ever created (XYK.PoolCreated, spec 65). */
  XYK_POOL_CREATED: 1_535_702,
  /** First XYK swap ever executed (XYK.SellExecuted, spec 69). */
  XYK_SWAP: 1_539_480,
  /** First LBP pool ever created (LBP.PoolCreated, spec 76). */
  LBP_POOL_CREATED: 1_972_469,
  /** First LBP swap ever executed (LBP.SellExecuted, spec 76). */
  LBP_SWAP: 1_974_169,
  /** First unified swap event (Broadcast.Swapped, spec 124). */
  BROADCAST_SWAP: 8_374_503,
} as const

/**
 * Narrow view of Tokens.Accounts for reserve reads: every era's value carries a
 * `free` balance, which is all the pool-reserve readers need.
 */
export interface TokensAccountsCodec {
  getMany(block: Block, keys: [string, number][]): Promise<({ free: bigint } | undefined)[]>
}

/**
 * Select the Tokens.Accounts codec that matches this block.
 *
 * orml-tokens has stored the same {free, reserved, frozen} balance from genesis
 * through spec 134, so there is a single codec — but only once the type bundle
 * aliases the genesis era's ambiguous `AccountData` name to `OrmlAccountData`
 * (see src/basiliskTypesBundle.ts). Returns null when it does not match, so
 * callers can decide whether that is fatal.
 */
export function tokensAccountsCodec(block: Block): TokensAccountsCodec | null {
  if (storage.tokens.accounts.v16.is(block)) return storage.tokens.accounts.v16
  return null
}

/**
 * Narrow view of System.Account for native-balance reads: both eras expose
 * `data.free`, and only the frozen/flags fields around it changed.
 */
export interface SystemAccountCodec {
  getMany(block: Block, keys: string[]): Promise<({ data: { free: bigint } } | undefined)[]>
  getDefault(block: Block): { data: { free: bigint } }
}

/**
 * Select the System.Account codec that matches this block.
 *
 * v16 (genesis .. spec 105) stores AccountData{free, reserved, miscFrozen,
 * feeFrozen}; v108 (spec 108 onward) stores {free, reserved, frozen, flags}.
 */
export function systemAccountCodec(block: Block): SystemAccountCodec | null {
  if (storage.system.account.v108.is(block)) return storage.system.account.v108
  if (storage.system.account.v16.is(block)) return storage.system.account.v16
  return null
}
