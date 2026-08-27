import { describe, expect, it } from 'vitest'
import { extractVolumeFromSwaps, extractTradeVolumeFromSwaps } from '../../src/blocks/extractVolume.ts'
import { decodeRawTrade, LEGACY_SWAP_EVENT_NAMES, BROADCAST_SWAP_EVENT_NAMES } from '../../src/scripts/tradeEventDecoder.ts'
import { isSwapEvent, SWAP_EVENT_CATALOG } from '../../src/registry/swapEvents.ts'
import { BASILISK_ERAS, BASILISK_FIRST_SEEN } from '../../src/chainEras.ts'
import type { PriceMap, AssetDecimals } from '../../src/price/types.ts'
import * as xyk from '../../src/types/xyk/events.ts'
import * as lbp from '../../src/types/lbp/events.ts'
import * as broadcast from '../../src/types/broadcast/events.ts'

/**
 * Per-era decode fixtures.
 *
 * Each case pins ONE runtime shape end to end: the era's codec is the only one the
 * mock runtime admits, so a decoder that fell back to a neighbouring version would
 * fail here rather than quietly mis-map a field. The two volume paths — live
 * ingestion (extractVolumeFromSwaps) and repair (decodeRawTrade over the stored
 * args_json) — are asserted on the same fixture, because a repair that disagrees
 * with ingestion restates history instead of restoring it.
 *
 * `args` is what the block's own runtime decoded, sampled off Basilisk mainnet via
 * an archive RPC probe at the block named in each case, except for the tuple eras:
 * no Basilisk block ever emitted one (the first XYK pool is created at spec 65 and
 * the first LBP pool at spec 76, both after v55 replaced the tuples with named
 * structs), so those fixtures are round-tripped through the genuine spec-16 and
 * spec-19 metadata instead — encoded as a System.Events value by that runtime and
 * decoded straight back — which pins the field ORDER to the real chain type even
 * though no chain row carries one.
 */

// A runtime that admits exactly one codec version, by identity of the sts type the
// EventType hands to checkType. Selecting on the name alone (what a looser mock
// does) would let a v55 decoder claim a v16 block.
function eraEvent(codec: { name: string }, args: unknown) {
  const declaredType = (codec as unknown as { type: unknown }).type
  const runtime = {
    events: {
      checkType: (eventName: string, type: unknown) => eventName === codec.name && type === declaredType,
    },
    decodeJsonEventRecordArguments: (event: { args: unknown }) => event.args,
  }
  return { name: codec.name, args, block: { _runtime: runtime } }
}

