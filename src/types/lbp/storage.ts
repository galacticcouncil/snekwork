import {sts, Block, Bytes, Option, Result, StorageType, RuntimeCtx} from '../support'
import * as v16 from '../v16'
import * as v25 from '../v25'
import * as v38 from '../v38'

export const poolData =  {
    /**
     *  Details of a pool.
     */
    v16: new StorageType('LBP.PoolData', 'Default', [v16.PoolId], v16.Pool) as PoolDataV16,
    /**
     *  Details of a pool.
     */
    v25: new StorageType('LBP.PoolData', 'Default', [v25.AccountId32], v25.Pool) as PoolDataV25,
    /**
     *  Details of a pool.
     */
    v38: new StorageType('LBP.PoolData', 'Optional', [v38.AccountId32], v38.Pool) as PoolDataV38,
}

/**
 *  Details of a pool.
 */
export interface PoolDataV16  {
    is(block: RuntimeCtx): boolean
    getDefault(block: Block): v16.Pool
    get(block: Block, key: v16.PoolId): Promise<(v16.Pool | undefined)>
    getMany(block: Block, keys: v16.PoolId[]): Promise<(v16.Pool | undefined)[]>
    getKeys(block: Block): Promise<v16.PoolId[]>
    getKeys(block: Block, key: v16.PoolId): Promise<v16.PoolId[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<v16.PoolId[]>
    getKeysPaged(pageSize: number, block: Block, key: v16.PoolId): AsyncIterable<v16.PoolId[]>
    getPairs(block: Block): Promise<[k: v16.PoolId, v: (v16.Pool | undefined)][]>
    getPairs(block: Block, key: v16.PoolId): Promise<[k: v16.PoolId, v: (v16.Pool | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: v16.PoolId, v: (v16.Pool | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: v16.PoolId): AsyncIterable<[k: v16.PoolId, v: (v16.Pool | undefined)][]>
}

/**
 *  Details of a pool.
 */
export interface PoolDataV25  {
    is(block: RuntimeCtx): boolean
    getDefault(block: Block): v25.Pool
    get(block: Block, key: v25.AccountId32): Promise<(v25.Pool | undefined)>
    getMany(block: Block, keys: v25.AccountId32[]): Promise<(v25.Pool | undefined)[]>
    getKeys(block: Block): Promise<v25.AccountId32[]>
    getKeys(block: Block, key: v25.AccountId32): Promise<v25.AccountId32[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<v25.AccountId32[]>
    getKeysPaged(pageSize: number, block: Block, key: v25.AccountId32): AsyncIterable<v25.AccountId32[]>
    getPairs(block: Block): Promise<[k: v25.AccountId32, v: (v25.Pool | undefined)][]>
    getPairs(block: Block, key: v25.AccountId32): Promise<[k: v25.AccountId32, v: (v25.Pool | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: v25.AccountId32, v: (v25.Pool | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: v25.AccountId32): AsyncIterable<[k: v25.AccountId32, v: (v25.Pool | undefined)][]>
}

/**
 *  Details of a pool.
 */
export interface PoolDataV38  {
    is(block: RuntimeCtx): boolean
    get(block: Block, key: v38.AccountId32): Promise<(v38.Pool | undefined)>
    getMany(block: Block, keys: v38.AccountId32[]): Promise<(v38.Pool | undefined)[]>
    getKeys(block: Block): Promise<v38.AccountId32[]>
    getKeys(block: Block, key: v38.AccountId32): Promise<v38.AccountId32[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<v38.AccountId32[]>
    getKeysPaged(pageSize: number, block: Block, key: v38.AccountId32): AsyncIterable<v38.AccountId32[]>
    getPairs(block: Block): Promise<[k: v38.AccountId32, v: (v38.Pool | undefined)][]>
    getPairs(block: Block, key: v38.AccountId32): Promise<[k: v38.AccountId32, v: (v38.Pool | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: v38.AccountId32, v: (v38.Pool | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: v38.AccountId32): AsyncIterable<[k: v38.AccountId32, v: (v38.Pool | undefined)][]>
}
