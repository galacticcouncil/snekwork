/**
 * Swap Event Catalogue
 *
 * The single authoritative table of every event any Basilisk runtime has ever
 * emitted for a trade, from the genesis `Exchange` AMM to the head's unified
 * `Broadcast` pallet. Each entry carries:
 * - the full qualified event name and the pallet that emits it
 * - the block span the pallet emitted it over
 * - the schema-change versions inside that span, with their first blocks
 * - the typegen codec whose `.vNNN.is(event)` probes the block's own metadata
 * - a classification saying what the event MEANS for volume
 *
 * Consumed directly by the indexer at runtime. Nothing here selects a decoder by
 * block height: the era numbers are documentation and reporting aids, and the
 * decode call sites route on `.is(event)` so a back-ported or re-ordered runtime
 * still lands on the codec that genuinely matches. The one thing block/spec
 * numbers DO decide is which events are eligible at all — see isSwapEvent.
 */

import * as xyk from '../types/xyk/events'
import * as lbp from '../types/lbp/events'
import * as exchange from '../types/exchange/events'
import { BASILISK_ERAS } from '../chainEras.ts'

// Basilisk routes every swap through the Broadcast pallet from spec 124
// (block 8,374,452). Before that each AMM emitted its own *Executed event.
const UNIFIED_SWAP_EVENTS_SPEC_VERSION = BASILISK_ERAS.BROADCAST_SWAPPED.specVersion

/**
 * Schema version with first-appearance block height
 */
interface SwapEventVersion {
  /** Runtime spec version where this schema was introduced */
  specVersion: number
  /** Block height where this spec version first appeared */
  firstBlock: number
}

type SwapPallet = 'XYK' | 'LBP' | 'Exchange' | 'Broadcast'

/**
 * Complete swap event catalog entry
 */
interface SwapEventEntry {
  /** Full qualified event name, e.g. 'XYK.SellExecuted' */
  name: string
  /** Pallet that emits this event */
  pallet: SwapPallet
  /** Block height where this event first appeared */
  firstBlock: number
  /** First block that no longer emits it, or null while it is still emitted */
  removedAtBlock: number | null
  /** Schema-change versions with first-appearance blocks */
  versions: SwapEventVersion[]
  /** Typegen-generated event object with .vXXX.is() and .vXXX.decode() methods */
  codec: Record<string, unknown>
}

/**
 * Event classification categories
 */
enum EventCategory {
  /** Carries a trade's own two legs: this event IS the volume. */
  SWAP = 'SWAP',
  /** Marks a trade whose legs are carried by a sibling event; counting it double-counts. */
  ROUTING = 'ROUTING',
  LIQUIDITY = 'LIQUIDITY',
  LIFECYCLE = 'LIFECYCLE',
  FEE = 'FEE',
}

const GENESIS_BLOCK = BASILISK_ERAS.GENESIS.firstBlock
const TUPLE_V16: SwapEventVersion = { specVersion: BASILISK_ERAS.GENESIS.specVersion, firstBlock: BASILISK_ERAS.GENESIS.firstBlock }
const TUPLE_V19: SwapEventVersion = { specVersion: BASILISK_ERAS.XYK_LIFECYCLE_POOL_ACCOUNT.specVersion, firstBlock: BASILISK_ERAS.XYK_LIFECYCLE_POOL_ACCOUNT.firstBlock }
const NAMED_V55: SwapEventVersion = { specVersion: BASILISK_ERAS.NAMED_EVENT_FIELDS.specVersion, firstBlock: BASILISK_ERAS.NAMED_EVENT_FIELDS.firstBlock }

/**
 * XYK swap events — the constant-product pool pallet, live from genesis to head.
 *
 * Two schema changes: the genesis v16 tuple gains a trailing pool account in v19,
 * and v55 turns the whole tuple into a named struct. Basilisk's first XYK pool was
 * not created until block 1,535,702 (spec 65), so only the v55 struct has ever
 * actually been emitted — the two tuple shapes are decoded because the metadata
 * declares them, not because a block carries one (see BASILISK_FIRST_SEEN).
 *
 * These keep being emitted alongside Broadcast.Swapped* at head; isSwapEvent's era
 * gate is what stops the pair being counted twice.
 */
