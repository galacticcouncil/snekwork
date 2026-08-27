import { describe, it, expect } from 'vitest';
import {
  resolvePrices,
  priceTo24,
  price24ToString,
  buildGraph,
  bfsResolvePrices,
  resolveGraphPricesByWeightedMedian,
  collectUnpricedConnectedAssets,
} from '../../src/price/graph.ts';
import type { XYKPool, AssetDecimals, PriceMap, GraphEdge } from '../../src/price/types.ts';

describe('priceTo24', () => {
  it('converts "1.000000000000" to 10^24', () => {
    expect(priceTo24('1.000000000000')).toBe(1000000000000000000000000n);
  });

  it('converts "50.000000000000" to 50 * 10^24', () => {
    expect(priceTo24('50.000000000000')).toBe(50000000000000000000000000n);
  });

  it('converts "0.500000000000" to 0.5 * 10^24', () => {
    expect(priceTo24('0.500000000000')).toBe(500000000000000000000000n);
  });

  it('converts "0.020000000000" correctly', () => {
    expect(priceTo24('0.020000000000')).toBe(20000000000000000000000n);
  });
});

describe('price24ToString', () => {
  it('converts 10^24 to "1.000000000000"', () => {
    expect(price24ToString(1000000000000000000000000n)).toBe('1.000000000000');
  });

  it('converts 50 * 10^24 to "50.000000000000"', () => {
    expect(price24ToString(50000000000000000000000000n)).toBe('50.000000000000');
  });

  it('converts 0n to "0.000000000000"', () => {
    expect(price24ToString(0n)).toBe('0.000000000000');
  });

  it('roundtrips a range of inputs', () => {
    for (const input of ['1.000000000000', '50.000000000000', '0.020000000000']) {
      expect(price24ToString(priceTo24(input))).toBe(input);
    }
  });
});

// The graph tests below exercise expansion mechanics, so they seed a synthetic
// $1 anchor. Basilisk's real seed is a single asset — KSM at the day's stored
// reference price — and is covered in its own describe further down.
const usdSeed = (ids: number[]): PriceMap => new Map(ids.map(id => [id, '1.000000000000']));

