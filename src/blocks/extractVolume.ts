/**
 * Volume Extraction Module
 *
 * Pure functions for extracting and aggregating trading volume from swap events:
 * - Decodes XYK and Broadcast swap events
 * - Calculates USD-denominated volumes using bigint-only arithmetic
 * - Generates bidirectional volume rows (sell + buy for each swap)
 * - Aggregates volumes by asset and merges with price rows
 *
 * All volume calculations use bigint arithmetic to prevent floating-point errors.
 * USD volumes are stored as Decimal128(12) strings for ClickHouse compatibility.
 */

import type { PriceMap, AssetDecimals } from '../price/types.js';
import type { PriceRow, TradeVolumeRow } from '../db/schema.js';
import { isSwapEvent } from '../registry/swapEvents.js';
import * as xyk from '../types/xyk/events.js';
import * as lbp from '../types/lbp/events.js';
import * as broadcast from '../types/broadcast/events.js';
import { aggregateTradeVolumeRows, sumBigIntStrings, sumDecimal128Strings, sumVolumeFields } from './volumeMath.js';

/**
 * Unified swap event structure across all pool types
 */
export interface DecodedSwap {
  assetIn: number;
  assetOut: number;
  amountIn: bigint;
  amountOut: bigint;
  trader?: string | null;
}

interface DecodedTradeAssetAmount {
  assetId: number;
  amount: bigint;
}

interface DecodedTrade {
  inputs: DecodedTradeAssetAmount[];
  outputs: DecodedTradeAssetAmount[];
  trader?: string | null;
}

interface CanonicalTradeLeg extends DecodedTradeAssetAmount {
  canonicalAssetId: number;
}

/**
 * Event-like structure for decoding (subset of Subsquid Event)
 */
interface EventLike {
  name: string;
  block: { _runtime: any };
  args: unknown;
}

function canonicalTradeLegs(
  trade: DecodedTrade,
): { inputs: CanonicalTradeLeg[]; outputs: CanonicalTradeLeg[] } {
  return {
    inputs: trade.inputs.map(input => ({ ...input, canonicalAssetId: input.assetId })),
    outputs: trade.outputs.map(output => ({ ...output, canonicalAssetId: output.assetId })),
  };
}

function originalsByCanonicalAsset(legs: CanonicalTradeLeg[]): Map<number, Set<number>> {
  const result = new Map<number, Set<number>>();
  for (const leg of legs) {
    const originals = result.get(leg.canonicalAssetId) ?? new Set<number>();
    originals.add(leg.assetId);
    result.set(leg.canonicalAssetId, originals);
  }
  return result;
}

function isCanonicalSelfConversion(
  leg: CanonicalTradeLeg,
  opposingOriginalsByCanonical: Map<number, Set<number>>
): boolean {
  const originals = opposingOriginalsByCanonical.get(leg.canonicalAssetId);
  return originals ? [...originals].some(opposingAssetId => opposingAssetId !== leg.assetId) : false;
}

function hasPositivePrice(prices: PriceMap, assetId: number): boolean {
  const price = prices.get(assetId);
  return price != null && Number(price) > 0;
}

function calculateLegUsdVolume(
  leg: CanonicalTradeLeg,
  prices: PriceMap,
  decimals: AssetDecimals
): string {
  const priceAssetId = hasPositivePrice(prices, leg.assetId) ? leg.assetId : leg.canonicalAssetId;
  return calculateUsdVolume(leg.amount, priceAssetId, prices, decimals);
}

function normalizeAccount(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  if (value && typeof value === 'object' && 'value' in value) {
    const nested = (value as { value?: unknown }).value;
    if (typeof nested === 'string' && nested.length > 0) {
      return nested;
    }
  }
  return null;
}

function broadcastTrade(decoded: {
  swapper: unknown;
  inputs: Array<{ asset: number; amount: bigint }>;
  outputs: Array<{ asset: number; amount: bigint }>;
}): DecodedTrade {
  return {
    trader: normalizeAccount(decoded.swapper),
    inputs: decoded.inputs.map(({ asset, amount }) => ({ assetId: asset, amount })),
    outputs: decoded.outputs.map(({ asset, amount }) => ({ assetId: asset, amount })),
  };
}