const XYK_SWAP_EVENTS: SwapEventEntry[] = [
  {
    name: 'XYK.SellExecuted',
    pallet: 'XYK',
    firstBlock: GENESIS_BLOCK,
    removedAtBlock: null,
    versions: [TUPLE_V16, TUPLE_V19, NAMED_V55],
    codec: xyk.sellExecuted,
  },
  {
    name: 'XYK.BuyExecuted',
    pallet: 'XYK',
    firstBlock: GENESIS_BLOCK,
    removedAtBlock: null,
    versions: [TUPLE_V16, TUPLE_V19, NAMED_V55],
    codec: xyk.buyExecuted,
  },
]

/**
 * LBP swap events — the liquidity-bootstrapping pallet, live from genesis to head.
 *
 * One schema change: the v16 tuple becomes a named struct at v55. Unlike XYK the
 * tuple never grew a pool account, so it is seven elements in every tuple era.
 *
 * LBP fills are trades and count as volume, but LBP pools never enter the price
 * graph: their weights ramp with time, so a spot ratio off their reserves is not
 * a price anyone can trade at. src/pool/reserves.ts reads XYK pools only, and
 * nothing here changes that — this catalogue is about volume and classification.
 */
const LBP_SWAP_EVENTS: SwapEventEntry[] = [
  {
    name: 'LBP.SellExecuted',
    pallet: 'LBP',
    firstBlock: GENESIS_BLOCK,
    removedAtBlock: null,
    versions: [TUPLE_V16, NAMED_V55],
    codec: lbp.sellExecuted,
  },
  {
    name: 'LBP.BuyExecuted',
    pallet: 'LBP',
    firstBlock: GENESIS_BLOCK,
    removedAtBlock: null,
    versions: [TUPLE_V16, NAMED_V55],
    codec: lbp.buyExecuted,
  },
]

/**
 * Exchange pallet events — Basilisk's genesis AMM, removed at spec 81 (block
 * 2,144,141). It never held liquidity itself: users registered SELL/BUY intentions
 * and, at the end of the block, the pallet matched opposing intentions against each
 * other and pushed whatever was left into the XYK pool.
 *
 * That two-sided resolution is why these are catalogued but NOT counted as volume:
 *
 * - `IntentionResolvedAMMTrade` says an intention was filled against the XYK pool.
 *   The pool leg emits its own XYK.Sell/BuyExecuted in the same block, carrying the
 *   same two amounts with their asset ids attached. That sibling is the volume;
 *   counting this marker as well would count the trade twice. Classified ROUTING.
 * - `IntentionResolvedDirectTrade` is a genuine P2P leg — two users matched at the
 *   pool price, with no XYK event beside it — and both sides are one trade, not
 *   two. It is the one Exchange event that WOULD be volume. But its args are
 *   {accountIdA, accountIdB, intentionIdA, intentionIdB, amountA, amountB}: no
 *   asset ids at all. The assets live in the two `Exchange.IntentionRegistered`
 *   events the ids point back to, so pricing a direct trade means resolving the
 *   pair and then deciding which of a registered intention's {assetA, assetB} is
 *   the leg being sold — an orientation that flips with the intention's SELL/BUY
 *   type and that no Basilisk block can settle.
 * - `IntentionResolvedDirectTradeFees` is the fee leg of the above, never a trade.
 *
 * "No Basilisk block can settle it" is literal: a block-by-block sweep of the
 * pallet's ENTIRE life (blocks 0 .. 2,144,140) found zero Exchange events of any
 * kind — not one intention was ever registered, so not one was ever resolved. So
 * the honest catalogue entry is the classification plus this note; a decoder for
 * the direct-trade orientation would be a guess with nothing to check it against,
 * and it would be restating no rows. See BASILISK_FIRST_SEEN in src/chainEras.ts.
 */
const EXCHANGE_TRADE_EVENTS: SwapEventEntry[] = [
  {
    name: 'Exchange.IntentionResolvedAMMTrade',
    pallet: 'Exchange',
    firstBlock: GENESIS_BLOCK,
    removedAtBlock: BASILISK_ERAS.EXCHANGE_REMOVED.firstBlock,
    versions: [TUPLE_V16, TUPLE_V19, NAMED_V55],
    codec: exchange.intentionResolvedAmmTrade,
  },
  {
    name: 'Exchange.IntentionResolvedDirectTrade',
    pallet: 'Exchange',
    firstBlock: GENESIS_BLOCK,
    removedAtBlock: BASILISK_ERAS.EXCHANGE_REMOVED.firstBlock,
    versions: [TUPLE_V16, NAMED_V55],
    codec: exchange.intentionResolvedDirectTrade,
  },
]