describe('resolvePrices', () => {
  it('seeds every USD reference at $1', () => {
    const { prices } = resolvePrices([], new Map([[10, 6], [22, 6]]), usdSeed([10, 22]));

    expect(prices.size).toBe(2);
    expect(prices.get(10)).toBe('1.000000000000');
    expect(prices.get(22)).toBe('1.000000000000');
  });

  it('handles empty inputs gracefully while preserving the USD reference seed', () => {
    const { prices, unpricedConnected } = resolvePrices([], new Map([[10, 6]]), usdSeed([10]));

    expect(prices.size).toBe(1);
    expect(prices.get(10)).toBe('1.000000000000');
    expect(unpricedConnected).toEqual([]);
  });

  it('resolves iteratively across multiple XYK hops', () => {
    // Chain: USDT(10) -> GLMR(2) -> KSM(4)
    const xykPools: XYKPool[] = [
      { assetA: 10, assetB: 2, reserveA: 1000_000000n, reserveB: 500000_000000000000n },
      { assetA: 2, assetB: 4, reserveA: 50000_000000000000n, reserveB: 200_000000000000n },
    ];
    const decimals = new Map<number, number>([[2, 12], [4, 12], [10, 6]]);

    const { prices } = resolvePrices(xykPools, decimals, usdSeed([10]));

    expect(prices.has(2)).toBe(true);
    expect(prices.has(4)).toBe(true);
    expect(parseFloat(prices.get(2)!)).toBeGreaterThan(0);
    expect(parseFloat(prices.get(4)!)).toBeGreaterThan(0);
  });

  it('caps resolution at 3 hops depth (BFS hop limit)', () => {
    // Chain: USDT(10) -> 100 -> 101 -> 102 -> 103 -> ... -> 114
    const xykPools: XYKPool[] = [];
    for (let i = 0; i < 15; i++) {
      xykPools.push({
        assetA: i === 0 ? 10 : 100 + i - 1,
        assetB: 100 + i,
        reserveA: 1000000000000n,
        reserveB: 1000000000000n,
      });
    }

    const decimals = new Map<number, number>([
      [10, 12],
      ...Array.from({ length: 15 }, (_, i) => [100 + i, 12] as [number, number]),
    ]);

    const { prices } = resolvePrices(xykPools, decimals, usdSeed([10]));

    // USDT(10) + assets 100, 101, 102
    expect(prices.size).toBe(4);
    expect(prices.has(100)).toBe(true);  // depth 1
    expect(prices.has(101)).toBe(true);  // depth 2
    expect(prices.has(102)).toBe(true);  // depth 3
    expect(prices.has(103)).toBe(false); // depth 4 — capped
    expect(prices.has(114)).toBe(false); // depth 15 — far beyond cap
  });

  it('keeps the anchor price when a pool would imply a different one', () => {
    const xykPools: XYKPool[] = [
      { assetA: 10, assetB: 2, reserveA: 500_000000n, reserveB: 5000_000000000000n },
    ];
    const decimals = new Map<number, number>([[10, 6], [2, 12]]);

    const { prices, hopCounts } = resolvePrices(xykPools, decimals, usdSeed([10]));

    expect(prices.get(10)).toBe('1.000000000000');
    expect(hopCounts.get(10)).toBe(0);
    expect(hopCounts.get(2)).toBe(1);
  });

  it('prefers the higher-liquidity of two competing pools', () => {
    const xykPools: XYKPool[] = [
      // Low liquidity: 1 AssetX = 2 USDT
      { assetA: 10, assetB: 99, reserveA: 1000_000000n, reserveB: 500_000000000000n },
      // High liquidity: 1 AssetX = 5 USDT
      { assetA: 10, assetB: 99, reserveA: 10000_000000n, reserveB: 2000_000000000000n },
    ];
    const decimals = new Map<number, number>([[10, 6], [99, 12]]);

    const { prices } = resolvePrices(xykPools, decimals, usdSeed([10]));

    expect(parseFloat(prices.get(99)!)).toBeCloseTo(5, 5);
  });

  it('preserves precision in multi-hop chains across mixed decimals', () => {
    const xykPools: XYKPool[] = [
      // 1 USDT = 1,000,000 AssetA => AssetA = $0.000001
      { assetA: 10, assetB: 50, reserveA: 1000000n, reserveB: 1000000000000000000000000n },
      // 1,000,000 AssetA / 500,000 AssetB => AssetB = 2x AssetA
      { assetA: 50, assetB: 60, reserveA: 1000000000000000000000000n, reserveB: 500000000000000000000000n },
    ];
    const decimals = new Map<number, number>([[10, 6], [50, 18], [60, 18]]);

    const { prices } = resolvePrices(xykPools, decimals, usdSeed([10]));

    const assetAPrice = parseFloat(prices.get(50)!);
    const assetBPrice = parseFloat(prices.get(60)!);
    expect(assetAPrice).toBeGreaterThan(0);
    expect(assetBPrice).toBeCloseTo(assetAPrice * 2, 5);
  });

  it('filters thin graph paths before they price downstream assets', () => {
    const xykPools: XYKPool[] = [
      {
        assetA: 10,
        assetB: 1000081,
        reserveA: 500_000000n,
        reserveB: 1000_000000000000000000n,
      },
      {
        assetA: 1000081,
        assetB: 1007,
        reserveA: 1000_000000000000000000n,
        reserveB: 1_000000000000000000n,
      },
    ];
    const decimals = new Map<number, number>([
      [10, 6],
      [1007, 18],
      [1000081, 18],
    ]);

    const { prices } = resolvePrices(xykPools, decimals, usdSeed([10]), { minGraphPathLiquidityUsd: 12_000 });

    expect(prices.get(10)).toBe('1.000000000000');
    expect(prices.has(1000081)).toBe(false);
    expect(prices.has(1007)).toBe(false);
  });

  it('reports hop counts matching BFS depth', () => {
    const xykPools: XYKPool[] = [
      { assetA: 10, assetB: 100, reserveA: 1000000000000n, reserveB: 1000000000000n },
      { assetA: 100, assetB: 101, reserveA: 1000000000000n, reserveB: 1000000000000n },
      { assetA: 101, assetB: 102, reserveA: 1000000000000n, reserveB: 1000000000000n },
    ];
    const decimals = new Map<number, number>([[10, 12], [100, 12], [101, 12], [102, 12]]);

    const { hopCounts } = resolvePrices(xykPools, decimals, usdSeed([10]));

    expect(hopCounts.get(10)).toBe(0);
    expect(hopCounts.get(100)).toBe(1);
    expect(hopCounts.get(101)).toBe(2);
    expect(hopCounts.get(102)).toBe(3);
  });

  it('reports connected assets it could not price', () => {
    const xykPools: XYKPool[] = [
      { assetA: 500, assetB: 501, reserveA: 1000000000000n, reserveB: 1000000000000n },
    ];
    const decimals = new Map<number, number>([[10, 6], [500, 12], [501, 12]]);

    const { prices, unpricedConnected } = resolvePrices(xykPools, decimals, usdSeed([10]));

    expect(prices.get(10)).toBe('1.000000000000');
    expect(unpricedConnected).toEqual([500, 501]);
  });
});