function priceToDecimal128(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,12}))?$/.exec(value);
  if (match == null) {
    throw new Error(`Invalid non-negative USD price: ${value}`);
  }

  return BigInt(`${match[1]}${(match[2] ?? '').padEnd(12, '0')}`);
}

/**
 * Calculate USD volume from native amount using bigint-only arithmetic
 *
 * Formula: (nativeAmount * price) / (10^(assetDecimals + 12))
 * - nativeAmount: e.g., 1000000000000n for 1 token with 12 decimals
 * - price: e.g., '2.000000000000' (12 decimal places as string)
 * - assetDecimals: token decimals
 * - Output: Decimal128(12) string with 12 decimal places
 *
 * @param nativeAmount - Raw token amount in smallest unit
 * @param assetId - Asset ID for price and decimals lookup
 * @param prices - Map of asset ID to USD price strings
 * @param decimals - Map of asset ID to decimal places
 * @returns USD volume as Decimal128(12) string
 */
export function calculateUsdVolume(
  nativeAmount: bigint,
  assetId: number,
  prices: PriceMap,
  decimals: AssetDecimals
): string {
  // Edge case: zero amount
  if (nativeAmount === 0n) {
    return '0.000000000000';
  }

  // Look up price
  const priceStr = prices.get(assetId);
  if (!priceStr) {
    return '0.000000000000';
  }

  const assetDecimals = decimals.get(assetId);
  if (assetDecimals === undefined) {
    return '0.000000000000';
  }

  // Normalize both compact and fixed-width prices to Decimal128(12).
  const priceBigInt = priceToDecimal128(priceStr);

  // Calculate USD volume: (nativeAmount * priceBigInt) / (10^assetDecimals)
  // This gives us the volume in the same 12-decimal-place scale as the price
  // Example: (1000000000000n * 2000000000000n) / 10^12 = 2000000000000n (2.0 USD with 12 decimals)
  const volumeBigInt = (nativeAmount * priceBigInt) / (10n ** BigInt(assetDecimals));

  // Format as Decimal128(12): split into integer and fractional parts
  const integerPart = volumeBigInt / 1000000000000n;
  const fractionalPart = volumeBigInt % 1000000000000n;

  // Pad fractional part with leading zeros to 12 digits
  const fractionalStr = fractionalPart.toString().padStart(12, '0');

  return `${integerPart}.${fractionalStr}`;
}

/**
 * Convert a decoded swap to two PriceRow entries (sell + buy volumes)
 *
 * Each swap generates exactly 2 rows:
 * 1. assetIn: native_volume_sell + usd_volume_sell (buy volumes = 0)
 * 2. assetOut: native_volume_buy + usd_volume_buy (sell volumes = 0)
 *
 * @param swap - Decoded swap event
 * @param blockHeight - Block height for the rows
 * @param prices - Map of asset ID to USD price
 * @param decimals - Map of asset ID to decimal places
 * @returns Array of exactly 2 PriceRow entries
 */
export function swapToVolumeRows(
  swap: DecodedSwap,
  blockHeight: number,
  prices: PriceMap,
  decimals: AssetDecimals
): PriceRow[] {
  return tradeToVolumeRows(
    {
      inputs: [{ assetId: swap.assetIn, amount: swap.amountIn }],
      outputs: [{ assetId: swap.assetOut, amount: swap.amountOut }],
    },
    blockHeight,
    prices,
    decimals
  );
}

