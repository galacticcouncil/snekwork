import {sts, Block, Bytes, Option, Result, EventType, RuntimeCtx} from '../support'
import * as v16 from '../v16'
import * as v38 from '../v38'

export const transferred =  {
    name: 'Currencies.Transferred',
    /**
     *  Currency transfer success. \[currency_id, from, to, amount\]
     */
    v16: new EventType(
        'Currencies.Transferred',
        sts.tuple([v16.Currency, v16.AccountId, v16.AccountId, v16.Balance])
    ),
    /**
     * Currency transfer success.
     */
    v38: new EventType(
        'Currencies.Transferred',
        sts.struct({
            currencyId: sts.number(),
            from: v38.AccountId32,
            to: v38.AccountId32,
            amount: sts.bigint(),
        })
    ),
}

export const balanceUpdated =  {
    name: 'Currencies.BalanceUpdated',
    /**
     *  Update balance success. \[currency_id, who, amount\]
     */
    v16: new EventType(
        'Currencies.BalanceUpdated',
        sts.tuple([v16.Currency, v16.AccountId, v16.Amount])
    ),
    /**
     * Update balance success.
     */
    v38: new EventType(
        'Currencies.BalanceUpdated',
        sts.struct({
            currencyId: sts.number(),
            who: v38.AccountId32,
            amount: sts.bigint(),
        })
    ),
}

export const deposited =  {
    name: 'Currencies.Deposited',
    /**
     *  Deposit success. \[currency_id, who, amount\]
     */
    v16: new EventType(
        'Currencies.Deposited',
        sts.tuple([v16.Currency, v16.AccountId, v16.Balance])
    ),
    /**
     * Deposit success.
     */
    v38: new EventType(
        'Currencies.Deposited',
        sts.struct({
            currencyId: sts.number(),
            who: v38.AccountId32,
            amount: sts.bigint(),
        })
    ),
}

export const withdrawn =  {
    name: 'Currencies.Withdrawn',
    /**
     *  Withdraw success. \[currency_id, who, amount\]
     */
    v16: new EventType(
        'Currencies.Withdrawn',
        sts.tuple([v16.Currency, v16.AccountId, v16.Balance])
    ),
    /**
     * Withdraw success.
     */
    v38: new EventType(
        'Currencies.Withdrawn',
        sts.struct({
            currencyId: sts.number(),
            who: v38.AccountId32,
            amount: sts.bigint(),
        })
    ),
}
