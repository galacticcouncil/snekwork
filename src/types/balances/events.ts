import {sts, Block, Bytes, Option, Result, EventType, RuntimeCtx} from '../support'
import * as v16 from '../v16'
import * as v25 from '../v25'
import * as v38 from '../v38'
import * as v108 from '../v108'

export const endowed =  {
    name: 'Balances.Endowed',
    /**
     *  An account was created with some free balance. \[account, free_balance\]
     */
    v16: new EventType(
        'Balances.Endowed',
        sts.tuple([v16.AccountId, v16.Balance])
    ),
    /**
     * An account was created with some free balance.
     */
    v38: new EventType(
        'Balances.Endowed',
        sts.struct({
            account: v38.AccountId32,
            freeBalance: sts.bigint(),
        })
    ),
}

export const dustLost =  {
    name: 'Balances.DustLost',
    /**
     *  An account was removed whose balance was non-zero but below ExistentialDeposit,
     *  resulting in an outright loss. \[account, balance\]
     */
    v16: new EventType(
        'Balances.DustLost',
        sts.tuple([v16.AccountId, v16.Balance])
    ),
    /**
     * An account was removed whose balance was non-zero but below ExistentialDeposit,
     * resulting in an outright loss.
     */
    v38: new EventType(
        'Balances.DustLost',
        sts.struct({
            account: v38.AccountId32,
            amount: sts.bigint(),
        })
    ),
}

export const transfer =  {
    name: 'Balances.Transfer',
    /**
     *  Transfer succeeded. \[from, to, value\]
     */
    v16: new EventType(
        'Balances.Transfer',
        sts.tuple([v16.AccountId, v16.AccountId, v16.Balance])
    ),
    /**
     * Transfer succeeded.
     */
    v38: new EventType(
        'Balances.Transfer',
        sts.struct({
            from: v38.AccountId32,
            to: v38.AccountId32,
            amount: sts.bigint(),
        })
    ),
}

export const balanceSet =  {
    name: 'Balances.BalanceSet',
    /**
     *  A balance was set by root. \[who, free, reserved\]
     */
    v16: new EventType(
        'Balances.BalanceSet',
        sts.tuple([v16.AccountId, v16.Balance, v16.Balance])
    ),
    /**
     * A balance was set by root.
     */
    v38: new EventType(
        'Balances.BalanceSet',
        sts.struct({
            who: v38.AccountId32,
            free: sts.bigint(),
            reserved: sts.bigint(),
        })
    ),
    /**
     * A balance was set by root.
     */
    v108: new EventType(
        'Balances.BalanceSet',
        sts.struct({
            who: v108.AccountId32,
            free: sts.bigint(),
        })
    ),
}

export const deposit =  {
    name: 'Balances.Deposit',
    /**
     *  Some amount was deposited (e.g. for transaction fees). \[who, deposit\]
     */
    v16: new EventType(
        'Balances.Deposit',
        sts.tuple([v16.AccountId, v16.Balance])
    ),
    /**
     * Some amount was deposited (e.g. for transaction fees).
     */
    v38: new EventType(
        'Balances.Deposit',
        sts.struct({
            who: v38.AccountId32,
            amount: sts.bigint(),
        })
    ),
}

export const reserved =  {
    name: 'Balances.Reserved',
    /**
     *  Some balance was reserved (moved from free to reserved). \[who, value\]
     */
    v16: new EventType(
        'Balances.Reserved',
        sts.tuple([v16.AccountId, v16.Balance])
    ),
    /**
     * Some balance was reserved (moved from free to reserved).
     */
    v38: new EventType(
        'Balances.Reserved',
        sts.struct({
            who: v38.AccountId32,
            amount: sts.bigint(),
        })
    ),
}

export const unreserved =  {
    name: 'Balances.Unreserved',
    /**
     *  Some balance was unreserved (moved from reserved to free). \[who, value\]
     */
    v16: new EventType(
        'Balances.Unreserved',
        sts.tuple([v16.AccountId, v16.Balance])
    ),
    /**
     * Some balance was unreserved (moved from reserved to free).
     */
    v38: new EventType(
        'Balances.Unreserved',
        sts.struct({
            who: v38.AccountId32,
            amount: sts.bigint(),
        })
    ),
}

export const withdraw =  {
    name: 'Balances.Withdraw',
    /**
     * Some amount was withdrawn from the account (e.g. for transaction fees). \[who, value\]
     */
    v25: new EventType(
        'Balances.Withdraw',
        sts.tuple([v25.AccountId32, sts.bigint()])
    ),
    /**
     * Some amount was withdrawn from the account (e.g. for transaction fees).
     */
    v38: new EventType(
        'Balances.Withdraw',
        sts.struct({
            who: v38.AccountId32,
            amount: sts.bigint(),
        })
    ),
}
