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

const UNIFIED_SWAP_EVENTS_SPEC_VERSION = 282

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
 * First appeared in v183 (block 3632973) when the XYK pallet was upgraded.
 * No schema changes detected by typegen after initial version.
 */
const XYK_SWAP_EVENTS: SwapEventEntry[] = [
  {
    name: 'XYK.SellExecuted',
    pallet: 'XYK',
    firstBlock: 3632973,
    versions: [
      { specVersion: 183, firstBlock: 3632973 },
    ],
    codec: xyk.sellExecuted,
  },
  {
    name: 'XYK.BuyExecuted',
    pallet: 'XYK',
    firstBlock: 3632973,
    versions: [
      { specVersion: 183, firstBlock: 3632973 },
    ],
    codec: xyk.buyExecuted,
  },
]

/**
 * Unified swap events emitted by the Broadcast pallet.
 *
 * These events supersede the legacy per-pallet *Executed events from spec v282
 * onward. We keep their metadata separate because the curated first-block
 * catalog above only tracks legacy pool-specific events today.
 */
const UNIFIED_SWAP_EVENT_NAMES = [
  'Broadcast.Swapped',
  'Broadcast.Swapped2',
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
  'Broadcast.Swapped2': EventCategory.SWAP,
  'Broadcast.Swapped3': EventCategory.SWAP,
}

/**
 * Check if an event name represents a swap event
 *
 * @param eventName - Full qualified event name (e.g., 'XYK.SellExecuted')
 * Runtime-aware behavior:
 * - pre-v282: legacy XYK *Executed events are swaps
 * - v282+: Broadcast.Swapped* events are swaps
 *
 * @param specVersion - Runtime spec version for the block being processed
 * @returns True if the event is classified as a swap event for that runtime
 *
 * @example
 * isSwapEvent('XYK.SellExecuted', 201) // true
 * isSwapEvent('XYK.SellExecuted', 282) // false
 * isSwapEvent('Broadcast.Swapped3', 323) // true
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
