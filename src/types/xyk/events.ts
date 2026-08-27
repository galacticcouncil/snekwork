import {sts, Block, Bytes, Option, Result, EventType, RuntimeCtx} from '../support'
import * as v16 from '../v16'
import * as v19 from '../v19'
import * as v55 from '../v55'

export const liquidityAdded =  {
    name: 'XYK.LiquidityAdded',
    /**
     *  New liquidity was provided to the pool. [who, asset a, asset b, amount a, amount b]
     */
    v16: new EventType(
        'XYK.LiquidityAdded',
        sts.tuple([v16.AccountId, v16.AssetId, v16.AssetId, v16.Balance, v16.Balance])
    ),
    /**
     * New liquidity was provided to the pool.
     */
    v55: new EventType(
        'XYK.LiquidityAdded',
        sts.struct({
            who: v55.AccountId32,
            assetA: sts.number(),
            assetB: sts.number(),
            amountA: sts.bigint(),
            amountB: sts.bigint(),
        })
    ),
}

export const liquidityRemoved =  {
    name: 'XYK.LiquidityRemoved',
    /**
     *  Liquidity was removed from the pool. [who, asset a, asset b, shares]
     */
    v16: new EventType(
        'XYK.LiquidityRemoved',
        sts.tuple([v16.AccountId, v16.AssetId, v16.AssetId, v16.Balance])
    ),
    /**
     * Liquidity was removed from the pool.
     */
    v55: new EventType(
        'XYK.LiquidityRemoved',
        sts.struct({
            who: v55.AccountId32,
            assetA: sts.number(),
            assetB: sts.number(),
            shares: sts.bigint(),
        })
    ),
}

export const poolCreated =  {
    name: 'XYK.PoolCreated',
    /**
     *  Pool was created. [who, asset a, asset b, initial shares amount]
     */
    v16: new EventType(
        'XYK.PoolCreated',
        sts.tuple([v16.AccountId, v16.AssetId, v16.AssetId, v16.Balance])
    ),
    /**
     *  Pool was created. [who, asset a, asset b, initial shares amount, share token, pool account id]
     */
    v19: new EventType(
        'XYK.PoolCreated',
        sts.tuple([v19.AccountId, v19.AssetId, v19.AssetId, v19.Balance, v19.AssetId, v19.AccountId])
    ),
    /**
     * Pool was created.
     */
    v55: new EventType(
        'XYK.PoolCreated',
        sts.struct({
            who: v55.AccountId32,
            assetA: sts.number(),
            assetB: sts.number(),
            initialSharesAmount: sts.bigint(),
            shareToken: sts.number(),
            pool: v55.AccountId32,
        })
    ),
}

export const poolDestroyed =  {
    name: 'XYK.PoolDestroyed',
    /**
     *  Pool was destroyed. [who, asset a, asset b]
     */
    v16: new EventType(
        'XYK.PoolDestroyed',
        sts.tuple([v16.AccountId, v16.AssetId, v16.AssetId])
    ),
    /**
     *  Pool was destroyed. [who, asset a, asset b, share token, pool account id]
     */
    v19: new EventType(
        'XYK.PoolDestroyed',
        sts.tuple([v19.AccountId, v19.AssetId, v19.AssetId, v19.AssetId, v19.AccountId])
    ),
    /**
     * Pool was destroyed.
     */
    v55: new EventType(
        'XYK.PoolDestroyed',
        sts.struct({
            who: v55.AccountId32,
            assetA: sts.number(),
            assetB: sts.number(),
            shareToken: sts.number(),
            pool: v55.AccountId32,
        })
    ),
}

export const sellExecuted =  {
    name: 'XYK.SellExecuted',
    /**
     *  Asset sale executed. [who, asset in, asset out, amount, sale price, fee asset, fee amount]
     */
    v16: new EventType(
        'XYK.SellExecuted',
        sts.tuple([v16.AccountId, v16.AssetId, v16.AssetId, v16.Balance, v16.Balance, v16.AssetId, v16.Balance])
    ),
    /**
     *  Asset sale executed. [who, asset in, asset out, amount, sale price, fee asset, fee amount]
     */
    v19: new EventType(
        'XYK.SellExecuted',
        sts.tuple([v19.AccountId, v19.AssetId, v19.AssetId, v19.Balance, v19.Balance, v19.AssetId, v19.Balance, v19.AccountId])
    ),
    /**
     * Asset sale executed.
     */
    v55: new EventType(
        'XYK.SellExecuted',
        sts.struct({
            who: v55.AccountId32,
            assetIn: sts.number(),
            assetOut: sts.number(),
            amount: sts.bigint(),
            salePrice: sts.bigint(),
            feeAsset: sts.number(),
            feeAmount: sts.bigint(),
            pool: v55.AccountId32,
        })
    ),
}

export const buyExecuted =  {
    name: 'XYK.BuyExecuted',
    /**
     *  Asset purchase executed. [who, asset out, asset in, amount, buy price, fee asset, fee amount]
     */
    v16: new EventType(
        'XYK.BuyExecuted',
        sts.tuple([v16.AccountId, v16.AssetId, v16.AssetId, v16.Balance, v16.Balance, v16.AssetId, v16.Balance])
    ),
    /**
     *  Asset purchase executed. [who, asset out, asset in, amount, buy price, fee asset, fee amount]
     */
    v19: new EventType(
        'XYK.BuyExecuted',
        sts.tuple([v19.AccountId, v19.AssetId, v19.AssetId, v19.Balance, v19.Balance, v19.AssetId, v19.Balance, v19.AccountId])
    ),
    /**
     * Asset purchase executed.
     */
    v55: new EventType(
        'XYK.BuyExecuted',
        sts.struct({
            who: v55.AccountId32,
            assetOut: sts.number(),
            assetIn: sts.number(),
            amount: sts.bigint(),
            buyPrice: sts.bigint(),
            feeAsset: sts.number(),
            feeAmount: sts.bigint(),
            pool: v55.AccountId32,
        })
    ),
}
