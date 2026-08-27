import type { XYKPool, AssetDecimals, PriceMap, GraphEdge, QueueEntry, ResolvedPrices } from './types.ts';

const PRICE_24_SCALE = 10n ** 24n;
const USD_LIQUIDITY_SCALE = 10n ** 18n;
const UNBOUNDED_PATH_LIQUIDITY = 10n ** 60n;
const DEFAULT_MAX_OBSERVATIONS_PER_ASSET = 64;

export interface ResolvePriceOptions {
  minGraphPathLiquidityUsd?: number | bigint
  maxObservationsPerAsset?: number
  // The assets allowed to carry a USD price. The graph reaches far further than
  // this — a seed propagates across every pool within MAX_HOPS — so the list is
  // what decides which of those derived numbers is a price the platform stands
  // behind and which is a number it refuses to publish. Omit for no restriction.
  pricedAssetIds?: number[]
}

interface PricePathObservation {
  priceBigint: bigint
  hopCount: number
  pathLiquidityUsd: bigint
  path: number[]
}

interface PathQueueEntry extends PricePathObservation {
  assetId: number
}

function normalizeReserve(reserve: bigint, assetId: number, decimals: AssetDecimals): bigint {
  const assetDecimals = decimals.get(assetId) ?? 12;
  if (assetDecimals === 18) return reserve;
  if (assetDecimals < 18) {
    return reserve * (10n ** BigInt(18 - assetDecimals));
  }
  return reserve / (10n ** BigInt(assetDecimals - 18));
}

