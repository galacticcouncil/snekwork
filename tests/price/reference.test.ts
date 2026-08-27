import { describe, it, expect } from 'vitest';
import {
  COINGECKO_HISTORY_DAYS,
  KsmReferenceIndex,
  addUtcDays,
  binanceKlinesUrl,
  coingeckoEarliestDay,
  coingeckoMarketChartUrl,
  coingeckoSimplePriceUrl,
  formatUsdPrice,
  missingSettledDays,
  parseBinanceKlines,
  parseCoinGeckoMarketChart,
  parseCoinGeckoSimplePrice,
  planReferenceSources,
  selectRowsForDays,
  utcDayFromMs,
  utcDayToMs,
  utcDaysBetween,
  type ReferenceRow,
} from '../../src/price/reference.ts';

const DAY_MS = 86_400_000;

function close(day: string, price: string, source: ReferenceRow['source'] = 'binance'): ReferenceRow {
  return { day, grain: 'close', usd_price: price, source };
}

function live(day: string, price: string): ReferenceRow {
  return { day, grain: 'live', usd_price: price, source: 'coingecko-live' };
}

function at(day: string, hour = 12): number {
  return utcDayToMs(day) + hour * 3_600_000;
}

describe('formatUsdPrice', () => {
  it('keeps a string source\'s own digits rather than routing them through a double', () => {
    expect(formatUsdPrice('3.56000000')).toBe('3.560000000000');
    expect(formatUsdPrice('0.000000000001')).toBe('0.000000000001');
  });

  it('truncates a string beyond the stored 12 decimals', () => {
    expect(formatUsdPrice('1.9999999999999')).toBe('1.999999999999');
  });

  it('formats a JSON number deterministically at the stored scale', () => {
    expect(formatUsdPrice(15.363443468657833)).toBe('15.363443468658');
    expect(formatUsdPrice(3.55)).toBe('3.550000000000');
  });

  it('rejects anything that is not a usable positive price', () => {
    expect(formatUsdPrice(0)).toBeNull();
    expect(formatUsdPrice(-1)).toBeNull();
    expect(formatUsdPrice(Number.NaN)).toBeNull();
    expect(formatUsdPrice(Number.POSITIVE_INFINITY)).toBeNull();
    expect(formatUsdPrice('')).toBeNull();
    expect(formatUsdPrice('abc')).toBeNull();
    expect(formatUsdPrice('0.0000000000001')).toBeNull();
  });
});

describe('utc day arithmetic', () => {
  it('names the UTC day a timestamp falls in', () => {
    expect(utcDayFromMs(Date.parse('2022-06-15T23:59:59Z'))).toBe('2022-06-15');
    expect(utcDayFromMs(Date.parse('2022-06-16T00:00:00Z'))).toBe('2022-06-16');
  });

  it('steps days across month and year boundaries', () => {
    expect(addUtcDays('2022-02-28', 1)).toBe('2022-03-01');
    expect(addUtcDays('2021-01-01', -1)).toBe('2020-12-31');
  });

  it('enumerates an inclusive day range', () => {
    expect(utcDaysBetween('2022-12-30', '2023-01-01')).toEqual(['2022-12-30', '2022-12-31', '2023-01-01']);
  });
});

