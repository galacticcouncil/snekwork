import { describe, it, expect } from 'vitest';
import { resolvePrices, restrictToPricedAssets } from '../../src/price/graph.ts';
import { KSM_ASSET_ID } from '../../src/price/reference.ts';
import { extractVolumeFromSwaps, mergePriceAndVolumeRows } from '../../src/blocks/extractVolume.ts';
import type { AssetDecimals, PriceMap, XYKPool } from '../../src/price/types.ts';

// Basilisk's valuation model end to end: KSM is anchored to the off-chain
// reference, BSX is derived from it through the BSX/KSM pool, and every other
// asset is deliberately unpriced — including the ones the graph could reach and
// including the BSX/USDT pool, which is a cross-check and never an input.

const BSX = 0;
const USDT = 14;
const XRT = 7;
const PRICED_ASSET_IDS = [BSX, KSM_ASSET_ID];

const KSM_USD = '3.550000000000';
const unit = (whole: number, decimals: number): bigint => BigInt(whole) * 10n ** BigInt(decimals);

const decimals: AssetDecimals = new Map([[BSX, 12], [KSM_ASSET_ID, 12], [USDT, 6], [XRT, 9]]);

// 1,000,000 BSX against 100 KSM: 1 BSX = 0.0001 KSM = $0.000355.
const bsxKsmPool: XYKPool = {
  assetA: BSX,
  assetB: KSM_ASSET_ID,
  reserveA: unit(1_000_000, 12),
  reserveB: unit(100, 12),
};
// The same BSX priced ~2.8x higher against a stale USDT book.
const bsxUsdtPool: XYKPool = {
  assetA: BSX,
  assetB: USDT,
  reserveA: unit(1_000_000, 12),
  reserveB: unit(994, 6),
};
const ksmXrtPool: XYKPool = {
  assetA: KSM_ASSET_ID,
  assetB: XRT,
  reserveA: unit(10, 12),
  reserveB: unit(500, 9),
};

const seed = (price: string = KSM_USD): PriceMap => new Map([[KSM_ASSET_ID, price]]);

function resolve(pools: XYKPool[], seedPrices: PriceMap = seed()) {
  return resolvePrices(pools, decimals, seedPrices, { pricedAssetIds: PRICED_ASSET_IDS });
}

describe('the KSM anchor', () => {
  it('holds KSM at the referenced price and prices BSX through the pool ratio', () => {
    const { prices, hopCounts } = resolve([bsxKsmPool]);

    expect(prices.get(KSM_ASSET_ID)).toBe(KSM_USD);
    expect(hopCounts.get(KSM_ASSET_ID)).toBe(0);
    expect(prices.get(BSX)).toBe('0.000355000000');
    expect(hopCounts.get(BSX)).toBe(1);
  });

  it('moves BSX with the reference, since the reference is the only USD input', () => {
    const cheaper = resolve([bsxKsmPool], seed('1.775000000000'));
    expect(cheaper.prices.get(BSX)).toBe('0.000177500000');
  });

  it('prices nothing at all without an anchor', () => {
    const { prices } = resolve([bsxKsmPool, bsxUsdtPool], new Map());
    expect(prices.size).toBe(0);
  });

  it('leaves BSX unpriced, and says so, before the BSX/KSM pool exists', () => {
    const { prices, unpricedConnected } = resolve([bsxUsdtPool]);

    expect(prices.has(BSX)).toBe(false);
    expect(prices.get(KSM_ASSET_ID)).toBe(KSM_USD);
    // Only the whitelist is reported: the assets the platform declines to price
    // are not a per-block gap list.
    expect(unpricedConnected).toEqual([BSX]);
  });

  it('ignores the BSX/USDT pool entirely, whichever price it implies', () => {
    const throughKsm = resolve([bsxKsmPool]).prices.get(BSX);
    const bothPools = resolve([bsxKsmPool, bsxUsdtPool]).prices.get(BSX);

    expect(bothPools).toBe(throughKsm);
    // The pool it ignores currently implies ~2.8x that price; using it as a
    // second observation would drag BSX toward an un-arbitraged book.
    const impliedByUsdt = 994 / 1_000_000;
    expect(impliedByUsdt / Number(throughKsm)).toBeGreaterThan(2.5);
  });
});