describe('resolveGraphPricesByWeightedMedian', () => {
  it('uses weighted median across sufficiently liquid graph observations', () => {
    const usd18 = (value: number): bigint => BigInt(value) * (10n ** 18n);
    const graph: Map<number, GraphEdge[]> = new Map([
      [10, [
        {
          toAsset: 99,
          poolId: 1,
          kind: 'xyk',
          liquidity: 1n,
          computePrice: () => priceTo24('1.000000000000'),
          computeLiquidityUsd: () => usd18(1_000),
        },
        {
          toAsset: 99,
          poolId: 2,
          kind: 'xyk',
          liquidity: 1n,
          computePrice: () => priceTo24('1.020000000000'),
          computeLiquidityUsd: () => usd18(3_000),
        },
        {
          toAsset: 99,
          poolId: 3,
          kind: 'xyk',
          liquidity: 1n,
          computePrice: () => priceTo24('10.000000000000'),
          computeLiquidityUsd: () => usd18(1_000),
        },
      ]],
    ]);

    const result = resolveGraphPricesByWeightedMedian(
      new Map([[10, priceTo24('1.000000000000')]]),
      new Set([10]),
      graph,
      { minGraphPathLiquidityUsd: 500 },
    );

    expect(price24ToString(result.get(99)!.priceBigint)).toBe('1.020000000000');
  });
});

describe('buildGraph', () => {
  it('XYK pool produces bidirectional edges with correct toAsset values', () => {
    const xykPools: XYKPool[] = [
      { assetA: 5, assetB: 2, reserveA: 100000000000n, reserveB: 50000000000000000n },
    ];
    const decimals: AssetDecimals = new Map([[5, 10], [2, 12]]);

    const graph = buildGraph(xykPools, decimals);

    expect(graph.size).toBe(2);
    expect(graph.get(5)!.length).toBe(1);
    expect(graph.get(5)![0].toAsset).toBe(2);
    expect(graph.get(2)![0].toAsset).toBe(5);
    expect(graph.get(5)![0].kind).toBe('xyk');
  });

  it('XYK pool with zero reserve is skipped (graph empty)', () => {
    const xykPools: XYKPool[] = [
      { assetA: 5, assetB: 2, reserveA: 0n, reserveB: 50000000000000000n },
    ];
    const decimals: AssetDecimals = new Map([[5, 10], [2, 12]]);

    expect(buildGraph(xykPools, decimals).size).toBe(0);
  });

  it('skips a pool whose asset decimals are unknown', () => {
    const xykPools: XYKPool[] = [
      { assetA: 5, assetB: 2, reserveA: 100000000000n, reserveB: 50000000000000000n },
    ];

    expect(buildGraph(xykPools, new Map([[5, 10]])).size).toBe(0);
  });

  it('edge sorting: higher-liquidity edge appears first in adjacency list', () => {
    const xykPools: XYKPool[] = [
      { assetA: 5, assetB: 2, reserveA: 1000000000000n, reserveB: 1000000000000n },
      { assetA: 5, assetB: 3, reserveA: 100000000000000000n, reserveB: 100000000000000000n },
    ];
    const decimals: AssetDecimals = new Map([[5, 12], [2, 12], [3, 12]]);

    const edges5 = buildGraph(xykPools, decimals).get(5)!;

    expect(edges5.length).toBe(2);
    expect(edges5[0].toAsset).toBe(3);
    expect(edges5[1].toAsset).toBe(2);
  });

  it('XYK computePrice produces correct 24-decimal result across mixed decimals', () => {
    // Pool: 10 DOT (10dec) / 50,000 GLMR (12dec) => 1 GLMR = 0.0002 DOT.
    // At DOT = $50, GLMR = $0.01.
    const xykPools: XYKPool[] = [
      {
        assetA: 5,
        assetB: 2,
        reserveA: 100000000000n,
        reserveB: 50000000000000000n,
      },
    ];
    const decimals: AssetDecimals = new Map([[5, 10], [2, 12]]);

    const dotToGlmrEdge = buildGraph(xykPools, decimals).get(5)!.find(e => e.toAsset === 2)!;
    const glmrPrice24 = dotToGlmrEdge.computePrice(priceTo24('50.000000000000'), 24);

    const expected = priceTo24('0.010000000000');
    const diff = glmrPrice24 > expected ? glmrPrice24 - expected : expected - glmrPrice24;
    expect(diff).toBeLessThanOrEqual(expected / 100n);
  });
});

