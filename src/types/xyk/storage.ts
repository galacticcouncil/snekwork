import {sts, Block, Bytes, Option, Result, StorageType, RuntimeCtx} from '../support'
import * as v16 from '../v16'
import * as v25 from '../v25'

export const shareToken =  {
    /**
     *  Asset id storage for shared pool tokens
     */
    v16: new StorageType('XYK.ShareToken', 'Default', [v16.AccountId], v16.AssetId) as ShareTokenV16,
}

/**
 *  Asset id storage for shared pool tokens
 */
export interface ShareTokenV16  {
    is(block: RuntimeCtx): boolean
    getDefault(block: Block): v16.AssetId
    get(block: Block, key: v16.AccountId): Promise<(v16.AssetId | undefined)>
    getMany(block: Block, keys: v16.AccountId[]): Promise<(v16.AssetId | undefined)[]>
    getKeys(block: Block): Promise<v16.AccountId[]>
    getKeys(block: Block, key: v16.AccountId): Promise<v16.AccountId[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<v16.AccountId[]>
    getKeysPaged(pageSize: number, block: Block, key: v16.AccountId): AsyncIterable<v16.AccountId[]>
    getPairs(block: Block): Promise<[k: v16.AccountId, v: (v16.AssetId | undefined)][]>
    getPairs(block: Block, key: v16.AccountId): Promise<[k: v16.AccountId, v: (v16.AssetId | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: v16.AccountId, v: (v16.AssetId | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: v16.AccountId): AsyncIterable<[k: v16.AccountId, v: (v16.AssetId | undefined)][]>
}

export const totalLiquidity =  {
    /**
     *  Total liquidity in a pool.
     */
    v16: new StorageType('XYK.TotalLiquidity', 'Default', [v16.AccountId], v16.Balance) as TotalLiquidityV16,
}

/**
 *  Total liquidity in a pool.
 */
export interface TotalLiquidityV16  {
    is(block: RuntimeCtx): boolean
    getDefault(block: Block): v16.Balance
    get(block: Block, key: v16.AccountId): Promise<(v16.Balance | undefined)>
    getMany(block: Block, keys: v16.AccountId[]): Promise<(v16.Balance | undefined)[]>
    getKeys(block: Block): Promise<v16.AccountId[]>
    getKeys(block: Block, key: v16.AccountId): Promise<v16.AccountId[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<v16.AccountId[]>
    getKeysPaged(pageSize: number, block: Block, key: v16.AccountId): AsyncIterable<v16.AccountId[]>
    getPairs(block: Block): Promise<[k: v16.AccountId, v: (v16.Balance | undefined)][]>
    getPairs(block: Block, key: v16.AccountId): Promise<[k: v16.AccountId, v: (v16.Balance | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: v16.AccountId, v: (v16.Balance | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: v16.AccountId): AsyncIterable<[k: v16.AccountId, v: (v16.Balance | undefined)][]>
}

export const poolAssets =  {
    /**
     *  Asset pair in a pool.
     */
    v16: new StorageType('XYK.PoolAssets', 'Default', [v16.AccountId], sts.tuple(() => [v16.AssetId, v16.AssetId])) as PoolAssetsV16,
    /**
     *  Asset pair in a pool.
     */
    v25: new StorageType('XYK.PoolAssets', 'Optional', [v25.AccountId32], sts.tuple(() => [sts.number(), sts.number()])) as PoolAssetsV25,
}

/**
 *  Asset pair in a pool.
 */
export interface PoolAssetsV16  {
    is(block: RuntimeCtx): boolean
    getDefault(block: Block): [v16.AssetId, v16.AssetId]
    get(block: Block, key: v16.AccountId): Promise<([v16.AssetId, v16.AssetId] | undefined)>
    getMany(block: Block, keys: v16.AccountId[]): Promise<([v16.AssetId, v16.AssetId] | undefined)[]>
    getKeys(block: Block): Promise<v16.AccountId[]>
    getKeys(block: Block, key: v16.AccountId): Promise<v16.AccountId[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<v16.AccountId[]>
    getKeysPaged(pageSize: number, block: Block, key: v16.AccountId): AsyncIterable<v16.AccountId[]>
    getPairs(block: Block): Promise<[k: v16.AccountId, v: ([v16.AssetId, v16.AssetId] | undefined)][]>
    getPairs(block: Block, key: v16.AccountId): Promise<[k: v16.AccountId, v: ([v16.AssetId, v16.AssetId] | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: v16.AccountId, v: ([v16.AssetId, v16.AssetId] | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: v16.AccountId): AsyncIterable<[k: v16.AccountId, v: ([v16.AssetId, v16.AssetId] | undefined)][]>
}

/**
 *  Asset pair in a pool.
 */
export interface PoolAssetsV25  {
    is(block: RuntimeCtx): boolean
    get(block: Block, key: v25.AccountId32): Promise<([number, number] | undefined)>
    getMany(block: Block, keys: v25.AccountId32[]): Promise<([number, number] | undefined)[]>
    getKeys(block: Block): Promise<v25.AccountId32[]>
    getKeys(block: Block, key: v25.AccountId32): Promise<v25.AccountId32[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<v25.AccountId32[]>
    getKeysPaged(pageSize: number, block: Block, key: v25.AccountId32): AsyncIterable<v25.AccountId32[]>
    getPairs(block: Block): Promise<[k: v25.AccountId32, v: ([number, number] | undefined)][]>
    getPairs(block: Block, key: v25.AccountId32): Promise<[k: v25.AccountId32, v: ([number, number] | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: v25.AccountId32, v: ([number, number] | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: v25.AccountId32): AsyncIterable<[k: v25.AccountId32, v: ([number, number] | undefined)][]>
}
