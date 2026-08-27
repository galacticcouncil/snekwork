/**
 * XYK constant product pool
 */
export interface XYKPool {
  assetA: number;
  assetB: number;
  reserveA: bigint;
  reserveB: bigint;
}

/**
 * Map of asset ID to decimal places
 */
export type AssetDecimals = Map<number, number>;

/**
 * Map of asset ID to USD price (as decimal string with 12 precision)
 */
export type PriceMap = Map<number, string>;

export type EdgeKind = 'xyk';

export interface GraphEdge {
  toAsset: number;
  poolId: number | null;
  kind: EdgeKind;
  liquidity: bigint;            // For tie-breaking: normalized reserve sum
  computePrice: (knownPrice: bigint, precision: number) => bigint;
  computeLiquidityUsd?: (knownPrice: bigint, computedPrice: bigint) => bigint;
}

export interface QueueEntry {
  assetId: number;
  priceBigint: bigint;   // 24-decimal internal representation
  hopCount: number;       // real pool crossings
}

export interface ResolvedPrices {
  prices: PriceMap;
  hopCounts: Map<number, number>;
  unpricedConnected: number[];
}