function minBigint(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function maxBigint(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function usdValue18(normalizedReserve: bigint, price24: bigint): bigint {
  return (normalizedReserve * price24) / PRICE_24_SCALE;
}

function conservativePoolLiquidityUsd(
  knownNormalizedReserve: bigint,
  unknownNormalizedReserve: bigint,
  knownPrice24: bigint,
  computedPrice24: bigint,
): bigint {
  const knownSideUsd = usdValue18(knownNormalizedReserve, knownPrice24);
  const unknownSideUsd = usdValue18(unknownNormalizedReserve, computedPrice24);
  return minBigint(knownSideUsd, unknownSideUsd);
}

function usdThresholdTo18(value: number | bigint | undefined): bigint {
  if (value == null) return 0n;
  if (typeof value === 'bigint') return value <= 0n ? 0n : value * USD_LIQUIDITY_SCALE;
  if (!Number.isFinite(value) || value <= 0) return 0n;
  return BigInt(Math.trunc(value)) * USD_LIQUIDITY_SCALE;
}

function weightedMedianPathObservation(observations: PricePathObservation[]): PricePathObservation | null {
  if (observations.length === 0) {
    return null;
  }

  const sorted = [...observations].sort((left, right) => {
    if (left.priceBigint < right.priceBigint) return -1;
    if (left.priceBigint > right.priceBigint) return 1;
    if (left.hopCount !== right.hopCount) return left.hopCount - right.hopCount;
    if (left.pathLiquidityUsd !== right.pathLiquidityUsd) {
      return left.pathLiquidityUsd > right.pathLiquidityUsd ? -1 : 1;
    }
    return 0;
  });

  let totalWeight = 0n;
  for (const observation of sorted) {
    totalWeight += maxBigint(observation.pathLiquidityUsd, 1n);
  }

  const threshold = (totalWeight + 1n) / 2n;
  let runningWeight = 0n;
  for (const observation of sorted) {
    runningWeight += maxBigint(observation.pathLiquidityUsd, 1n);
    if (runningWeight >= threshold) {
      return observation;
    }
  }

  return sorted[sorted.length - 1];
}

const MAX_HOPS = 3;
const BFS_PRECISION = 24;

// Multi-source BFS from the anchored assets outward to resolve unpriced assets.
// seeds: Map of assetId -> 24-decimal bigint price.
// anchoredAssets: Guard set — BFS must not override these prices.
// graph: Bidirectional adjacency map from buildGraph().
// maxHops: Maximum pool crossings (default 3).
export function bfsResolvePrices(
  seeds: Map<number, bigint>,
  anchoredAssets: Set<number>,
  graph: Map<number, GraphEdge[]>,
  maxHops: number = MAX_HOPS
): Map<number, { priceBigint: bigint; hopCount: number }> {
  const resolved = new Map<number, { priceBigint: bigint; hopCount: number }>();

  // Seed all anchored assets at depth 0
  const queue: QueueEntry[] = [];
  for (const [assetId, price] of seeds) {
    resolved.set(assetId, { priceBigint: price, hopCount: 0 });
    queue.push({ assetId, priceBigint: price, hopCount: 0 });
  }

  let head = 0;
  while (head < queue.length) {
    const { assetId, priceBigint, hopCount } = queue[head++];

    const edges = graph.get(assetId) ?? [];
    // Edges are pre-sorted by liquidity desc from buildGraph()

    for (const edge of edges) {
      // Anchor prices remain authoritative.
      if (anchoredAssets.has(edge.toAsset)) continue;
      // First-arrival wins (edges sorted by liquidity, so best path wins)
      if (resolved.has(edge.toAsset)) continue;

      const nextHopCount = hopCount + 1;
      // Limit the number of pool crossings.
      if (nextHopCount > maxHops) continue;

      const nextPrice = edge.computePrice(priceBigint, BFS_PRECISION);
      if (nextPrice === 0n) continue;

      resolved.set(edge.toAsset, { priceBigint: nextPrice, hopCount: nextHopCount });
      queue.push({ assetId: edge.toAsset, priceBigint: nextPrice, hopCount: nextHopCount });
    }
  }

  return resolved;
}

export function resolveGraphPricesByWeightedMedian(
  seeds: Map<number, bigint>,
  anchoredAssets: Set<number>,
  graph: Map<number, GraphEdge[]>,
  options: ResolvePriceOptions = {},
  maxHops: number = MAX_HOPS,
): Map<number, { priceBigint: bigint; hopCount: number; pathLiquidityUsd: bigint }> {
  const minPathLiquidityUsd = usdThresholdTo18(options.minGraphPathLiquidityUsd);
  const maxObservationsPerAsset = Math.max(1, options.maxObservationsPerAsset ?? DEFAULT_MAX_OBSERVATIONS_PER_ASSET);
  const observations = new Map<number, PricePathObservation[]>();
  const observationKeys = new Map<number, Map<string, PricePathObservation>>();
  const queue: PathQueueEntry[] = [];

  for (const [assetId, price] of seeds) {
    queue.push({
      assetId,
      priceBigint: price,
      hopCount: 0,
      pathLiquidityUsd: UNBOUNDED_PATH_LIQUIDITY,
      path: [assetId],
    });
  }

  const addObservation = (assetId: number, observation: PricePathObservation): boolean => {
    let list = observations.get(assetId);
    if (!list) {
      list = [];
      observations.set(assetId, list);
    }
    let keyed = observationKeys.get(assetId);
    if (!keyed) {
      keyed = new Map();
      observationKeys.set(assetId, keyed);
    }

    const key = `${observation.priceBigint}:${observation.hopCount}:${observation.path.join(',')}`;
    const existing = keyed.get(key);
    if (existing) {
      existing.pathLiquidityUsd += observation.pathLiquidityUsd;
      return false;
    }

    list.push(observation);
    keyed.set(key, observation);
    list.sort((left, right) => {
      if (left.pathLiquidityUsd !== right.pathLiquidityUsd) {
        return left.pathLiquidityUsd > right.pathLiquidityUsd ? -1 : 1;
      }
      if (left.hopCount !== right.hopCount) return left.hopCount - right.hopCount;
      if (left.priceBigint < right.priceBigint) return -1;
      if (left.priceBigint > right.priceBigint) return 1;
      return 0;
    });

    if (list.length > maxObservationsPerAsset) {
      const removed = list.splice(maxObservationsPerAsset);
      for (const item of removed) {
        keyed.delete(`${item.priceBigint}:${item.hopCount}:${item.path.join(',')}`);
      }
      return !removed.includes(observation);
    }

    return true;
  };

  let head = 0;
  while (head < queue.length) {
    const entry = queue[head++];
    const edges = graph.get(entry.assetId) ?? [];

    for (const edge of edges) {
      if (anchoredAssets.has(edge.toAsset)) continue;
      if (entry.path.includes(edge.toAsset)) continue;

      const nextHopCount = entry.hopCount + 1;
      if (nextHopCount > maxHops) continue;

      const nextPrice = edge.computePrice(entry.priceBigint, BFS_PRECISION);
      if (nextPrice === 0n) continue;

      const edgeLiquidityUsd = edge.computeLiquidityUsd
        ? edge.computeLiquidityUsd(entry.priceBigint, nextPrice)
        : UNBOUNDED_PATH_LIQUIDITY;
      const nextPathLiquidityUsd = minBigint(entry.pathLiquidityUsd, edgeLiquidityUsd);
      if (nextPathLiquidityUsd < minPathLiquidityUsd) continue;

      const observation: PricePathObservation = {
        priceBigint: nextPrice,
        hopCount: nextHopCount,
        pathLiquidityUsd: nextPathLiquidityUsd,
        path: [...entry.path, edge.toAsset],
      };

      if (addObservation(edge.toAsset, observation)) {
        queue.push({ assetId: edge.toAsset, ...observation });
      }
    }
  }

  const resolved = new Map<number, { priceBigint: bigint; hopCount: number; pathLiquidityUsd: bigint }>();
  for (const [assetId, assetObservations] of observations.entries()) {
    const selected = weightedMedianPathObservation(assetObservations);
    if (!selected) continue;
    resolved.set(assetId, {
      priceBigint: selected.priceBigint,
      hopCount: selected.hopCount,
      pathLiquidityUsd: selected.pathLiquidityUsd,
    });
  }

  for (const [assetId, price] of seeds) {
    resolved.set(assetId, {
      priceBigint: price,
      hopCount: 0,
      pathLiquidityUsd: UNBOUNDED_PATH_LIQUIDITY,
    });
  }

  return resolved;
}

export function collectUnpricedConnectedAssets(
  graph: Map<number, GraphEdge[]>,
  prices: PriceMap,
  pricedAssetIds?: number[],
): number[] {
  // With a whitelist the interesting gap is a whitelisted asset the graph could
  // not reach — BSX before the BSX/KSM pool exists, say. Reporting every asset
  // the platform declines to price would be a per-block list of the whole book.
  const candidates = pricedAssetIds != null
    ? pricedAssetIds.filter(assetId => graph.has(assetId))
    : [...graph.keys()];
  return candidates.filter(assetId => !prices.has(assetId)).sort((a, b) => a - b);
}

/**
 * The write boundary: drop every price the platform does not publish.
 *
 * `resolvePrices` runs the full graph expansion because that is how the anchor
 * reaches BSX, but only the whitelisted ids leave this module. Nothing
 * downstream — price rows, USD volume legs, OHLC — can then value an asset the
 * model does not claim to price.
 */
export function restrictToPricedAssets(prices: PriceMap, pricedAssetIds: number[]): PriceMap {
  const allowed = new Set(pricedAssetIds);
  const restricted: PriceMap = new Map();
  for (const [assetId, price] of prices) {
    if (allowed.has(assetId)) restricted.set(assetId, price);
  }
  return restricted;
}

// Convert 12-decimal price string to 24-decimal bigint for BFS intermediate math
export function priceTo24(priceStr: string): bigint {
  const [intPart, decPart = ''] = priceStr.split('.');
  const digits = intPart + decPart.padEnd(12, '0');
  return BigInt(digits) * (10n ** 12n);
}

// Convert 24-decimal bigint to 12-decimal price string for PriceMap storage
export function price24ToString(p: bigint): string {
  const truncated = p / (10n ** 12n);
  const s = truncated.toString().padStart(13, '0');
  return `${s.slice(0, -12) || '0'}.${s.slice(-12)}`;
}

export function buildGraph(
  xykPools: XYKPool[],
  decimals: AssetDecimals,
): Map<number, GraphEdge[]> {
  const graph = new Map<number, GraphEdge[]>();

  const addEdge = (from: number, edge: GraphEdge) => {
    if (!graph.has(from)) graph.set(from, []);
    graph.get(from)!.push(edge);
  };

  // XYK pool edges (bidirectional)
  for (const pool of xykPools) {
    if (pool.reserveA === 0n || pool.reserveB === 0n) continue;

    const decimalsA = decimals.get(pool.assetA);
    const decimalsB = decimals.get(pool.assetB);
    if (decimalsA === undefined || decimalsB === undefined) continue;

    // Normalize reserves to 18 decimals for liquidity comparison
    const normA = normalizeReserve(pool.reserveA, pool.assetA, decimals);
    const normB = normalizeReserve(pool.reserveB, pool.assetB, decimals);
    const liquidity = normA + normB;

    // Edge: assetA -> assetB (knowing A's price, compute B's)
    addEdge(pool.assetA, {
      toAsset: pool.assetB,
      poolId: null,
      kind: 'xyk',
      liquidity,
      computePrice: (knownPrice: bigint, _precision: number): bigint => {
        if (pool.reserveA === 0n || pool.reserveB === 0n) return 0n;
        const knownScale = 10n ** BigInt(decimalsA);
        const unknownScale = 10n ** BigInt(decimalsB);
        return (pool.reserveA * unknownScale * knownPrice) / (pool.reserveB * knownScale);
      },
      computeLiquidityUsd: (knownPrice: bigint, computedPrice: bigint): bigint =>
        conservativePoolLiquidityUsd(normA, normB, knownPrice, computedPrice),
    });

    // Edge: assetB -> assetA (knowing B's price, compute A's)
    addEdge(pool.assetB, {
      toAsset: pool.assetA,
      poolId: null,
      kind: 'xyk',
      liquidity,
      computePrice: (knownPrice: bigint, _precision: number): bigint => {
        if (pool.reserveA === 0n || pool.reserveB === 0n) return 0n;
        const knownScale = 10n ** BigInt(decimalsB);
        const unknownScale = 10n ** BigInt(decimalsA);
        return (pool.reserveB * unknownScale * knownPrice) / (pool.reserveA * knownScale);
      },
      computeLiquidityUsd: (knownPrice: bigint, computedPrice: bigint): bigint =>
        conservativePoolLiquidityUsd(normB, normA, knownPrice, computedPrice),
    });
  }

  // Sort each adjacency list by liquidity desc
  for (const edges of graph.values()) {
    edges.sort((a, b) => {
      if (b.liquidity === a.liquidity) return 0;
      return b.liquidity > a.liquidity ? 1 : -1;
    });
  }

  return graph;
}

// Resolve asset prices denominated in USD.
//
// Strategy:
// 1. Anchor the seed assets at their externally referenced prices. On Basilisk
//    that is one asset — KSM, at the day's stored KSM/USD close (see
//    src/price/reference.ts). There is no stable-coin basket to stand on: the
//    chain's USD-quoted venues are too quiet to price anything off.
// 2. Expand outward across the XYK graph, taking a liquidity-weighted median
//    over every path reaching an asset. BSX is one hop from the anchor, through
//    the BSX/KSM pool's reserve ratio.
// 3. Keep only the prices this platform publishes (`options.pricedAssetIds`).
export function resolvePrices(
  xykPools: XYKPool[],
  decimals: AssetDecimals,
  seedPrices: PriceMap,
  options: ResolvePriceOptions = {},
): ResolvedPrices {
  const prices = new Map<number, string>();
  const hopCounts = new Map<number, number>();

  for (const [assetId, price] of seedPrices) {
    prices.set(assetId, price);
    hopCounts.set(assetId, 0);
  }

  // Anchored assets keep their reference price through graph expansion.
  const anchoredAssets = new Set(prices.keys());

  const graph = buildGraph(xykPools, decimals);

  // Convert anchor prices from 12-decimal strings to 24-decimal bigints
  const seeds = new Map<number, bigint>();
  for (const [assetId, priceStr] of prices) {
    seeds.set(assetId, priceTo24(priceStr));
  }

  // Multi-source weighted observations from all priced assets outward
  const bfsResults = resolveGraphPricesByWeightedMedian(seeds, anchoredAssets, graph, options);

  // Write BFS-resolved prices to PriceMap (12-decimal strings)
  for (const [assetId, { priceBigint, hopCount }] of bfsResults) {
    if (!anchoredAssets.has(assetId) && !prices.has(assetId)) {
      prices.set(assetId, price24ToString(priceBigint));
      hopCounts.set(assetId, hopCount);
    }
  }

  // Collect unpriced assets that have pool connections in the graph
  const unpricedConnected = collectUnpricedConnectedAssets(graph, prices, options.pricedAssetIds);

  if (options.pricedAssetIds == null) return { prices, hopCounts, unpricedConnected };

  const published = restrictToPricedAssets(prices, options.pricedAssetIds);
  const publishedHops = new Map<number, number>();
  for (const assetId of published.keys()) publishedHops.set(assetId, hopCounts.get(assetId) ?? 0);
  return { prices: published, hopCounts: publishedHops, unpricedConnected };
}