function tradeToVolumeRows(
  trade: DecodedTrade,
  blockHeight: number,
  prices: PriceMap,
  decimals: AssetDecimals,
): PriceRow[] {
  const rows: PriceRow[] = [];
  const { inputs, outputs } = canonicalTradeLegs(trade);
  const outputOriginalsByCanonical = originalsByCanonicalAsset(outputs);
  const inputOriginalsByCanonical = originalsByCanonicalAsset(inputs);

  for (const input of inputs) {
    if (isCanonicalSelfConversion(input, outputOriginalsByCanonical)) {
      continue;
    }

    rows.push({
      asset_id: input.canonicalAssetId,
      block_height: blockHeight,
      usd_price: '0', // Price comes from price rows, not volume rows
      native_volume_sell: input.amount.toString(),
      usd_volume_sell: calculateLegUsdVolume(input, prices, decimals),
      native_volume_buy: '0',
      usd_volume_buy: '0.000000000000',
    });
  }

  for (const output of outputs) {
    if (isCanonicalSelfConversion(output, inputOriginalsByCanonical)) {
      continue;
    }

    rows.push({
      asset_id: output.canonicalAssetId,
      block_height: blockHeight,
      usd_price: '0',
      native_volume_buy: output.amount.toString(),
      usd_volume_buy: calculateLegUsdVolume(output, prices, decimals),
      native_volume_sell: '0',
      usd_volume_sell: '0.000000000000',
    });
  }

  return rows;
}

/**
 * How one per-pallet *Executed event names its two legs.
 *
 * Both AMMs report a fill the same way in every era: the asset ids first, then
 * the amount of the leg the caller FIXED and the amount the pool worked out.
 * A sell fixes the input (`amount` in, `salePrice` out); a buy fixes the output
 * (`amount` out, `buyPrice` in) — which is why the buy variants list `assetOut`
 * before `assetIn`, in the struct fields and in the tuple positions alike.
 *
 * FEES. Both legs are the POOL's two legs, and neither is adjusted for the
 * separate `feeAsset`/`feeAmount` pair, because the fee sits outside them in
 * every era — verified against the token transfers of 9,937 XYK and LBP fills in
 * blocks 1,400,000..2,144,141:
 *   - an XYK sell keeps its fee inside the pool, so both legs equal the transfers;
 *   - an XYK buy has the trader send `buyPrice + feeAmount`, so the input leg is
 *     the pool's share of a larger transfer;
 *   - an LBP fill pays its fee as a third transfer to the pool's feeCollector, so
 *     again both legs equal their own transfers.
 * In all three the traded volume is the pool leg, which is what these fields hold.
 */
type LegacySwapShape = 'sell' | 'buy';

interface LegacySwapFields {
  who: unknown;
  assetIn: number;
  assetOut: number;
  amountIn: bigint;
  amountOut: bigint;
}

interface LegacyCodec {
  is(event: EventLike): boolean;
  decode(event: EventLike): unknown;
}

/**
 * Named-struct eras (v55 onward): the field names say everything.
 */
function fieldsFromStruct(shape: LegacySwapShape, decoded: Record<string, unknown>): LegacySwapFields {
  return shape === 'sell'
    ? {
        who: decoded.who,
        assetIn: Number(decoded.assetIn),
        assetOut: Number(decoded.assetOut),
        amountIn: BigInt(decoded.amount as bigint),
        amountOut: BigInt(decoded.salePrice as bigint),
      }
    : {
        who: decoded.who,
        assetIn: Number(decoded.assetIn),
        assetOut: Number(decoded.assetOut),
        amountIn: BigInt(decoded.buyPrice as bigint),
        amountOut: BigInt(decoded.amount as bigint),
      };
}

/**
 * Positional-tuple eras (XYK v16/v19, LBP v16). The runtime's own doc comments
 * give the order, and the two differ in the ASSET pair only:
 *   SellExecuted [who, asset in,  asset out, amount, sale price, fee asset, fee amount, (pool)]
 *   BuyExecuted  [who, asset out, asset in,  amount, buy price,  fee asset, fee amount, (pool)]
 * XYK's v19 tuple appends the pool account; LBP never grew one. The trailing
 * element is irrelevant to volume, so both tuple lengths read identically here.
 */
