import {sts, Block, Bytes, Option, Result, EventType, RuntimeCtx} from '../support'
import * as v16 from '../v16'
import * as v25 from '../v25'
import * as v38 from '../v38'
import * as v55 from '../v55'

export const poolCreated =  {
    name: 'LBP.PoolCreated',
    /**
     *  Pool was created by the `CreatePool` origin. [pool_id, pool_data]
     */
    v16: new EventType(
        'LBP.PoolCreated',
        sts.tuple([v16.PoolId, v16.Pool])
    ),
    /**
     * Pool was created by the `CreatePool` origin. [pool_id, pool_data]
     */
    v25: new EventType(
        'LBP.PoolCreated',
        sts.tuple([v25.AccountId32, v25.Pool])
    ),
    /**
     * Pool was created by the `CreatePool` origin. [pool_id, pool_data]
     */
    v38: new EventType(
        'LBP.PoolCreated',
        sts.tuple([v38.AccountId32, v38.Pool])
    ),
    /**
     * Pool was created by the `CreatePool` origin.
     */
    v55: new EventType(
        'LBP.PoolCreated',
        sts.struct({
            pool: v55.AccountId32,
            data: v55.Pool,
        })
    ),
}

export const poolUpdated =  {
    name: 'LBP.PoolUpdated',
    /**
     *  Pool data were updated. [pool_id, pool_data]
     */
    v16: new EventType(
        'LBP.PoolUpdated',
        sts.tuple([v16.PoolId, v16.Pool])
    ),
    /**
     * Pool data were updated. [pool_id, pool_data]
     */
    v25: new EventType(
        'LBP.PoolUpdated',
        sts.tuple([v25.AccountId32, v25.Pool])
    ),
    /**
     * Pool data were updated. [pool_id, pool_data]
     */
    v38: new EventType(
        'LBP.PoolUpdated',
        sts.tuple([v38.AccountId32, v38.Pool])
    ),
    /**
     * Pool data were updated.
     */
    v55: new EventType(
        'LBP.PoolUpdated',
        sts.struct({
            pool: v55.AccountId32,
            data: v55.Pool,
        })
    ),
}

export const liquidityAdded =  {
    name: 'LBP.LiquidityAdded',
    /**
     *  New liquidity was provided to the pool. [who, asset_a, asset_b, amount_a, amount_b]
     */
    v16: new EventType(
        'LBP.LiquidityAdded',
        sts.tuple([v16.AccountId, v16.AssetId, v16.AssetId, v16.BalanceOf, v16.BalanceOf])
    ),
    /**
     * New liquidity was provided to the pool.
     */
    v55: new EventType(
        'LBP.LiquidityAdded',
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
    name: 'LBP.LiquidityRemoved',
    /**
     *  Liquidity was removed from the pool and the pool was destroyed. [who, asset_a, asset_b, amount_a, amount_b]
     */
    v16: new EventType(
        'LBP.LiquidityRemoved',
        sts.tuple([v16.AccountId, v16.AssetId, v16.AssetId, v16.BalanceOf, v16.BalanceOf])
    ),
    /**
     * Liquidity was removed from the pool and the pool was destroyed.
     */
    v55: new EventType(
        'LBP.LiquidityRemoved',
        sts.struct({
            who: v55.AccountId32,
            assetA: sts.number(),
            assetB: sts.number(),
            amountA: sts.bigint(),
            amountB: sts.bigint(),
        })
    ),
}

export const sellExecuted =  {
    name: 'LBP.SellExecuted',
    /**
     *  Sale executed. [who, asset_in, asset_out, amount, sale_price, fee_asset, fee_amount]
     */
    v16: new EventType(
        'LBP.SellExecuted',
        sts.tuple([v16.AccountId, v16.AssetId, v16.AssetId, v16.BalanceOf, v16.BalanceOf, v16.AssetId, v16.BalanceOf])
    ),
    /**
     * Sale executed.
     */
    v55: new EventType(
        'LBP.SellExecuted',
        sts.struct({
            who: v55.AccountId32,
            assetIn: sts.number(),
            assetOut: sts.number(),
            amount: sts.bigint(),
            salePrice: sts.bigint(),
            feeAsset: sts.number(),
            feeAmount: sts.bigint(),
        })
    ),
}

export const buyExecuted =  {
    name: 'LBP.BuyExecuted',
    /**
     *  Purchase executed. [who, asset_out, asset_in, amount, buy_price, fee_asset, fee_amount]
     */
    v16: new EventType(
        'LBP.BuyExecuted',
        sts.tuple([v16.AccountId, v16.AssetId, v16.AssetId, v16.BalanceOf, v16.BalanceOf, v16.AssetId, v16.BalanceOf])
    ),
    /**
     * Purchase executed.
     */
    v55: new EventType(
        'LBP.BuyExecuted',
        sts.struct({
            who: v55.AccountId32,
            assetOut: sts.number(),
            assetIn: sts.number(),
            amount: sts.bigint(),
            buyPrice: sts.bigint(),
            feeAsset: sts.number(),
            feeAmount: sts.bigint(),
        })
    ),
}