// The determinism rule, stated as tests: outside the live window a block reads
// only settled closes and therefore replays identically; inside it, and only
// inside it, a provisional intraday row may value the block instead.
describe('KsmReferenceIndex.lookup', () => {
  const index = new KsmReferenceIndex([
    close('2026-08-24', '3.750000000000'),
    close('2026-08-25', '3.600000000000'),
    close('2026-08-26', '3.560000000000'),
    live('2026-08-26', '3.510000000000'),
    live('2026-08-27', '3.549451018598'),
  ]);
  const now = at('2026-08-27', 15);

  it('values an old block at the close of the last day that ended before its own', () => {
    const anchor = index.lookup(at('2026-08-26', 9), now, { liveWindowMs: 0 });
    expect(anchor).toMatchObject({ day: '2026-08-25', usdPrice: '3.600000000000', grain: 'close', staleDays: 1 });
  });

  it('never reads the block\'s own day, so no price carries information from after it', () => {
    // 2026-08-26's own close (3.56) and its live row (3.51) both exist and are
    // both ignored for a block on that day.
    const anchor = index.lookup(at('2026-08-26', 23), now, { liveWindowMs: 0 });
    expect(anchor?.usdPrice).toBe('3.600000000000');
  });

  it('reproduces the same value however long after the block it is asked', () => {
    const block = at('2022-06-15', 3);
    const historical = new KsmReferenceIndex([close('2022-06-14', '55.100000000000')]);
    const first = historical.lookup(block, at('2022-06-16'), {});
    const replayed = historical.lookup(block, at('2030-01-01'), {});
    expect(first).toEqual(replayed);
    expect(first?.usdPrice).toBe('55.100000000000');
  });

  it('takes the provisional intraday row for a block inside the live window', () => {
    const anchor = index.lookup(at('2026-08-27', 14), now, { liveWindowMs: 48 * 3_600_000 });
    expect(anchor).toMatchObject({ day: '2026-08-27', usdPrice: '3.549451018598', grain: 'live', staleDays: 0 });
  });

  it('drops back to settled closes the moment the block ages out of the window', () => {
    const block = at('2026-08-26', 12);
    const inside = index.lookup(block, block + 3_600_000, { liveWindowMs: 48 * 3_600_000 });
    const outside = index.lookup(block, block + 49 * 3_600_000, { liveWindowMs: 48 * 3_600_000 });
    expect(inside?.grain).toBe('live');
    expect(outside?.grain).toBe('close');
    expect(outside?.usdPrice).toBe('3.600000000000');
  });

  it('walks back over missing days, bounded by the staleness limit', () => {
    const gappy = new KsmReferenceIndex([close('2026-08-20', '3.000000000000')]);
    expect(gappy.lookup(at('2026-08-24'), now, { liveWindowMs: 0, maxStaleDays: 7 })?.staleDays).toBe(4);
    expect(gappy.lookup(at('2026-08-31'), now, { liveWindowMs: 0, maxStaleDays: 7 })).toBeNull();
  });

  it('has no anchor before its earliest stored day', () => {
    expect(index.lookup(at('2021-07-01'), now, {})).toBeNull();
  });

  it('keeps a settled close and a live row for the same day as separate rows', () => {
    // A live poll has no key under which it could overwrite a settled close.
    expect(index.lookup(at('2026-08-27', 1), now, { liveWindowMs: 0 })?.usdPrice).toBe('3.560000000000');
    expect(index.hasSettled('2026-08-26')).toBe(true);
  });

  it('replaces a settled day in place when it is written again', () => {
    const revised = new KsmReferenceIndex([close('2026-08-25', '3.600000000000')]);
    revised.put(close('2026-08-25', '3.610000000000', 'coingecko'));
    expect(revised.settledDayCount).toBe(1);
    expect(revised.lookup(at('2026-08-26'), now, { liveWindowMs: 0 })?.usdPrice).toBe('3.610000000000');
  });
});

describe('backfill planning', () => {
  const today = '2026-08-27';

  it('splices the two sources at the 365-day line CoinGecko stops answering', () => {
    const boundary = coingeckoEarliestDay(today);
    expect(boundary).toBe(addUtcDays(today, -(COINGECKO_HISTORY_DAYS - 1)));

    const plan = planReferenceSources(
      [addUtcDays(boundary, -2), addUtcDays(boundary, -1), boundary, addUtcDays(boundary, 1)],
      today,
    );
    expect(plan.binanceDays).toEqual([addUtcDays(boundary, -2), addUtcDays(boundary, -1)]);
    expect(plan.coingeckoDays).toEqual([boundary, addUtcDays(boundary, 1)]);
  });

  it('never asks for the current day, which has no close yet', () => {
    const index = new KsmReferenceIndex();
    const days = missingSettledDays(index, '2026-08-25', '2026-08-31', today);
    expect(days).toEqual(['2026-08-25', '2026-08-26']);
  });

  it('is idempotent: a second run over stored days has nothing to write', () => {
    const index = new KsmReferenceIndex();
    const first = missingSettledDays(index, '2026-08-20', '2026-08-26', today);
    expect(first).toHaveLength(7);
    for (const day of first) index.put(close(day, '3.000000000000'));

    expect(missingSettledDays(index, '2026-08-20', '2026-08-26', today)).toEqual([]);
  });

  it('fills only the holes when a run was interrupted', () => {
    const index = new KsmReferenceIndex([close('2026-08-20', '3.0'), close('2026-08-22', '3.0')]);
    expect(missingSettledDays(index, '2026-08-20', '2026-08-23', today)).toEqual(['2026-08-21', '2026-08-23']);
  });
});

