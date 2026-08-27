import {sts, Block, Bytes, Option, Result, StorageType, RuntimeCtx} from '../support'
import * as v16 from '../v16'

export const totalIssuance =  {
    /**
     *  The total issuance of a token type.
     */
    v16: new StorageType('Tokens.TotalIssuance', 'Default', [v16.CurrencyId], v16.Balance) as TotalIssuanceV16,
}

/**
 *  The total issuance of a token type.
 */
export interface TotalIssuanceV16  {
    is(block: RuntimeCtx): boolean
    getDefault(block: Block): v16.Balance
    get(block: Block, key: v16.CurrencyId): Promise<(v16.Balance | undefined)>
    getMany(block: Block, keys: v16.CurrencyId[]): Promise<(v16.Balance | undefined)[]>
    getKeys(block: Block): Promise<v16.CurrencyId[]>
    getKeys(block: Block, key: v16.CurrencyId): Promise<v16.CurrencyId[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<v16.CurrencyId[]>
    getKeysPaged(pageSize: number, block: Block, key: v16.CurrencyId): AsyncIterable<v16.CurrencyId[]>
    getPairs(block: Block): Promise<[k: v16.CurrencyId, v: (v16.Balance | undefined)][]>
    getPairs(block: Block, key: v16.CurrencyId): Promise<[k: v16.CurrencyId, v: (v16.Balance | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: v16.CurrencyId, v: (v16.Balance | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: v16.CurrencyId): AsyncIterable<[k: v16.CurrencyId, v: (v16.Balance | undefined)][]>
}

export const accounts =  {
    /**
     *  The balance of a token type under an account.
     * 
     *  NOTE: If the total is ever zero, decrease account ref account.
     * 
     *  NOTE: This is only used in the case that this module is used to store
     *  balances.
     */
    v16: new StorageType('Tokens.Accounts', 'Default', [v16.AccountId, v16.CurrencyId], v16.OrmlAccountData) as AccountsV16,
}

/**
 *  The balance of a token type under an account.
 * 
 *  NOTE: If the total is ever zero, decrease account ref account.
 * 
 *  NOTE: This is only used in the case that this module is used to store
 *  balances.
 */
export interface AccountsV16  {
    is(block: RuntimeCtx): boolean
    getDefault(block: Block): v16.OrmlAccountData
    get(block: Block, key1: v16.AccountId, key2: v16.CurrencyId): Promise<(v16.OrmlAccountData | undefined)>
    getMany(block: Block, keys: [v16.AccountId, v16.CurrencyId][]): Promise<(v16.OrmlAccountData | undefined)[]>
    getKeys(block: Block): Promise<[v16.AccountId, v16.CurrencyId][]>
    getKeys(block: Block, key1: v16.AccountId): Promise<[v16.AccountId, v16.CurrencyId][]>
    getKeys(block: Block, key1: v16.AccountId, key2: v16.CurrencyId): Promise<[v16.AccountId, v16.CurrencyId][]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<[v16.AccountId, v16.CurrencyId][]>
    getKeysPaged(pageSize: number, block: Block, key1: v16.AccountId): AsyncIterable<[v16.AccountId, v16.CurrencyId][]>
    getKeysPaged(pageSize: number, block: Block, key1: v16.AccountId, key2: v16.CurrencyId): AsyncIterable<[v16.AccountId, v16.CurrencyId][]>
    getPairs(block: Block): Promise<[k: [v16.AccountId, v16.CurrencyId], v: (v16.OrmlAccountData | undefined)][]>
    getPairs(block: Block, key1: v16.AccountId): Promise<[k: [v16.AccountId, v16.CurrencyId], v: (v16.OrmlAccountData | undefined)][]>
    getPairs(block: Block, key1: v16.AccountId, key2: v16.CurrencyId): Promise<[k: [v16.AccountId, v16.CurrencyId], v: (v16.OrmlAccountData | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: [v16.AccountId, v16.CurrencyId], v: (v16.OrmlAccountData | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key1: v16.AccountId): AsyncIterable<[k: [v16.AccountId, v16.CurrencyId], v: (v16.OrmlAccountData | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key1: v16.AccountId, key2: v16.CurrencyId): AsyncIterable<[k: [v16.AccountId, v16.CurrencyId], v: (v16.OrmlAccountData | undefined)][]>
}
