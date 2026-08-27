import {sts, Block, Bytes, Option, Result, EventType, RuntimeCtx} from '../support'
import * as v16 from '../v16'
import * as v19 from '../v19'
import * as v55 from '../v55'

export const intentionRegistered =  {
    name: 'Exchange.IntentionRegistered',
    /**
     *  Intention registered event
     *  who, asset a, asset b, amount, intention type, intention id
     */
    v16: new EventType(
        'Exchange.IntentionRegistered',
        sts.tuple([v16.AccountId, v16.AssetId, v16.AssetId, v16.Balance, v16.IntentionType, v16.IntentionId])
    ),
    /**
     * Intention registered event
     */
    v55: new EventType(
        'Exchange.IntentionRegistered',
        sts.struct({
            who: v55.AccountId32,
            assetA: sts.number(),
            assetB: sts.number(),
            amount: sts.bigint(),
            intentionType: v55.IntentionType,
            intentionId: v55.H256,
        })
    ),
}

export const intentionResolvedAmmTrade =  {
    name: 'Exchange.IntentionResolvedAMMTrade',
    /**
     *  Intention resolved as AMM Trade
     *  who, intention type, intention id, amount, amount sold/bought
     */
    v16: new EventType(
        'Exchange.IntentionResolvedAMMTrade',
        sts.tuple([v16.AccountId, v16.IntentionType, v16.IntentionId, v16.Balance, v16.Balance])
    ),
    /**
     *  Intention resolved as AMM Trade
     *  [who, intention type, intention id, amount, amount sold/bought, pool account id]
     */
    v19: new EventType(
        'Exchange.IntentionResolvedAMMTrade',
        sts.tuple([v19.AccountId, v19.IntentionType, v19.IntentionId, v19.Balance, v19.Balance, v19.AccountId])
    ),
    /**
     * Intention resolved as AMM Trade
     */
    v55: new EventType(
        'Exchange.IntentionResolvedAMMTrade',
        sts.struct({
            who: v55.AccountId32,
            intentionType: v55.IntentionType,
            intentionId: v55.H256,
            amount: sts.bigint(),
            amountSoldOrBought: sts.bigint(),
            poolAccountId: v55.AccountId32,
        })
    ),
}

export const intentionResolvedDirectTrade =  {
    name: 'Exchange.IntentionResolvedDirectTrade',
    /**
     *  Intention resolved as Direct Trade
     *  who, who - account between which direct trade happens
     *  intention id, intention id - intentions which are being resolved ( fully or partially )
     *  Balance, Balance  - corresponding amounts
     */
    v16: new EventType(
        'Exchange.IntentionResolvedDirectTrade',
        sts.tuple([v16.AccountId, v16.AccountId, v16.IntentionId, v16.IntentionId, v16.Balance, v16.Balance])
    ),
    /**
     * Intention resolved as Direct Trade
     */
    v55: new EventType(
        'Exchange.IntentionResolvedDirectTrade',
        sts.struct({
            accountIdA: v55.AccountId32,
            accountIdB: v55.AccountId32,
            intentionIdA: v55.H256,
            intentionIdB: v55.H256,
            amountA: sts.bigint(),
            amountB: sts.bigint(),
        })
    ),
}

export const intentionResolvedDirectTradeFees =  {
    name: 'Exchange.IntentionResolvedDirectTradeFees',
    /**
     *  Paid fees event
     *  who - account which paid feed
     *  intention id - intention which was resolved
     *  account paid to, asset, amount
     */
    v16: new EventType(
        'Exchange.IntentionResolvedDirectTradeFees',
        sts.tuple([v16.AccountId, v16.IntentionId, v16.AccountId, v16.AssetId, v16.Balance])
    ),
    /**
     * Paid fees event
     */
    v55: new EventType(
        'Exchange.IntentionResolvedDirectTradeFees',
        sts.struct({
            who: v55.AccountId32,
            intentionId: v55.H256,
            feeReceiver: v55.AccountId32,
            assetId: sts.number(),
            feeAmount: sts.bigint(),
        })
    ),
}
