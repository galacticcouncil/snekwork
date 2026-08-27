/**
 * Swap Event Registry Catalog
 *
 * Catalogs the XYK swap events and the unified Broadcast swap events with:
 * - Full qualified event names
 * - Pallet identification
 * - First-appearance block heights
 * - Schema-change version tracking
 * - Event classification (swap/liquidity/lifecycle)
 * - Direct codec references for runtime consumption
 *
 * Consumed directly by the indexer at runtime.
 */

import * as xyk from '../types/xyk/events'
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

/**
 * Complete swap event catalog entry
 */
interface SwapEventEntry {
  /** Full qualified event name, e.g. 'XYK.SellExecuted' */
  name: string
  /** Pallet that emits this event */
  pallet: 'XYK'
  /** Block height where this event first appeared */
  firstBlock: number
  /** Schema-change versions with first-appearance blocks */
  versions: SwapEventVersion[]
  /** Typegen-generated event object with .vXXX.is() and .vXXX.decode() methods */
  codec: Record<string, unknown>
}

/**
 * Event classification categories
 */
enum EventCategory {
  SWAP = 'SWAP',
  LIQUIDITY = 'LIQUIDITY',
  LIFECYCLE = 'LIFECYCLE',
}

/**
 * XYK swap events
 *
 * Present since genesis. Two schema changes: the genesis v16 tuple gains a
 * trailing pool account in v19, and v55 turns the whole tuple into a named
 * struct. Only the v55+ struct is decoded today (see extractVolume); the two
 * tuple eras are decoded in the legacy-decode phase.
 */
const XYK_SWAP_EVENTS: SwapEventEntry[] = [
  {
    name: 'XYK.SellExecuted',
    pallet: 'XYK',
    firstBlock: BASILISK_ERAS.GENESIS.firstBlock,
    versions: [
      { specVersion: BASILISK_ERAS.GENESIS.specVersion, firstBlock: BASILISK_ERAS.GENESIS.firstBlock },
      { specVersion: BASILISK_ERAS.XYK_LIFECYCLE_POOL_ACCOUNT.specVersion, firstBlock: BASILISK_ERAS.XYK_LIFECYCLE_POOL_ACCOUNT.firstBlock },
      { specVersion: BASILISK_ERAS.NAMED_EVENT_FIELDS.specVersion, firstBlock: BASILISK_ERAS.NAMED_EVENT_FIELDS.firstBlock },
    ],
    codec: xyk.sellExecuted,
  },
  {
    name: 'XYK.BuyExecuted',
    pallet: 'XYK',
    firstBlock: BASILISK_ERAS.GENESIS.firstBlock,
    versions: [
      { specVersion: BASILISK_ERAS.GENESIS.specVersion, firstBlock: BASILISK_ERAS.GENESIS.firstBlock },
      { specVersion: BASILISK_ERAS.XYK_LIFECYCLE_POOL_ACCOUNT.specVersion, firstBlock: BASILISK_ERAS.XYK_LIFECYCLE_POOL_ACCOUNT.firstBlock },
      { specVersion: BASILISK_ERAS.NAMED_EVENT_FIELDS.specVersion, firstBlock: BASILISK_ERAS.NAMED_EVENT_FIELDS.firstBlock },
    ],
    codec: xyk.buyExecuted,
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

const SWAP_EVENT_CATALOG: SwapEventEntry[] = [...XYK_SWAP_EVENTS]

const LEGACY_SWAP_EVENT_NAMES = new Set(SWAP_EVENT_CATALOG.map(event => event.name))
const UNIFIED_SWAP_EVENT_NAME_SET = new Set<string>(UNIFIED_SWAP_EVENT_NAMES)

/**
 * Event classification map
 *
 * Distinguishes swap events from liquidity operations and pool lifecycle events,
 * so the indexer can filter and categorize at runtime without hardcoding event
 * names.
 */
const EVENT_CLASSIFICATION: Record<string, EventCategory> = {
  // XYK swap events
  'XYK.SellExecuted': EventCategory.SWAP,
  'XYK.BuyExecuted': EventCategory.SWAP,

  // XYK lifecycle events
  'XYK.PoolCreated': EventCategory.LIFECYCLE,
  'XYK.PoolDestroyed': EventCategory.LIFECYCLE,

  // Unified swap events
  'Broadcast.Swapped': EventCategory.SWAP,
  'Broadcast.Swapped3': EventCategory.SWAP,
}

/**
 * Check if an event name represents a swap event
 *
 * @param eventName - Full qualified event name (e.g., 'XYK.SellExecuted')
 * Runtime-aware behavior:
 * - pre-spec-124: legacy XYK *Executed events are swaps
 * - spec 124+: Broadcast.Swapped* events are swaps
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