// The stored raw_events row for the same event: args_json is the decoder's output
// serialised, so bigints land as decimal strings and a tuple lands as an array.
function rawRow(name: string, args: unknown) {
  return {
    block_height: 1,
    event_name: name,
    args_json: JSON.stringify(args, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  }
}

const TRADER = `0x${'11'.repeat(32)}`
const POOL = `0x${'22'.repeat(32)}`

interface EraCase {
  era: string
  specVersion: number
  sampledAt: string
  codec: { name: string }
  args: unknown
  expect: { assetIn: number; amountIn: bigint; assetOut: number; amountOut: bigint; trader: string }
}

const ERA_CASES: EraCase[] = [
  {
    era: 'v16 XYK sell (positional tuple, no pool account)',
    specVersion: BASILISK_ERAS.GENESIS.specVersion,
    sampledAt: 'spec 16 metadata round-trip — no block ever emitted one',
    codec: xyk.sellExecuted.v16,
    // [who, asset in, asset out, amount, sale price, fee asset, fee amount]
    args: [TRADER, 5, 10, 1_000_000_000_000n, 2_000_000_000_000n, 10, 6_000_000_000n],
    expect: { assetIn: 5, amountIn: 1_000_000_000_000n, assetOut: 10, amountOut: 2_000_000_000_000n, trader: TRADER },
  },
  {
    era: 'v16 XYK buy (positional tuple, asset pair reversed)',
    specVersion: BASILISK_ERAS.GENESIS.specVersion,
    sampledAt: 'spec 16 metadata round-trip — no block ever emitted one',
    codec: xyk.buyExecuted.v16,
    // [who, asset out, asset in, amount, buy price, fee asset, fee amount]
    args: [TRADER, 10, 5, 2_000_000_000_000n, 1_000_000_000_000n, 5, 3_000_000_000n],
    expect: { assetIn: 5, amountIn: 1_000_000_000_000n, assetOut: 10, amountOut: 2_000_000_000_000n, trader: TRADER },
  },
  {
    era: 'v19 XYK sell (positional tuple + trailing pool account)',
    specVersion: BASILISK_ERAS.XYK_LIFECYCLE_POOL_ACCOUNT.specVersion,
    sampledAt: 'spec 19 metadata round-trip — no block ever emitted one',
    codec: xyk.sellExecuted.v19,
    args: [TRADER, 5, 10, 1_000_000_000_000n, 2_000_000_000_000n, 10, 6_000_000_000n, POOL],
    expect: { assetIn: 5, amountIn: 1_000_000_000_000n, assetOut: 10, amountOut: 2_000_000_000_000n, trader: TRADER },
  },
  {
    era: 'v19 XYK buy (positional tuple + trailing pool account)',
    specVersion: BASILISK_ERAS.XYK_LIFECYCLE_POOL_ACCOUNT.specVersion,
    sampledAt: 'spec 19 metadata round-trip — no block ever emitted one',
    codec: xyk.buyExecuted.v19,
    args: [TRADER, 10, 5, 2_000_000_000_000n, 1_000_000_000_000n, 5, 3_000_000_000n, POOL],
    expect: { assetIn: 5, amountIn: 1_000_000_000_000n, assetOut: 10, amountOut: 2_000_000_000_000n, trader: TRADER },
  },
  {
    era: 'v16 LBP sell (positional tuple, LBP never grew a pool field)',
    specVersion: BASILISK_ERAS.GENESIS.specVersion,
    sampledAt: 'spec 16 metadata round-trip — no block ever emitted one',
    codec: lbp.sellExecuted.v16,
    args: [TRADER, 5, 10, 1_000_000_000_000n, 2_000_000_000_000n, 10, 6_000_000_000n],
    expect: { assetIn: 5, amountIn: 1_000_000_000_000n, assetOut: 10, amountOut: 2_000_000_000_000n, trader: TRADER },
  },
  {
    era: 'v55 XYK sell (named struct)',
    specVersion: 69,
    sampledAt: `block ${BASILISK_FIRST_SEEN.XYK_SWAP} — the first XYK swap on Basilisk`,
    codec: xyk.sellExecuted.v55,
    args: {
      who: '0x521a32ca20f298ef24f2d87e118ebc11acce880aa872086a6086be5ccfde5732',
      assetIn: 2,
      assetOut: 0,
      amount: 199_000_000_000_000n,
      salePrice: 8_771_131_741_821_396_994n,
      feeAsset: 0,
      feeAmount: 26_392_572_944_297_082n,
      pool: '0x7e4de048474088252f95437ae4a7d68b9c217da7caf683d448223d9aadafba35',
    },
    // Cross-checked against the same extrinsic's transfers: 199,000,000,000,000 of
    // asset 2 trader → pool, 8,771,131,741,821,396,994 of asset 0 back. An XYK sell
    // keeps its fee inside the pool, so both legs equal their transfers.
    expect: {
      assetIn: 2,
      amountIn: 199_000_000_000_000n,
      assetOut: 0,
      amountOut: 8_771_131_741_821_396_994n,
      trader: '0x521a32ca20f298ef24f2d87e118ebc11acce880aa872086a6086be5ccfde5732',
    },
  },
  {
    era: 'v55 XYK buy (named struct)',
    specVersion: 69,
    sampledAt: 'block 1,539,485',
    codec: xyk.buyExecuted.v55,
    args: {
      who: '0x94339db8b404ea216d60433f00ed67b0cdcd9e29d21355615d967161db0cb04c',
      assetOut: 0,
      assetIn: 2,
      amount: 1_000_000_000_000_000_000n,
      buyPrice: 33_695_507_584_776n,
      feeAsset: 2,
      feeAmount: 101_086_522_752n,
      pool: '0x7e4de048474088252f95437ae4a7d68b9c217da7caf683d448223d9aadafba35',
    },
    // The trader's asset-2 transfer is 33,796,594,107,528 = buyPrice + feeAmount:
    // an XYK buy adds the fee ON TOP of the pool leg, and the pool leg is the
    // volume. The asset-0 transfer is `amount` exactly.
    expect: {
      assetIn: 2,
      amountIn: 33_695_507_584_776n,
      assetOut: 0,
      amountOut: 1_000_000_000_000_000_000n,
      trader: '0x94339db8b404ea216d60433f00ed67b0cdcd9e29d21355615d967161db0cb04c',
    },
  },
  {
    era: 'v55 LBP sell (named struct)',
    specVersion: 76,
    sampledAt: `block ${BASILISK_FIRST_SEEN.LBP_SWAP} — the first LBP swap on Basilisk`,
    codec: lbp.sellExecuted.v55,
    args: {
      who: '0x6230d0ffbfdcbb99b63db96d2bac5cf395f5e63b11b66e94a1bcda3707fbe124',
      assetIn: 1,
      assetOut: 6,
      amount: 79_921_899_132n,
      salePrice: 880_565_994_521n,
      feeAsset: 1,
      feeAmount: 19_980_474_782n,
    },
    // Three transfers: 79,921,899,132 of asset 1 to the pool, 880,565,994,521 of
    // asset 6 back, and the fee as its own transfer to the pool's feeCollector.
    expect: {
      assetIn: 1,
      amountIn: 79_921_899_132n,
      assetOut: 6,
      amountOut: 880_565_994_521n,
      trader: '0x6230d0ffbfdcbb99b63db96d2bac5cf395f5e63b11b66e94a1bcda3707fbe124',
    },
  },
  {
    era: 'v55 LBP buy (named struct, amounts inverted by the pallet)',
    specVersion: 76,
    sampledAt: 'block 1,974,221',
    codec: lbp.buyExecuted.v55,
    args: {
      who: '0x744b0a7d18985d2a3527d9d2498822644667f042af46231f51eee5bdbbf2b75d',
      assetOut: 6,
      assetIn: 1,
      amount: 91_758_683_241n,
      buyPrice: 1_000_000_000_000n,
      feeAsset: 1,
      feeAmount: 22_939_670_810n,
    },
    // pallet-lbp reports a buy's two amounts against the wrong legs. The transfers
    // move 91,758,683,241 of asset 1 to the pool and a round 1e12 of asset 6 back —
    // the round number being the `buy` call's own target — so `amount` is what was
    // PAID and `buyPrice` what was BOUGHT. All 104 LBP buys in blocks
    // 1,400,000..2,144,141 read this way; every LBP sell and every XYK fill does not.
    expect: {
      assetIn: 1,
      amountIn: 91_758_683_241n,
      assetOut: 6,
      amountOut: 1_000_000_000_000n,
      trader: '0x744b0a7d18985d2a3527d9d2498822644667f042af46231f51eee5bdbbf2b75d',
    },
  },
  {
    era: 'spec-124 Broadcast.Swapped (unified, exact-in)',
    specVersion: BASILISK_ERAS.BROADCAST_SWAPPED.specVersion,
    sampledAt: `block ${BASILISK_FIRST_SEEN.BROADCAST_SWAP} — the first Broadcast swap on Basilisk`,
    codec: broadcast.swapped.v124,
    args: {
      swapper: '0x1ad9d16ce64de2df5b556e1c0cf58b8428e6ce66d68d6b3eb28b69706cf8a829',
      filler: '0x237cb9df9e9878e7abb3b8ca423fb2050211c43ecb2dd1887aaeede7cc8ca162',
      fillerType: { __kind: 'XYK', value: 8 },
      operation: { __kind: 'ExactIn' },
      inputs: [{ asset: 1, amount: 100_000_000_000n }],
      outputs: [{ asset: 6, amount: 148_884_405_675_549n }],
      fees: [],
      operationStack: [{ __kind: 'Router', value: 0 }],
    },
    expect: {
      assetIn: 1,
      amountIn: 100_000_000_000n,
      assetOut: 6,
      amountOut: 148_884_405_675_549n,
      trader: '0x1ad9d16ce64de2df5b556e1c0cf58b8428e6ce66d68d6b3eb28b69706cf8a829',
    },
  },
  {
    era: 'spec-128 Broadcast.Swapped3 (unified, exact-in)',
    specVersion: BASILISK_ERAS.BROADCAST_SWAPPED3.specVersion,
    sampledAt: 'block 13,003,832',
    codec: broadcast.swapped3.v128,
    args: {
      swapper: '0x9a4aeae262919949aafad880ef2c9560ce3697027ec2435b3353dd126d2ee53a',
      filler: '0xfe939621bb228d8302a27f62cc953db3c987a6a0c49c4b550cf3e22b5d9e04ca',
      fillerType: { __kind: 'XYK', value: 12 },
      operation: { __kind: 'ExactIn' },
      inputs: [{ asset: 14, amount: 86_571_166n }],
      outputs: [{ asset: 0, amount: 3_374_733_240_268_684_363n }],
      fees: [],
      operationStack: [{ __kind: 'Router', value: 0 }],
    },
    expect: {
      assetIn: 14,
      amountIn: 86_571_166n,
      assetOut: 0,
      amountOut: 3_374_733_240_268_684_363n,
      trader: '0x9a4aeae262919949aafad880ef2c9560ce3697027ec2435b3353dd126d2ee53a',
    },
  },
]

const NO_PRICES: PriceMap = new Map()
const NO_DECIMALS: AssetDecimals = new Map()

describe('per-era swap decode', () => {
  for (const era of ERA_CASES) {
    describe(era.era, () => {
      it(`is admitted as a swap by its own runtime (${era.sampledAt})`, () => {
        expect(isSwapEvent(era.codec.name, era.specVersion)).toBe(true)
      })

      it('decodes both legs on the live ingestion path', () => {
        const rows = extractVolumeFromSwaps(
          [eraEvent(era.codec, era.args)] as never,
          100,
          era.specVersion,
          NO_PRICES,
          NO_DECIMALS,
        )
        expect(rows).toHaveLength(2)
        expect(rows[0].asset_id).toBe(era.expect.assetIn)
        expect(rows[0].native_volume_sell).toBe(era.expect.amountIn.toString())
        expect(rows[1].asset_id).toBe(era.expect.assetOut)
        expect(rows[1].native_volume_buy).toBe(era.expect.amountOut.toString())
      })

      it('attributes the trade to its trader', () => {
        const rows = extractTradeVolumeFromSwaps(
          [eraEvent(era.codec, era.args)] as never,
          100,
          era.specVersion,
          NO_PRICES,
          NO_DECIMALS,
        )
        expect(rows.map(row => row.account)).toEqual([era.expect.trader, era.expect.trader])
      })

      it('decodes identically on the repair path, from the stored args_json', () => {
        expect(decodeRawTrade(rawRow(era.codec.name, era.args))).toEqual({
          account: era.expect.trader,
          inputs: [{ assetId: era.expect.assetIn, amount: era.expect.amountIn }],
          outputs: [{ assetId: era.expect.assetOut, amount: era.expect.amountOut }],
        })
      })
    })
  }
})

describe('the era catalogue', () => {
  // One table, and every fixture above is drawn from a row of it. A pallet event
  // decoded anywhere in this indexer that is missing here is an era nobody
  // documented; a row here with no decoder is a shape that silently vanishes.
  it('lists every per-pallet trade event Basilisk has ever emitted', () => {
    expect(SWAP_EVENT_CATALOG.map(entry => entry.name).sort()).toEqual([
      'Exchange.IntentionResolvedAMMTrade',
      'Exchange.IntentionResolvedDirectTrade',
      'LBP.BuyExecuted',
      'LBP.SellExecuted',
      'XYK.BuyExecuted',
      'XYK.SellExecuted',
    ])
  })

  it('bounds the Exchange pallet to its own life and leaves the AMMs unbounded', () => {
    for (const entry of SWAP_EVENT_CATALOG) {
      expect(entry.firstBlock, entry.name).toBe(BASILISK_ERAS.GENESIS.firstBlock)
      expect(entry.removedAtBlock, entry.name).toBe(
        entry.pallet === 'Exchange' ? BASILISK_ERAS.EXCHANGE_REMOVED.firstBlock : null,
      )
    }
  })

  // The repair path selects its rows out of ClickHouse by name, so its two name
  // lists have to be the same sets isSwapEvent admits per era. A name in one and
  // not the other is a repair that adds or drops volume the indexer did not.
  it('selects the same names for repair as isSwapEvent admits per era', () => {
    for (const name of LEGACY_SWAP_EVENT_NAMES) {
      expect(isSwapEvent(name, BASILISK_ERAS.BROADCAST_SWAPPED.specVersion - 1), name).toBe(true)
    }
    for (const name of BROADCAST_SWAP_EVENT_NAMES) {
      expect(isSwapEvent(name, BASILISK_ERAS.BROADCAST_SWAPPED.specVersion), name).toBe(true)
    }
    const admittedLegacy = SWAP_EVENT_CATALOG
      .map(entry => entry.name)
      .filter(name => isSwapEvent(name, BASILISK_ERAS.BROADCAST_SWAPPED.specVersion - 1))
    expect(admittedLegacy.sort()).toEqual([...LEGACY_SWAP_EVENT_NAMES].sort())
  })

  it('gives every era fixture a catalogue row or a Broadcast name', () => {
    const catalogued = new Set(SWAP_EVENT_CATALOG.map(entry => entry.name))
    for (const era of ERA_CASES) {
      expect(catalogued.has(era.codec.name) || era.codec.name.startsWith('Broadcast.'), era.era).toBe(true)
    }
  })
})

describe('era admission', () => {
  // XYK and LBP keep emitting their own *Executed event next to every
  // Broadcast.Swapped* at head. Both describe the same fill, so exactly one of
  // them may be counted, and which one is a question about the block's runtime.
  it('hands a fill to the pallet event below spec 124 and to Broadcast at or above', () => {
    for (const name of ['XYK.SellExecuted', 'XYK.BuyExecuted', 'LBP.SellExecuted', 'LBP.BuyExecuted']) {
      expect(isSwapEvent(name, 123), name).toBe(true)
      expect(isSwapEvent(name, 124), name).toBe(false)
      expect(isSwapEvent(name, 134), name).toBe(false)
    }
    for (const name of ['Broadcast.Swapped', 'Broadcast.Swapped3']) {
      expect(isSwapEvent(name, 123), name).toBe(false)
      expect(isSwapEvent(name, 124), name).toBe(true)
      expect(isSwapEvent(name, 134), name).toBe(true)
    }
  })

  it('never treats Broadcast.Swapped2 as a swap: Basilisk has no such event', () => {
    expect(isSwapEvent('Broadcast.Swapped2', 134)).toBe(false)
    expect(isSwapEvent('Broadcast.Swapped2')).toBe(false)
  })

  // The `Exchange` pallet (specs 16..76) resolved an intention either against the
  // XYK pool — which emits its OWN XYK.Sell/BuyExecuted beside the marker, so
  // counting the marker double-counts — or directly against another user's
  // intention, which is a genuine leg but carries no asset ids at all: they live
  // in the two IntentionRegistered events its intention ids point back to. Neither
  // is a volume event here, and no Basilisk block can argue: a block-by-block
  // sweep of blocks 0..2,144,140, the pallet's whole life, found zero Exchange
  // events of any kind.
  it('counts no Exchange event as volume, in its own era or any other', () => {
    for (const name of [
      'Exchange.IntentionRegistered',
      'Exchange.IntentionResolvedAMMTrade',
      'Exchange.IntentionResolvedDirectTrade',
      'Exchange.IntentionResolvedDirectTradeFees',
    ]) {
      expect(isSwapEvent(name, BASILISK_ERAS.GENESIS.specVersion), name).toBe(false)
      expect(isSwapEvent(name, 76), name).toBe(false)
      expect(isSwapEvent(name), name).toBe(false)
    }
  })
})