describe('source responses', () => {
  it('builds keyless public URLs', () => {
    expect(coingeckoMarketChartUrl('https://api.coingecko.com/api/v3/', 'kusama', 365))
      .toBe('https://api.coingecko.com/api/v3/coins/kusama/market_chart?vs_currency=usd&days=365&interval=daily');
    expect(coingeckoSimplePriceUrl('https://api.coingecko.com/api/v3', 'kusama'))
      .toBe('https://api.coingecko.com/api/v3/simple/price?ids=kusama&vs_currencies=usd');
    expect(binanceKlinesUrl('https://api.binance.com', 'KSMUSDT', 1_625_097_600_000, 1000))
      .toBe('https://api.binance.com/api/v3/klines?symbol=KSMUSDT&interval=1d&startTime=1625097600000&limit=1000');
  });

  // A CoinGecko daily point is the price AT a UTC midnight, so it closes the
  // PREVIOUS day. Verified against Binance: CoinGecko's 2026-08-27T00:00 point
  // (3.5596) is Binance's 2026-08-26 daily close (3.56), and the same one-day
  // offset holds on every neighbouring day.
  it('maps a CoinGecko midnight point to the day it closes', () => {
    const rows = parseCoinGeckoMarketChart({
      prices: [
        [utcDayToMs('2026-08-26'), 3.600363280658724],
        [utcDayToMs('2026-08-27'), 3.5595676347362155],
        [utcDayToMs('2026-08-27') + 15 * 3_600_000, 3.5494510185980563],
      ],
    });
    expect(rows).toEqual([
      { day: '2026-08-25', grain: 'close', usd_price: '3.600363280659', source: 'coingecko' },
      { day: '2026-08-26', grain: 'close', usd_price: '3.559567634736', source: 'coingecko' },
    ]);
  });

  it('maps a Binance kline to its own day, so the two sources splice cleanly', () => {
    const rows = parseBinanceKlines([
      [utcDayToMs('2026-08-25'), '3.60000000', '3.62000000', '3.40000000', '3.48000000', '58827.242'],
      [utcDayToMs('2026-08-26'), '3.48000000', '3.60000000', '3.45000000', '3.56000000', '44917.033'],
    ]);
    expect(rows).toEqual([
      { day: '2026-08-25', grain: 'close', usd_price: '3.480000000000', source: 'binance' },
      { day: '2026-08-26', grain: 'close', usd_price: '3.560000000000', source: 'binance' },
    ]);
  });

  it('agrees across the splice boundary to within a cent', () => {
    const [binance] = parseBinanceKlines([
      [utcDayToMs('2026-08-26'), '3.48', '3.60', '3.45', '3.56000000', '1'],
    ]);
    const coingecko = parseCoinGeckoMarketChart({ prices: [[utcDayToMs('2026-08-27'), 3.5595676347362155]] })
      .find(row => row.day === binance.day);
    expect(coingecko).toBeDefined();
    expect(Math.abs(Number(coingecko!.usd_price) - Number(binance.usd_price))).toBeLessThan(0.01);
  });

  it('ignores malformed points rather than storing a wrong close', () => {
    expect(parseCoinGeckoMarketChart({})).toEqual([]);
    expect(parseCoinGeckoMarketChart({ prices: [[utcDayToMs('2026-08-27'), 0]] })).toEqual([]);
    expect(parseBinanceKlines('down')).toEqual([]);
    expect(parseBinanceKlines([[utcDayToMs('2026-08-26'), '1', '1', '1']])).toEqual([]);
  });

  it('reads the live simple/price shape', () => {
    expect(parseCoinGeckoSimplePrice({ kusama: { usd: 3.55 } }, 'kusama')).toBe('3.550000000000');
    expect(parseCoinGeckoSimplePrice({}, 'kusama')).toBeNull();
    expect(parseCoinGeckoSimplePrice({ kusama: {} }, 'kusama')).toBeNull();
  });

  it('keeps one row per wanted day, in order', () => {
    const rows = selectRowsForDays(
      [close('2026-08-26', '3.56'), close('2026-08-24', '3.75'), close('2026-08-20', '3.00')],
      ['2026-08-24', '2026-08-26'],
    );
    expect(rows.map(row => row.day)).toEqual(['2026-08-24', '2026-08-26']);
  });
});

describe('day boundaries', () => {
  it('treats a timestamp exactly on midnight as the start of that day', () => {
    expect(utcDayFromMs(utcDayToMs('2026-08-27'))).toBe('2026-08-27');
    expect(utcDayFromMs(utcDayToMs('2026-08-27') + DAY_MS - 1)).toBe('2026-08-27');
  });
});