function fieldsFromTuple(shape: LegacySwapShape, decoded: readonly unknown[]): LegacySwapFields {
  const [who, firstAsset, secondAsset, amount, price] = decoded;
  return shape === 'sell'
    ? {
        who,
        assetIn: Number(firstAsset),
        assetOut: Number(secondAsset),
        amountIn: BigInt(amount as bigint),
        amountOut: BigInt(price as bigint),
      }
    : {
        who,
        assetIn: Number(secondAsset),
        assetOut: Number(firstAsset),
        amountIn: BigInt(price as bigint),
        amountOut: BigInt(amount as bigint),
      };
}

/**
 * Every per-pallet swap codec, newest shape first. Selection is by `.is(event)`,
 * which probes the block's own metadata — the ordering only decides which of two
 * genuinely-matching shapes wins, and no two of these ever match the same block.
 *
 * The tuple entries have never fired on Basilisk: the first XYK pool is created
 * at spec 65 and the first LBP pool at spec 76, both long after v55 turned these
 * events into named structs (see BASILISK_FIRST_SEEN in src/chainEras.ts). They
 * are decoded anyway because the metadata of blocks 0..1,322,822 declares them,
 * and the alternative to decoding a shape a block may legally carry is dropping
 * a trade on the floor.
 */
const LEGACY_SWAP_CODECS: Record<string, Array<{ codec: LegacyCodec; shape: LegacySwapShape; tuple: boolean }>> = {
  'XYK.SellExecuted': [
    { codec: xyk.sellExecuted.v55, shape: 'sell', tuple: false },
    { codec: xyk.sellExecuted.v19, shape: 'sell', tuple: true },
    { codec: xyk.sellExecuted.v16, shape: 'sell', tuple: true },
  ],
  'XYK.BuyExecuted': [
    { codec: xyk.buyExecuted.v55, shape: 'buy', tuple: false },
    { codec: xyk.buyExecuted.v19, shape: 'buy', tuple: true },
    { codec: xyk.buyExecuted.v16, shape: 'buy', tuple: true },
  ],
  'LBP.SellExecuted': [
    { codec: lbp.sellExecuted.v55, shape: 'sell', tuple: false },
    { codec: lbp.sellExecuted.v16, shape: 'sell', tuple: true },
  ],
  'LBP.BuyExecuted': [
    { codec: lbp.buyExecuted.v55, shape: 'buy', tuple: false },
    { codec: lbp.buyExecuted.v16, shape: 'buy', tuple: true },
  ],
};

/**
 * The one event whose two amounts are reported against the wrong legs.
 *
 * pallet-lbp's `buy` emits BuyExecuted with the amount PAID where the amount
 * BOUGHT belongs and vice versa. Every one of the 104 LBP.BuyExecuted events in
 * blocks 1,400,000..2,144,141 reads that way against the transfers of its own
 * extrinsic; e.g. block 1,974,221 reports assetIn 1, assetOut 6, amount
 * 91,758,683,241, buyPrice 1,000,000,000,000, while the transfers move
 * 91,758,683,241 of asset 1 from trader to pool and 1,000,000,000,000 of asset 6
 * back — a round 1e12 target, which is what a `buy` call names. Its sibling
 * LBP.SellExecuted (1,329 fills) and both XYK events (8,504 fills) are reported
 * correctly, so this is one emit site, not a family trait.
 *
 * This is the same inversion Broadcast reports for exact-out XYK/LBP fills (see
 * correctedBroadcastTrade), which is unsurprising: an LBP buy IS an exact-out
 * fill. The two corrections stay separate because they sit on different events —
 * post-spec-124 blocks route through Broadcast and never reach this table.
 */
const AMOUNT_INVERTED_LEGACY_EVENTS = new Set(['LBP.BuyExecuted']);

/**
 * Decode a per-pallet XYK or LBP swap event using version-guarded typegen codecs.
 *
 * @param event - Event-like object with name, block, and args
 * @returns DecodedSwap or null if event is not a swap or decoding fails
 */
