import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KsmReferenceService } from '../../src/price/referenceService.ts';
import { KSM_ASSET_ID, utcDayToMs, type ReferenceRow } from '../../src/price/reference.ts';
import type { ClickHouseClient } from '../../src/db/client.ts';

const TODAY = '2026-08-27';
const NOW = utcDayToMs(TODAY) + 15 * 3_600_000;

interface StoredRow {
  day: string
  grain: string
  usd_price: string
  source: string
}

function fakeClient(rows: StoredRow[]): { client: ClickHouseClient; inserted: ReferenceRow[] } {
  const inserted: ReferenceRow[] = [];
  const client = {
    query: async () => ({ json: async () => rows }),
    insert: async ({ values }: { values: ReferenceRow[] }) => { inserted.push(...values); },
  };
  return { client: client as unknown as ClickHouseClient, inserted };
}

const settled = (day: string, price: string): StoredRow => ({ day, grain: 'close', usd_price: price, source: 'binance' });

describe('KsmReferenceService', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('seeds only KSM, at the settled close, and issues no external call for a historical run', async () => {
    const { client } = fakeClient([settled('2022-06-14', '55.100000000000')]);
    const fetchJson = vi.fn();
    const service = new KsmReferenceService(client, { live: false, now: () => NOW, fetchJson });
    await service.start();

    const seed = service.seedFor(utcDayToMs('2022-06-15') + 3_600_000);
    expect([...seed]).toEqual([[KSM_ASSET_ID, '55.100000000000']]);
    expect(fetchJson).not.toHaveBeenCalled();
    service.stop();
  });

  it('seeds nothing when the reference cannot reach the block, so nothing gets priced', async () => {
    const { client } = fakeClient([settled('2026-08-26', '3.560000000000')]);
    const service = new KsmReferenceService(client, { live: false, now: () => NOW, fetchJson: vi.fn() });
    await service.start();

    expect(service.seedFor(utcDayToMs('2021-07-15')).size).toBe(0);
    service.stop();
  });

  it('writes the current day as a provisional row and serves it at the head', async () => {
    const { client, inserted } = fakeClient([
      settled('2026-08-24', '3.480000000000'),
      settled('2026-08-26', '3.560000000000'),
    ]);
    const fetchJson = vi.fn(async (url: string) => {
      if (url.includes('simple/price')) return { kusama: { usd: 3.5494510185980563 } };
      throw new Error(`unexpected ${url}`);
    });
    const service = new KsmReferenceService(client, { live: true, now: () => NOW, fetchJson });
    await service.start();
    service.stop();

    expect(inserted).toEqual([
      { day: TODAY, grain: 'live', usd_price: '3.549451018598', source: 'coingecko-live' },
    ]);
    // A head block takes the provisional row; a block past the live window does not.
    expect(service.seedFor(NOW - 60_000).get(KSM_ASSET_ID)).toBe('3.549451018598');
    // 2026-08-25 12:00 is 51h before now: outside the window, so it reads the
    // last close that ended before its own day rather than the provisional row.
    expect(service.seedFor(utcDayToMs('2026-08-25') + 12 * 3_600_000).get(KSM_ASSET_ID)).toBe('3.480000000000');
  });

  it('settles a recent day from the daily history when the backfill has not', async () => {
    const { client, inserted } = fakeClient([settled('2026-08-25', '3.480000000000')]);
    const fetchJson = vi.fn(async (url: string) => {
      if (url.includes('simple/price')) return { kusama: { usd: 3.55 } };
      return { prices: [[utcDayToMs('2026-08-27'), 3.5595676347362155]] };
    });
    const service = new KsmReferenceService(client, { live: true, now: () => NOW, fetchJson });
    await service.start();
    service.stop();

    expect(inserted).toContainEqual({
      day: '2026-08-26', grain: 'close', usd_price: '3.559567634736', source: 'coingecko',
    });
    // It settles, it does not backfill: only a day the history call covered and
    // the table was missing is written.
    expect(inserted.filter(row => row.grain === 'close')).toHaveLength(1);
  });

  it('spaces settle attempts, so an unsettled day costs a request an hour, not one a poll', async () => {
    const { client } = fakeClient([settled('2026-08-25', '3.480000000000')]);
    // A history response that settles nothing keeps the days missing.
    const fetchJson = vi.fn(async (url: string) => (
      url.includes('simple/price') ? { kusama: { usd: 3.55 } } : { prices: [] }
    ));
    let now = NOW;
    const service = new KsmReferenceService(client, { live: true, pollMs: 60_000, now: () => now, fetchJson });
    await service.start();
    const historyCalls = () => fetchJson.mock.calls.filter(([url]) => url.includes('market_chart')).length;
    expect(historyCalls()).toBe(1);

    now = NOW + 10 * 60_000;
    await service.poll();
    expect(historyCalls()).toBe(1);

    now = NOW + 61 * 60_000;
    await service.poll();
    expect(historyCalls()).toBe(2);
    service.stop();
  });

  it('keeps serving the stored reference, with a staleness warning, when CoinGecko is down', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client, inserted } = fakeClient([settled('2026-08-26', '3.560000000000')]);
    const fetchJson = vi.fn(async () => { throw new Error('503 Service Unavailable'); });
    const service = new KsmReferenceService(client, { live: true, now: () => NOW, fetchJson });
    await service.start();
    service.stop();

    expect(inserted).toEqual([]);
    expect(warn.mock.calls.flat().join(' ')).toContain('serving the stored reference');
    // The head still prices, one settled day behind, rather than going dark.
    expect(service.seedFor(NOW - 60_000).get(KSM_ASSET_ID)).toBe('3.560000000000');
  });

  it('does not go dark when the reference table is empty, it prices nothing and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client } = fakeClient([]);
    const service = new KsmReferenceService(client, { live: false, now: () => NOW, fetchJson: vi.fn() });
    await service.start();

    expect(service.seedFor(NOW).size).toBe(0);
    expect(warn.mock.calls.flat().join(' ')).toContain('ksm_usd_reference is empty');
    service.stop();
  });
});