/**
 * Unified swap events emitted by the Broadcast pallet.
 *
 * These supersede the legacy per-pallet *Executed events from spec 124 onward.
 * Basilisk only ever emitted two of the three names Hydration has: `Swapped`
 * (spec 124-127) and `Swapped3` (spec 128+). There is no `Swapped2` in any
 * Basilisk runtime, so it is deliberately absent here and from the typegen
 * selection — an event by that name can only be a mis-paired chain.
 */
const UNIFIED_SWAP_EVENT_NAMES = [
  'Broadcast.Swapped',
  'Broadcast.Swapped3',
] as const

/**
 * Every per-pallet trade event, whatever it means for volume. Exported so the
 * era catalogue has exactly one table and callers can report on it.
 */
export const SWAP_EVENT_CATALOG: readonly SwapEventEntry[] = [
  ...XYK_SWAP_EVENTS,
  ...LBP_SWAP_EVENTS,
  ...EXCHANGE_TRADE_EVENTS,
]

/**
 * Event classification map
 *
 * Distinguishes swap events from liquidity operations, pool lifecycle events and
 * routing markers, so the indexer can filter and categorize at runtime without
 * hardcoding event names.
 */
const EVENT_CLASSIFICATION: Record<string, EventCategory> = {
  // XYK swap events
  'XYK.SellExecuted': EventCategory.SWAP,
  'XYK.BuyExecuted': EventCategory.SWAP,

  // LBP swap events
  'LBP.SellExecuted': EventCategory.SWAP,
  'LBP.BuyExecuted': EventCategory.SWAP,

  // XYK lifecycle events
  'XYK.PoolCreated': EventCategory.LIFECYCLE,
  'XYK.PoolDestroyed': EventCategory.LIFECYCLE,

  // LBP lifecycle + liquidity events
  'LBP.PoolCreated': EventCategory.LIFECYCLE,
  'LBP.PoolUpdated': EventCategory.LIFECYCLE,
  'LBP.LiquidityAdded': EventCategory.LIQUIDITY,
  'LBP.LiquidityRemoved': EventCategory.LIQUIDITY,

  // Exchange (genesis AMM) — see EXCHANGE_TRADE_EVENTS for why neither resolved
  // trade is a volume leg.
  'Exchange.IntentionRegistered': EventCategory.LIFECYCLE,
  'Exchange.IntentionResolvedAMMTrade': EventCategory.ROUTING,
  'Exchange.IntentionResolvedDirectTrade': EventCategory.ROUTING,
  'Exchange.IntentionResolvedDirectTradeFees': EventCategory.FEE,

  // Unified swap events
  'Broadcast.Swapped': EventCategory.SWAP,
  'Broadcast.Swapped3': EventCategory.SWAP,
}

// The per-pallet events that carry their own two legs, i.e. the ones a
// pre-Broadcast block's volume is read from. Derived from the classification map
// rather than restated, so a name cannot be counted as volume without being
// declared SWAP.
const LEGACY_SWAP_EVENT_NAMES = new Set(
  SWAP_EVENT_CATALOG
    .filter(entry => EVENT_CLASSIFICATION[entry.name] === EventCategory.SWAP)
    .map(entry => entry.name),
)
const UNIFIED_SWAP_EVENT_NAME_SET = new Set<string>(UNIFIED_SWAP_EVENT_NAMES)

/**
 * Check if an event name represents a swap event
 *
 * @param eventName - Full qualified event name (e.g., 'XYK.SellExecuted')
 * Runtime-aware behavior:
 * - pre-spec-124: legacy XYK/LBP *Executed events are swaps
 * - spec 124+: Broadcast.Swapped* events are swaps
 *
 * The gate is what keeps head blocks from double-counting: XYK and LBP still emit
 * their own *Executed event next to every Broadcast.Swapped*, and both describe
 * the same fill.
 *
 * @param specVersion - Runtime spec version for the block being processed
 * @returns True if the event is classified as a swap event for that runtime
 *
 * @example
 * isSwapEvent('XYK.SellExecuted', 115) // true
 * isSwapEvent('XYK.SellExecuted', 124) // false
 * isSwapEvent('Broadcast.Swapped3', 134) // true
 */
export function isSwapEvent(eventName: string, specVersion?: number): boolean {
  if (specVersion != null && specVersion >= UNIFIED_SWAP_EVENTS_SPEC_VERSION) {
    return UNIFIED_SWAP_EVENT_NAME_SET.has(eventName)
  }

  if (specVersion != null) {
    return LEGACY_SWAP_EVENT_NAMES.has(eventName)
  }

  return EVENT_CLASSIFICATION[eventName] === EventCategory.SWAP
}