function decodeSwapEvent(event: EventLike): DecodedSwap | null {
  const bindings = LEGACY_SWAP_CODECS[event.name];
  if (bindings == null) {
    return null;
  }

  try {
    for (const { codec, shape, tuple } of bindings) {
      if (!codec.is(event)) continue;
      const decoded = codec.decode(event);
      const fields = tuple
        ? fieldsFromTuple(shape, decoded as readonly unknown[])
        : fieldsFromStruct(shape, decoded as Record<string, unknown>);
      const inverted = AMOUNT_INVERTED_LEGACY_EVENTS.has(event.name);
      return {
        trader: normalizeAccount(fields.who),
        assetIn: fields.assetIn,
        assetOut: fields.assetOut,
        amountIn: inverted ? fields.amountOut : fields.amountIn,
        amountOut: inverted ? fields.amountIn : fields.amountOut,
      };
    }

    console.warn(`[extractVolume] Unable to decode swap event: ${event.name} (no matching version)`);
    return null;
  } catch (error) {
    console.warn(`[extractVolume] Error decoding swap event ${event.name}:`, error);
    return null;
  }
}

function decodeTradeEvent(event: EventLike): DecodedTrade | null {
  const legacySwap = decodeSwapEvent(event);
  if (legacySwap) {
    return {
      trader: legacySwap.trader,
      inputs: [{ assetId: legacySwap.assetIn, amount: legacySwap.amountIn }],
      outputs: [{ assetId: legacySwap.assetOut, amount: legacySwap.amountOut }],
    };
  }

  const { name } = event;

  try {
    // Basilisk's Broadcast pallet emits `Swapped` from spec 124 (block 8,374,452)
    // and `Swapped3` from spec 128 (block 12,663,601). It never had a `Swapped2`.
    if (name === 'Broadcast.Swapped' && broadcast.swapped.v124.is(event)) {
      return correctedBroadcastTrade(broadcast.swapped.v124.decode(event));
    }

    if (name === 'Broadcast.Swapped3' && broadcast.swapped3.v128.is(event)) {
      return correctedBroadcastTrade(broadcast.swapped3.v128.decode(event));
    }

    console.warn(`[extractVolume] Unable to decode swap event: ${name} (no matching version)`);
    return null;
  } catch (error) {
    console.warn(`[extractVolume] Error decoding swap event ${name}:`, error);
    return null;
  }
}

/**
 * Decode a Broadcast swap event, undoing the exact-out XYK/LBP amount inversion.
 *
 * A Basilisk exact-out XYK fill reports the two amounts against the wrong legs:
 * the input leg carries the amount received and the output leg the amount paid.
 * Verified against the XYK.BuyExecuted emitted beside it at block 12,668,315
 * (spec 128), where Broadcast.Swapped3 reads
 *   inputs [{asset 0 (BSX), 18_298_693_290_747}]
 *   outputs [{asset 1 (KSM), 7_235_359_533_940_195_064}]
 * while XYK.BuyExecuted reads assetIn 0, assetOut 1, buyPrice (paid)
 * 7_235_359_533_940_195_064, amount (received) 18_298_693_290_747 — 7.24M BSX
 * paid for 18.3 KSM, which is also what the pool reserves and the 0.3% BSX fee
 * of 21_706 BSX say.
 *
 * Unlike Hydration, Basilisk never shipped the `Swapped2` runtime that carried
 * the upstream fix: it renamed `Swapped` straight to `Swapped3` at spec 128 and
 * kept the inversion, despite the doc comment the rename inherited. The event
 * definition is unchanged from spec 128 through 134 (typegen emits one codec for
 * the whole span), so the correction applies to both names. Exact-in fills are
 * reported correctly and are left alone.
 */
