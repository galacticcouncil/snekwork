import {sts, Block, Bytes, Option, Result, StorageType, RuntimeCtx} from '../support'
import * as v16 from '../v16'
import * as v108 from '../v108'

export const account =  {
    /**
     *  The full account information for a particular account ID.
     */
    v16: new StorageType('System.Account', 'Default', [v16.AccountId], v16.AccountInfo) as AccountV16,
    /**
     *  The full account information for a particular account ID.
     */
    v108: new StorageType('System.Account', 'Default', [v108.AccountId32], v108.AccountInfo) as AccountV108,
}

/**
 *  The full account information for a particular account ID.
 */
export interface AccountV16  {
    is(block: RuntimeCtx): boolean
    getDefault(block: Block): v16.AccountInfo
    get(block: Block, key: v16.AccountId): Promise<(v16.AccountInfo | undefined)>
    getMany(block: Block, keys: v16.AccountId[]): Promise<(v16.AccountInfo | undefined)[]>
    getKeys(block: Block): Promise<v16.AccountId[]>
    getKeys(block: Block, key: v16.AccountId): Promise<v16.AccountId[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<v16.AccountId[]>
    getKeysPaged(pageSize: number, block: Block, key: v16.AccountId): AsyncIterable<v16.AccountId[]>
    getPairs(block: Block): Promise<[k: v16.AccountId, v: (v16.AccountInfo | undefined)][]>
    getPairs(block: Block, key: v16.AccountId): Promise<[k: v16.AccountId, v: (v16.AccountInfo | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: v16.AccountId, v: (v16.AccountInfo | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: v16.AccountId): AsyncIterable<[k: v16.AccountId, v: (v16.AccountInfo | undefined)][]>
}

/**
 *  The full account information for a particular account ID.
 */
export interface AccountV108  {
    is(block: RuntimeCtx): boolean
    getDefault(block: Block): v108.AccountInfo
    get(block: Block, key: v108.AccountId32): Promise<(v108.AccountInfo | undefined)>
    getMany(block: Block, keys: v108.AccountId32[]): Promise<(v108.AccountInfo | undefined)[]>
    getKeys(block: Block): Promise<v108.AccountId32[]>
    getKeys(block: Block, key: v108.AccountId32): Promise<v108.AccountId32[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<v108.AccountId32[]>
    getKeysPaged(pageSize: number, block: Block, key: v108.AccountId32): AsyncIterable<v108.AccountId32[]>
    getPairs(block: Block): Promise<[k: v108.AccountId32, v: (v108.AccountInfo | undefined)][]>
    getPairs(block: Block, key: v108.AccountId32): Promise<[k: v108.AccountId32, v: (v108.AccountInfo | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: v108.AccountId32, v: (v108.AccountInfo | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: v108.AccountId32): AsyncIterable<[k: v108.AccountId32, v: (v108.AccountInfo | undefined)][]>
}
