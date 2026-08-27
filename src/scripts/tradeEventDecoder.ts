// Every per-pallet swap event a pre-Broadcast block reports its volume with.
// Must stay identical to the SWAP-classified entries of the catalogue in
// src/registry/swapEvents.ts — a name here that isSwapEvent rejects (or the
// reverse) is a repair that restates live ingestion.
export const LEGACY_SWAP_EVENT_NAMES = [
  'XYK.SellExecuted',
  'XYK.BuyExecuted',
  'LBP.SellExecuted',
  'LBP.BuyExecuted',
] as const

// Basilisk's Broadcast pallet emits `Swapped` from spec 124 and `Swapped3` from
// spec 128. It never had a `Swapped2` — see src/registry/swapEvents.ts.
export const BROADCAST_SWAP_EVENT_NAMES = [
  'Broadcast.Swapped',
  'Broadcast.Swapped3',
] as const

export const ALL_SWAP_EVENT_NAMES = [...LEGACY_SWAP_EVENT_NAMES, ...BROADCAST_SWAP_EVENT_NAMES]

export interface RawTradeEventRow {
  block_height: number
  event_name: string
  args_json: string
}

export interface TradeAssetAmount {
  assetId: number
  amount: bigint
}

export interface DecodedRawTrade {
  account: string | null
  inputs: TradeAssetAmount[]
  outputs: TradeAssetAmount[]
}

function normalizeAccount(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value
  if (value && typeof value === 'object' && 'value' in value) {
    const nested = (value as { value?: unknown }).value
    if (typeof nested === 'string' && nested.length > 0) return nested
  }
  return null
}

function parseAssetAmounts(value: unknown): TradeAssetAmount[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const asset = (item as { asset?: unknown }).asset
    const amount = (item as { amount?: unknown }).amount
    if (typeof asset !== 'number' || (typeof amount !== 'string' && typeof amount !== 'number' && typeof amount !== 'bigint')) return []
    return [{ assetId: asset, amount: BigInt(amount) }]
  })
}

/**
 * The two legs of a per-pallet XYK or LBP fill, whichever era wrote the row.
 *
 * `raw_events.args_json` is the decoder's output verbatim, so its SHAPE follows
 * the runtime: a named struct from spec 55 on, a positional tuple (a JSON array)
 * before it. This is the repair-side twin of LEGACY_SWAP_CODECS in
 * src/blocks/extractVolume.ts and reads the same positions:
 *   SellExecuted [who, asset in,  asset out, amount, sale price, fee asset, fee amount, (pool)]
 *   BuyExecuted  [who, asset out, asset in,  amount, buy price,  fee asset, fee amount, (pool)]
 * A sell fixes its input, a buy fixes its output — hence the flipped asset pair.
 * `feeAsset`/`feeAmount` describe a separate pool→collector transfer and are not
 * carved out of either leg, in any era.
 *
 * pallet-lbp's `buy` reports its two amounts against the WRONG legs — the amount
 * paid sits where the amount bought belongs — for all 104 LBP.BuyExecuted events
 * in blocks 1,400,000..2,144,141, checked against each one's own transfers. The
 * correction below must stay identical to AMOUNT_INVERTED_LEGACY_EVENTS in
 * src/blocks/extractVolume.ts, or a volume repair would restate live ingestion.
 *
 * No Basilisk block has ever carried a tuple-shaped swap row (the first XYK pool
 * post-dates the v55 rename by ten specs, and the first LBP pool by twenty-one),
 * so that arm restates nothing today. It exists because the runtimes of blocks
 * 0..1,322,822 can legally emit one.
 */
function legacySwapLegs(eventName: string, args: unknown): DecodedRawTrade | null {
  const sell = eventName === 'XYK.SellExecuted' || eventName === 'LBP.SellExecuted'
  const buy = eventName === 'XYK.BuyExecuted' || eventName === 'LBP.BuyExecuted'
  if (!sell && !buy) return null
  const inverted = eventName === 'LBP.BuyExecuted'

  const legs = (
    account: string | null,
    input: TradeAssetAmount,
    output: TradeAssetAmount,
  ): DecodedRawTrade => (inverted
    ? { account, inputs: [{ assetId: input.assetId, amount: output.amount }], outputs: [{ assetId: output.assetId, amount: input.amount }] }
    : { account, inputs: [input], outputs: [output] })

  if (Array.isArray(args)) {
    const [who, firstAsset, secondAsset, amount, price] = args as unknown[]
    const fixed = { assetId: Number(firstAsset), amount: BigInt(amount as string) }
    const derived = { assetId: Number(secondAsset), amount: BigInt(price as string) }
    return sell
      ? legs(normalizeAccount(who), fixed, derived)
      : legs(normalizeAccount(who), derived, fixed)
  }

  const named = args as Record<string, unknown>
  const assetIn = Number(named.assetIn)
  const assetOut = Number(named.assetOut)
  return sell
    ? legs(
        normalizeAccount(named.who),
        { assetId: assetIn, amount: BigInt(named.amount as string) },
        { assetId: assetOut, amount: BigInt(named.salePrice as string) },
      )
    : legs(
        normalizeAccount(named.who),
        { assetId: assetIn, amount: BigInt(named.buyPrice as string) },
        { assetId: assetOut, amount: BigInt(named.amount as string) },
      )
}

export function decodeRawTrade(row: RawTradeEventRow): DecodedRawTrade | null {
  const args = JSON.parse(row.args_json) as unknown

  const legacy = legacySwapLegs(row.event_name, args)
  if (legacy) return legacy

  if (!row.event_name.startsWith('Broadcast.Swapped')) return null

  const named = args as Record<string, unknown>
  const inputs = parseAssetAmounts(named.inputs)
  const outputs = parseAssetAmounts(named.outputs)
  const fillerType = (named.fillerType as { __kind?: string } | undefined)?.__kind
  const operation = (named.operation as { __kind?: string } | undefined)?.__kind
  // Both Basilisk Broadcast events report exact-out XYK/LBP fills with the two
  // amounts against the wrong legs. This must stay identical to the correction in
  // src/blocks/extractVolume.ts, or a volume repair would restate live ingestion.
  if (operation === 'ExactOut' && (fillerType === 'XYK' || fillerType === 'LBP') && inputs.length === 1 && outputs.length === 1) {
    return {
      account: normalizeAccount(named.swapper),
      inputs: [{ assetId: inputs[0].assetId, amount: outputs[0].amount }],
      outputs: [{ assetId: outputs[0].assetId, amount: inputs[0].amount }],
    }
  }
  return { account: normalizeAccount(named.swapper), inputs, outputs }
}