function correctedBroadcastTrade(decoded: {
  swapper: unknown;
  fillerType: { __kind: string };
  operation: { __kind: string };
  inputs: Array<{ asset: number; amount: bigint }>;
  outputs: Array<{ asset: number; amount: bigint }>;
}): DecodedTrade {
  const trade = broadcastTrade(decoded);
  const { inputs, outputs } = trade;

  if (
    decoded.operation.__kind === 'ExactOut' &&
    (decoded.fillerType.__kind === 'XYK' || decoded.fillerType.__kind === 'LBP') &&
    inputs.length === 1 &&
    outputs.length === 1
  ) {
    return {
      trader: trade.trader,
      inputs: [{ assetId: inputs[0].assetId, amount: outputs[0].amount }],
      outputs: [{ assetId: outputs[0].assetId, amount: inputs[0].amount }],
    };
  }

  return trade;
}

/**
 * Extract volume rows from all swap events in a block
 *
 * Filters events using swap event registry, decodes each swap,
 * and generates bidirectional volume rows.
 *
 * @param events - All events from a block
 * @param blockHeight - Block height for volume rows
 * @param prices - Map of asset ID to USD price
 * @param decimals - Map of asset ID to decimal places
 * @returns Array of volume PriceRow entries (2 per swap)
 */
export function extractVolumeFromSwaps(
  events: Array<EventLike>,
  blockHeight: number,
  specVersion: number,
  prices: PriceMap,
  decimals: AssetDecimals,
): PriceRow[] {
  const volumeRows: PriceRow[] = [];

  for (const event of events) {
    // Filter to swap events only
    if (!isSwapEvent(event.name, specVersion)) {
      continue;
    }

    // Decode swap event
    const trade = decodeTradeEvent(event);
    if (!trade) {
      console.warn(`[extractVolume] Skipping event ${event.name} at block ${blockHeight} (decode failed)`);
      continue;
    }

    // Generate volume rows from all input and output asset legs
    const rows = tradeToVolumeRows(trade, blockHeight, prices, decimals);
    volumeRows.push(...rows);
  }

  return volumeRows;
}

function tradeToAccountVolumeRows(
  trade: DecodedTrade,
  blockHeight: number,
  prices: PriceMap,
  decimals: AssetDecimals,
): TradeVolumeRow[] {
  const account = normalizeAccount(trade.trader);
  if (!account) {
    return [];
  }

  const rowsByAsset = new Map<number, TradeVolumeRow>();
  const { inputs, outputs } = canonicalTradeLegs(trade);
  const outputOriginalsByCanonical = originalsByCanonicalAsset(outputs);
  const inputOriginalsByCanonical = originalsByCanonicalAsset(inputs);

  const rowForAsset = (assetId: number): TradeVolumeRow => {
    let row = rowsByAsset.get(assetId);
    if (!row) {
      row = {
        asset_id: assetId,
        block_height: blockHeight,
        account,
        native_volume_buy: '0',
        native_volume_sell: '0',
        usd_volume_buy: '0.000000000000',
        usd_volume_sell: '0.000000000000',
        trade_count: 1,
      };
      rowsByAsset.set(assetId, row);
    }
    return row;
  };

  for (const input of inputs) {
    if (isCanonicalSelfConversion(input, outputOriginalsByCanonical)) {
      continue;
    }

    const row = rowForAsset(input.canonicalAssetId);
    row.native_volume_sell = sumBigIntStrings(row.native_volume_sell ?? '0', input.amount.toString());
    row.usd_volume_sell = sumDecimal128Strings(
      row.usd_volume_sell ?? '0.000000000000',
      calculateLegUsdVolume(input, prices, decimals)
    );
  }

  for (const output of outputs) {
    if (isCanonicalSelfConversion(output, inputOriginalsByCanonical)) {
      continue;
    }

    const row = rowForAsset(output.canonicalAssetId);
    row.native_volume_buy = sumBigIntStrings(row.native_volume_buy ?? '0', output.amount.toString());
    row.usd_volume_buy = sumDecimal128Strings(
      row.usd_volume_buy ?? '0.000000000000',
      calculateLegUsdVolume(output, prices, decimals)
    );
  }

  return Array.from(rowsByAsset.values());
}

/**
 * Extract per-account trade volume from all swap events in a block.
 *
 * This mirrors extractVolumeFromSwaps but preserves the trader account so
 * candles can expose Omniwatch-style top trader and contributor details.
 */
