import {sts, Block, Bytes, Option, Result, EventType, RuntimeCtx} from '../support'
import * as v16 from '../v16'
import * as v38 from '../v38'
import * as v81 from '../v81'

export const endowed =  {
    name: 'Tokens.Endowed',
    /**
     *  An account was created with some free balance. \[currency_id,
     *  account, free_balance\]
     */
    v16: new EventType(
        'Tokens.Endowed',
        sts.tuple([v16.CurrencyId, v16.AccountId, v16.Balance])
    ),
    /**
     * An account was created with some free balance.
     */
    v38: new EventType(
        'Tokens.Endowed',
        sts.struct({
            currencyId: sts.number(),
            who: v38.AccountId32,
            amount: sts.bigint(),
        })
    ),
}

export const dustLost =  {
    name: 'Tokens.DustLost',
    /**
     *  An account was removed whose balance was non-zero but below
     *  ExistentialDeposit, resulting in an outright loss. \[currency_id,
     *  account, balance\]
     */
    v16: new EventType(
        'Tokens.DustLost',
        sts.tuple([v16.CurrencyId, v16.AccountId, v16.Balance])
    ),
    /**
     * An account was removed whose balance was non-zero but below
     * ExistentialDeposit, resulting in an outright loss.
     */
    v38: new EventType(
        'Tokens.DustLost',
        sts.struct({
            currencyId: sts.number(),
            who: v38.AccountId32,
            amount: sts.bigint(),
        })
    ),
}

export const transfer =  {
    name: 'Tokens.Transfer',
    /**
     *  Transfer succeeded. \[currency_id, from, to, value\]
     */
    v16: new EventType(
        'Tokens.Transfer',
        sts.tuple([v16.CurrencyId, v16.AccountId, v16.AccountId, v16.Balance])
    ),
    /**
     * Transfer succeeded.
     */
    v38: new EventType(
        'Tokens.Transfer',
        sts.struct({
            currencyId: sts.number(),
            from: v38.AccountId32,
            to: v38.AccountId32,
            amount: sts.bigint(),
        })
    ),
}

export const reserved =  {
    name: 'Tokens.Reserved',
    /**
     *  Some balance was reserved (moved from free to reserved).
     *  \[currency_id, who, value\]
     */
    v16: new EventType(
        'Tokens.Reserved',
        sts.tuple([v16.CurrencyId, v16.AccountId, v16.Balance])
    ),
    /**
     * Some balance was reserved (moved from free to reserved).
     */
    v38: new EventType(
        'Tokens.Reserved',
        sts.struct({
            currencyId: sts.number(),
            who: v38.AccountId32,
            amount: sts.bigint(),
        })
    ),
}

export const unreserved =  {
    name: 'Tokens.Unreserved',
    /**
     *  Some balance was unreserved (moved from reserved to free).
     *  \[currency_id, who, value\]
     */
    v16: new EventType(
        'Tokens.Unreserved',
        sts.tuple([v16.CurrencyId, v16.AccountId, v16.Balance])
    ),
    /**
     * Some balance was unreserved (moved from reserved to free).
     */
    v38: new EventType(
        'Tokens.Unreserved',
        sts.struct({
            currencyId: sts.number(),
            who: v38.AccountId32,
            amount: sts.bigint(),
        })
    ),
}

export const balanceSet =  {
    name: 'Tokens.BalanceSet',
    /**
     *  A balance was set by root. \[who, free, reserved\]
     */
    v16: new EventType(
        'Tokens.BalanceSet',
        sts.tuple([v16.CurrencyId, v16.AccountId, v16.Balance, v16.Balance])
    ),
    /**
     * A balance was set by root.
     */
    v38: new EventType(
        'Tokens.BalanceSet',
        sts.struct({
            currencyId: sts.number(),
            who: v38.AccountId32,
            free: sts.bigint(),
            reserved: sts.bigint(),
        })
    ),
}

export const withdrawn =  {
    name: 'Tokens.Withdrawn',
    /**
     * Some balances were withdrawn (e.g. pay for transaction fee)
     */
    v81: new EventType(
        'Tokens.Withdrawn',
        sts.struct({
            currencyId: sts.number(),
            who: v81.AccountId32,
            amount: sts.bigint(),
        })
    ),
}

export const deposited =  {
    name: 'Tokens.Deposited',
    /**
     * Deposited some balance into an account
     */
    v81: new EventType(
        'Tokens.Deposited',
        sts.struct({
            currencyId: sts.number(),
            who: v81.AccountId32,
            amount: sts.bigint(),
        })
    ),
}