describe('the price whitelist at the write boundary', () => {
  it('publishes only BSX and KSM, however far the graph reaches', () => {
    const { prices } = resolve([bsxKsmPool, bsxUsdtPool, ksmXrtPool]);
    expect([...prices.keys()].sort((a, b) => a - b)).toEqual(PRICED_ASSET_IDS);
  });

  it('would have priced the excluded assets: the whitelist is what stops it', () => {
    const unrestricted = resolvePrices([bsxKsmPool, bsxUsdtPool, ksmXrtPool], decimals, seed());
    expect(unrestricted.prices.has(USDT)).toBe(true);
    expect(unrestricted.prices.has(XRT)).toBe(true);

    const restricted = restrictToPricedAssets(unrestricted.prices, PRICED_ASSET_IDS);
    expect([...restricted.keys()].sort((a, b) => a - b)).toEqual(PRICED_ASSET_IDS);
  });

  it('keeps hop counts consistent with the prices it publishes', () => {
    const { prices, hopCounts } = resolve([bsxKsmPool, ksmXrtPool]);
    expect([...hopCounts.keys()].sort((a, b) => a - b)).toEqual([...prices.keys()].sort((a, b) => a - b));
  });
});

describe('volume valuation under a two-asset price map', () => {
  function swapEvent(assetIn: number, amountIn: bigint, assetOut: number, amountOut: bigint) {
    const args = { assetIn, assetOut, amount: amountIn, salePrice: amountOut, who: 'alice', feeAsset: assetOut, feeAmount: 0n };
    return {
      name: 'XYK.SellExecuted',
      args,
      block: {
        _runtime: {
          events: { checkType: (name: string) => name === 'XYK.SellExecuted' },
          decodeJsonEventRecordArguments: (event: { args: unknown }) => event.args,
        },
      },
    };
  }

  const { prices } = resolve([bsxKsmPool, ksmXrtPool]);

  it('values a priced leg and leaves an unpriced leg at zero USD, never a substitute', () => {
    const rows = extractVolumeFromSwaps([swapEvent(BSX, unit(1_000, 12), XRT, unit(2, 9))], 100, 115, prices, decimals);

    const bsxLeg = rows.find(row => row.asset_id === BSX);
    const xrtLeg = rows.find(row => row.asset_id === XRT);
    expect(bsxLeg?.native_volume_sell).toBe(unit(1_000, 12).toString());
    expect(bsxLeg?.usd_volume_sell).toBe('0.355000000000');
    expect(xrtLeg?.native_volume_buy).toBe(unit(2, 9).toString());
    expect(xrtLeg?.usd_volume_buy).toBe('0.000000000000');
  });

  it('writes no price row for an unpriced asset, so no $0 candle is fabricated', () => {
    const volumeRows = extractVolumeFromSwaps(
      [swapEvent(BSX, unit(1_000, 12), XRT, unit(2, 9))], 100, 115, prices, decimals,
    );
    const priceRows = [...prices.entries()].map(([asset_id, usd_price]) => ({ asset_id, block_height: 100, usd_price }));

    // The indexer's write filter: a row only reaches price_data.prices with a
    // positive usd_price, which an unpriced asset's volume-only row never has.
    const written = mergePriceAndVolumeRows(priceRows, volumeRows)
      .filter(row => parseFloat(row.usd_price) > 0);

    expect(written.map(row => row.asset_id).sort((a, b) => a - b)).toEqual(PRICED_ASSET_IDS);
    expect(written.find(row => row.asset_id === BSX)?.usd_volume_sell).toBe('0.355000000000');
  });
});
