import { describe, expect, it } from 'vitest'
import {
  aliasStateFromSnapshot,
  buildRepairedPriceRows,
  parseArgs,
  resolveRange,
  rowsForTrade,
  type AliasState,
  type DecodedTrade,
  type PriceVolumeRow,
} from '../../src/scripts/repair-volume.ts'
import type { ClickHouseClient } from '../../src/db/client.ts'
import type { PriceRow } from '../../src/db/schema.ts'

type ExistingPriceRowFixture = PriceRow & {
  block_timestamp: string
  native_volume_buy: string
  native_volume_sell: string
  usd_volume_buy: string
  usd_volume_sell: string
  hops: number
}

describe('volume repair helpers', () => {
  // The two-asset price model: a leg on an unpriced asset carries zero USD, the
  // same value the live pipeline writes for it. A leg on a PRICED asset with no
  // indexed price is a different failure — prices are not indexed for the range —
  // and must still be loud rather than silently zeroing real volume.
  it('zeroes an unpriced asset\'s USD leg and still refuses to guess a priced one', () => {
    const aliases: AliasState = { decimals: new Map([[0, 12], [1, 12], [16, 9]]) };
    const trade: DecodedTrade = {
      account: 'alice',
      inputs: [{ assetId: 0, amount: 1_000_000_000_000n }],
      outputs: [{ assetId: 16, amount: 2_000_000_000n }],
    };
    const prices = new Map([['123:0', '0.000001668574']]);

    const { priceRows } = rowsForTrade(trade, 123, aliases, prices);
    expect(priceRows.find(row => row.asset_id === 0)?.usd_volume_sell).toBe('0.000001668574');
    expect(priceRows.find(row => row.asset_id === 16)?.usd_volume_buy).toBe('0.000000000000');

    expect(() => rowsForTrade(trade, 123, aliases, new Map())).toThrow(/priced asset 0/);
  });

  it('clears stale price volumes when a touched priced key has no corrected volume', () => {
    const existing: ExistingPriceRowFixture[] = [{
      asset_id: 5,
      block_height: 123,
      block_timestamp: '2026-06-21 00:00:00',
      usd_price: '2.000000000000',
      native_volume_buy: '10000000000',
      native_volume_sell: '10000000000',
      usd_volume_buy: '2.000000000000',
      usd_volume_sell: '2.000000000000',
      hops: 0,
    }]
    const corrected: PriceVolumeRow[] = []

    expect(buildRepairedPriceRows(existing, corrected)).toEqual([{
      asset_id: 5,
      block_height: 123,
      block_timestamp: '2026-06-21 00:00:00',
      usd_price: '2.000000000000',
      native_volume_buy: '0',
      native_volume_sell: '0',
      usd_volume_buy: '0.000000000000',
      usd_volume_sell: '0.000000000000',
      hops: 0,
    }])
  })

  it('fails when corrected volume has no positive indexed price', () => {
    const existing: ExistingPriceRowFixture[] = [{
      asset_id: 5,
      block_height: 123,
      block_timestamp: '2026-06-21 00:00:00',
      usd_price: '0',
      native_volume_buy: '10000000000',
      native_volume_sell: '0',
      usd_volume_buy: '0.000000000000',
      usd_volume_sell: '0.000000000000',
      hops: 0,
    }]
    const corrected: PriceVolumeRow[] = [{
      asset_id: 5,
      block_height: 123,
      native_volume_buy: '10000000000',
      native_volume_sell: '0',
      usd_volume_buy: '0.000000000000',
      usd_volume_sell: '0.000000000000',
    }]

    expect(() => buildRepairedPriceRows(existing, corrected)).toThrow('without a positive indexed USD price')
  })

  it('defaults --from-block repairs through the current safe tip', async () => {
    const client = {
      query: () => ({
        json: async () => [{ max_block: 1000 }],
      }),
    } as unknown as ClickHouseClient

    await expect(resolveRange(client, parseArgs(['--from-block=900']))).resolves.toEqual({
      from: 900,
      to: 900,
      safeTip: 900,
    })
  })

  it('parses asset filters for scoped repair runs', () => {
    const args = parseArgs(['--from-block=123', '--asset-ids=34,20,34'])

    expect([...(args.assetIds ?? [])]).toEqual([34, 20])
  })

  it('forces the ohlc target back on when --skip-ohlc is combined with an explicit prices target', () => {
    const args = parseArgs(['--from-block=123', '--targets=prices', '--skip-ohlc'])

    expect([...args.targets].sort()).toEqual(['ohlc', 'prices'])
  })

  it('forces the ohlc target back on when --skip-ohlc is combined with the default targets', () => {
    const args = parseArgs(['--from-block=123', '--skip-ohlc'])

    expect([...args.targets].sort()).toEqual(['ohlc', 'prices', 'trade-volume'])
  })

  it('honors --skip-ohlc when prices are not among the requested targets', () => {
    const args = parseArgs(['--from-block=123', '--targets=trade-volume', '--skip-ohlc'])

    expect([...args.targets]).toEqual(['trade-volume'])
  })
})