describe('bfsResolvePrices', () => {
  it('seeds anchored assets at depth 0 and expands outward', () => {
    const xykPools: XYKPool[] = [
      { assetA: 0, assetB: 1, reserveA: 1000000000000n, reserveB: 1000000000000n },
    ];
    const decimals: AssetDecimals = new Map([[0, 12], [1, 12]]);
    const graph = buildGraph(xykPools, decimals);

    const result = bfsResolvePrices(new Map([[0, priceTo24('1.000000000000')]]), new Set([0]), graph);

    expect(result.get(0)!.hopCount).toBe(0);
    expect(result.get(1)!.hopCount).toBe(1);
  });

  it('never overrides an anchored asset', () => {
    const xykPools: XYKPool[] = [
      { assetA: 0, assetB: 1, reserveA: 1000000000000n, reserveB: 2000000000000n },
    ];
    const decimals: AssetDecimals = new Map([[0, 12], [1, 12]]);
    const graph = buildGraph(xykPools, decimals);

    const result = bfsResolvePrices(
      new Map([[1, priceTo24('3.000000000000')]]),
      new Set([0, 1]),
      graph,
    );

    expect(result.has(0)).toBe(false);
    expect(price24ToString(result.get(1)!.priceBigint)).toBe('3.000000000000');
  });

  it('honors a custom hop limit', () => {
    const xykPools: XYKPool[] = [
      { assetA: 0, assetB: 1, reserveA: 1000000000000n, reserveB: 1000000000000n },
      { assetA: 1, assetB: 2, reserveA: 1000000000000n, reserveB: 1000000000000n },
    ];
    const decimals: AssetDecimals = new Map([[0, 12], [1, 12], [2, 12]]);
    const graph = buildGraph(xykPools, decimals);

    const result = bfsResolvePrices(new Map([[0, priceTo24('1.000000000000')]]), new Set([0]), graph, 1);

    expect(result.has(1)).toBe(true);
    expect(result.has(2)).toBe(false);
  });
});

describe('collectUnpricedConnectedAssets', () => {
  it('returns asset IDs that have graph edges but no price', () => {
    const xykPools: XYKPool[] = [
      { assetA: 5, assetB: 2, reserveA: 1000000000000n, reserveB: 1000000000000n },
      { assetA: 2, assetB: 3, reserveA: 1000000000000n, reserveB: 1000000000000n },
    ];
    const decimals: AssetDecimals = new Map([[5, 12], [2, 12], [3, 12]]);
    const graph = buildGraph(xykPools, decimals);
    const prices: PriceMap = new Map([[5, '1.000000000000']]);

    expect(collectUnpricedConnectedAssets(graph, prices)).toEqual([2, 3]);
  });

  it('returns empty array when all connected assets are priced', () => {
    const xykPools: XYKPool[] = [
      { assetA: 5, assetB: 2, reserveA: 1000000000000n, reserveB: 1000000000000n },
    ];
    const decimals: AssetDecimals = new Map([[5, 12], [2, 12]]);
    const graph = buildGraph(xykPools, decimals);
    const prices: PriceMap = new Map([[5, '1.000000000000'], [2, '1.000000000000']]);

    expect(collectUnpricedConnectedAssets(graph, prices)).toEqual([]);
  });
});