export function extractTradeVolumeFromSwaps(
  events: Array<EventLike>,
  blockHeight: number,
  specVersion: number,
  prices: PriceMap,
  decimals: AssetDecimals,
): TradeVolumeRow[] {
  const tradeRows: TradeVolumeRow[] = [];

  for (const event of events) {
    if (!isSwapEvent(event.name, specVersion)) {
      continue;
    }

    const trade = decodeTradeEvent(event);
    if (!trade) {
      continue;
    }

    tradeRows.push(...tradeToAccountVolumeRows(trade, blockHeight, prices, decimals));
  }

  return aggregateTradeVolumeRows(tradeRows);
}

/**
 * Merge price rows and volume rows
 *
 * Logic:
 * 1. Aggregate volumeRows by asset_id (sum all 4 volume fields)
 * 2. For each aggregated volume entry:
 *    - If price row exists for that asset: merge volume into price row
 *    - Otherwise: add volume row as standalone
 * 3. Return all rows (price+volume merged + standalone price + standalone volume)
 *
 * Volume summing uses bigint arithmetic for native volumes and decimal string
 * arithmetic for USD volumes (convert to bigint, sum, reformat).
 *
 * @param priceRows - Price rows from price calculation
 * @param volumeRows - Volume rows from swap events
 * @returns Merged PriceRow array
 */
export function mergePriceAndVolumeRows(
  priceRows: PriceRow[],
  volumeRows: PriceRow[]
): PriceRow[] {
  // Edge case: no volumes
  if (volumeRows.length === 0) {
    return priceRows;
  }

  // Edge case: no prices
  if (priceRows.length === 0) {
    // Still need to aggregate volumes by asset_id
    return aggregateVolumeRows(volumeRows);
  }

  // Aggregate volumes by asset_id
  const aggregatedVolumes = aggregateVolumeRows(volumeRows);

  // Create a map of aggregated volumes by asset_id for quick lookup
  const volumeMap = new Map<number, PriceRow>();
  for (const row of aggregatedVolumes) {
    volumeMap.set(row.asset_id, row);
  }

  // Process price rows first (preserves price row order)
  const result: PriceRow[] = [];
  const processedAssetIds = new Set<number>();

  for (const priceRow of priceRows) {
    const volumeRow = volumeMap.get(priceRow.asset_id);

    if (volumeRow) {
      // Merge volume into existing price row
      result.push({
        ...priceRow,
        native_volume_sell: volumeRow.native_volume_sell,
        usd_volume_sell: volumeRow.usd_volume_sell,
        native_volume_buy: volumeRow.native_volume_buy,
        usd_volume_buy: volumeRow.usd_volume_buy,
      });
      processedAssetIds.add(priceRow.asset_id);
    } else {
      // Standalone price row (no matching volume)
      result.push(priceRow);
    }
  }

  // Add standalone volume rows (no matching price)
  for (const volumeRow of aggregatedVolumes) {
    if (!processedAssetIds.has(volumeRow.asset_id)) {
      result.push(volumeRow);
    }
  }

  return result;
}

/**
 * Aggregate multiple volume rows by asset_id (sum all volume fields)
 *
 * Helper for mergePriceAndVolumeRows. Handles multiple swaps for the same
 * asset in a single block by summing volumes.
 *
 * @param volumeRows - Volume rows to aggregate
 * @returns Aggregated volume rows (one per unique asset_id)
 */
function aggregateVolumeRows(volumeRows: PriceRow[]): PriceRow[] {
  const aggregated = new Map<number, PriceRow>();

  for (const row of volumeRows) {
    const existing = aggregated.get(row.asset_id);

    if (existing) {
      aggregated.set(row.asset_id, {
        ...existing,
        ...sumVolumeFields(existing, row),
      });
    } else {
      // First entry for this asset
      aggregated.set(row.asset_id, { ...row });
    }
  }

  return Array.from(aggregated.values());
}
