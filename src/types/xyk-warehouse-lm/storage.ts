import {sts, Block, Bytes, Option, Result, StorageType, RuntimeCtx} from '../support'
import * as v81 from '../v81'
import * as v88 from '../v88'

export const globalFarm =  {
    v81: new StorageType('XYKWarehouseLM.GlobalFarm', 'Optional', [sts.number()], v81.GlobalFarmData) as GlobalFarmV81,
    v88: new StorageType('XYKWarehouseLM.GlobalFarm', 'Optional', [sts.number()], v88.GlobalFarmData) as GlobalFarmV88,
}

export interface GlobalFarmV81  {
    is(block: RuntimeCtx): boolean
    get(block: Block, key: number): Promise<(v81.GlobalFarmData | undefined)>
    getMany(block: Block, keys: number[]): Promise<(v81.GlobalFarmData | undefined)[]>
    getKeys(block: Block): Promise<number[]>
    getKeys(block: Block, key: number): Promise<number[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<number[]>
    getKeysPaged(pageSize: number, block: Block, key: number): AsyncIterable<number[]>
    getPairs(block: Block): Promise<[k: number, v: (v81.GlobalFarmData | undefined)][]>
    getPairs(block: Block, key: number): Promise<[k: number, v: (v81.GlobalFarmData | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: number, v: (v81.GlobalFarmData | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: number): AsyncIterable<[k: number, v: (v81.GlobalFarmData | undefined)][]>
}

export interface GlobalFarmV88  {
    is(block: RuntimeCtx): boolean
    get(block: Block, key: number): Promise<(v88.GlobalFarmData | undefined)>
    getMany(block: Block, keys: number[]): Promise<(v88.GlobalFarmData | undefined)[]>
    getKeys(block: Block): Promise<number[]>
    getKeys(block: Block, key: number): Promise<number[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<number[]>
    getKeysPaged(pageSize: number, block: Block, key: number): AsyncIterable<number[]>
    getPairs(block: Block): Promise<[k: number, v: (v88.GlobalFarmData | undefined)][]>
    getPairs(block: Block, key: number): Promise<[k: number, v: (v88.GlobalFarmData | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: number, v: (v88.GlobalFarmData | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: number): AsyncIterable<[k: number, v: (v88.GlobalFarmData | undefined)][]>
}

export const yieldFarm =  {
    /**
     *  Yield farm details.
     */
    v81: new StorageType('XYKWarehouseLM.YieldFarm', 'Optional', [v81.AccountId32, sts.number(), sts.number()], v81.YieldFarmData) as YieldFarmV81,
    /**
     *  Yield farm details.
     */
    v88: new StorageType('XYKWarehouseLM.YieldFarm', 'Optional', [v88.AccountId32, sts.number(), sts.number()], v88.YieldFarmData) as YieldFarmV88,
}

/**
 *  Yield farm details.
 */
export interface YieldFarmV81  {
    is(block: RuntimeCtx): boolean
    get(block: Block, key1: v81.AccountId32, key2: number, key3: number): Promise<(v81.YieldFarmData | undefined)>
    getMany(block: Block, keys: [v81.AccountId32, number, number][]): Promise<(v81.YieldFarmData | undefined)[]>
    getKeys(block: Block): Promise<[v81.AccountId32, number, number][]>
    getKeys(block: Block, key1: v81.AccountId32): Promise<[v81.AccountId32, number, number][]>
    getKeys(block: Block, key1: v81.AccountId32, key2: number): Promise<[v81.AccountId32, number, number][]>
    getKeys(block: Block, key1: v81.AccountId32, key2: number, key3: number): Promise<[v81.AccountId32, number, number][]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<[v81.AccountId32, number, number][]>
    getKeysPaged(pageSize: number, block: Block, key1: v81.AccountId32): AsyncIterable<[v81.AccountId32, number, number][]>
    getKeysPaged(pageSize: number, block: Block, key1: v81.AccountId32, key2: number): AsyncIterable<[v81.AccountId32, number, number][]>
    getKeysPaged(pageSize: number, block: Block, key1: v81.AccountId32, key2: number, key3: number): AsyncIterable<[v81.AccountId32, number, number][]>
    getPairs(block: Block): Promise<[k: [v81.AccountId32, number, number], v: (v81.YieldFarmData | undefined)][]>
    getPairs(block: Block, key1: v81.AccountId32): Promise<[k: [v81.AccountId32, number, number], v: (v81.YieldFarmData | undefined)][]>
    getPairs(block: Block, key1: v81.AccountId32, key2: number): Promise<[k: [v81.AccountId32, number, number], v: (v81.YieldFarmData | undefined)][]>
    getPairs(block: Block, key1: v81.AccountId32, key2: number, key3: number): Promise<[k: [v81.AccountId32, number, number], v: (v81.YieldFarmData | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: [v81.AccountId32, number, number], v: (v81.YieldFarmData | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key1: v81.AccountId32): AsyncIterable<[k: [v81.AccountId32, number, number], v: (v81.YieldFarmData | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key1: v81.AccountId32, key2: number): AsyncIterable<[k: [v81.AccountId32, number, number], v: (v81.YieldFarmData | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key1: v81.AccountId32, key2: number, key3: number): AsyncIterable<[k: [v81.AccountId32, number, number], v: (v81.YieldFarmData | undefined)][]>
}

/**
 *  Yield farm details.
 */
export interface YieldFarmV88  {
    is(block: RuntimeCtx): boolean
    get(block: Block, key1: v88.AccountId32, key2: number, key3: number): Promise<(v88.YieldFarmData | undefined)>
    getMany(block: Block, keys: [v88.AccountId32, number, number][]): Promise<(v88.YieldFarmData | undefined)[]>
    getKeys(block: Block): Promise<[v88.AccountId32, number, number][]>
    getKeys(block: Block, key1: v88.AccountId32): Promise<[v88.AccountId32, number, number][]>
    getKeys(block: Block, key1: v88.AccountId32, key2: number): Promise<[v88.AccountId32, number, number][]>
    getKeys(block: Block, key1: v88.AccountId32, key2: number, key3: number): Promise<[v88.AccountId32, number, number][]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<[v88.AccountId32, number, number][]>
    getKeysPaged(pageSize: number, block: Block, key1: v88.AccountId32): AsyncIterable<[v88.AccountId32, number, number][]>
    getKeysPaged(pageSize: number, block: Block, key1: v88.AccountId32, key2: number): AsyncIterable<[v88.AccountId32, number, number][]>
    getKeysPaged(pageSize: number, block: Block, key1: v88.AccountId32, key2: number, key3: number): AsyncIterable<[v88.AccountId32, number, number][]>
    getPairs(block: Block): Promise<[k: [v88.AccountId32, number, number], v: (v88.YieldFarmData | undefined)][]>
    getPairs(block: Block, key1: v88.AccountId32): Promise<[k: [v88.AccountId32, number, number], v: (v88.YieldFarmData | undefined)][]>
    getPairs(block: Block, key1: v88.AccountId32, key2: number): Promise<[k: [v88.AccountId32, number, number], v: (v88.YieldFarmData | undefined)][]>
    getPairs(block: Block, key1: v88.AccountId32, key2: number, key3: number): Promise<[k: [v88.AccountId32, number, number], v: (v88.YieldFarmData | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: [v88.AccountId32, number, number], v: (v88.YieldFarmData | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key1: v88.AccountId32): AsyncIterable<[k: [v88.AccountId32, number, number], v: (v88.YieldFarmData | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key1: v88.AccountId32, key2: number): AsyncIterable<[k: [v88.AccountId32, number, number], v: (v88.YieldFarmData | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key1: v88.AccountId32, key2: number, key3: number): AsyncIterable<[k: [v88.AccountId32, number, number], v: (v88.YieldFarmData | undefined)][]>
}

export const deposit =  {
    /**
     *  Deposit details.
     */
    v81: new StorageType('XYKWarehouseLM.Deposit', 'Optional', [sts.bigint()], v81.DepositData) as DepositV81,
    /**
     *  Deposit details.
     */
    v88: new StorageType('XYKWarehouseLM.Deposit', 'Optional', [sts.bigint()], v88.DepositData) as DepositV88,
}

/**
 *  Deposit details.
 */
export interface DepositV81  {
    is(block: RuntimeCtx): boolean
    get(block: Block, key: bigint): Promise<(v81.DepositData | undefined)>
    getMany(block: Block, keys: bigint[]): Promise<(v81.DepositData | undefined)[]>
    getKeys(block: Block): Promise<bigint[]>
    getKeys(block: Block, key: bigint): Promise<bigint[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<bigint[]>
    getKeysPaged(pageSize: number, block: Block, key: bigint): AsyncIterable<bigint[]>
    getPairs(block: Block): Promise<[k: bigint, v: (v81.DepositData | undefined)][]>
    getPairs(block: Block, key: bigint): Promise<[k: bigint, v: (v81.DepositData | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: bigint, v: (v81.DepositData | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: bigint): AsyncIterable<[k: bigint, v: (v81.DepositData | undefined)][]>
}

/**
 *  Deposit details.
 */
export interface DepositV88  {
    is(block: RuntimeCtx): boolean
    get(block: Block, key: bigint): Promise<(v88.DepositData | undefined)>
    getMany(block: Block, keys: bigint[]): Promise<(v88.DepositData | undefined)[]>
    getKeys(block: Block): Promise<bigint[]>
    getKeys(block: Block, key: bigint): Promise<bigint[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<bigint[]>
    getKeysPaged(pageSize: number, block: Block, key: bigint): AsyncIterable<bigint[]>
    getPairs(block: Block): Promise<[k: bigint, v: (v88.DepositData | undefined)][]>
    getPairs(block: Block, key: bigint): Promise<[k: bigint, v: (v88.DepositData | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: bigint, v: (v88.DepositData | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: bigint): AsyncIterable<[k: bigint, v: (v88.DepositData | undefined)][]>
}

export const activeYieldFarm =  {
    /**
     *  Active(farms able to receive LP shares deposits) yield farms.
     */
    v81: new StorageType('XYKWarehouseLM.ActiveYieldFarm', 'Optional', [v81.AccountId32, sts.number()], sts.number()) as ActiveYieldFarmV81,
}

/**
 *  Active(farms able to receive LP shares deposits) yield farms.
 */
export interface ActiveYieldFarmV81  {
    is(block: RuntimeCtx): boolean
    get(block: Block, key1: v81.AccountId32, key2: number): Promise<(number | undefined)>
    getMany(block: Block, keys: [v81.AccountId32, number][]): Promise<(number | undefined)[]>
    getKeys(block: Block): Promise<[v81.AccountId32, number][]>
    getKeys(block: Block, key1: v81.AccountId32): Promise<[v81.AccountId32, number][]>
    getKeys(block: Block, key1: v81.AccountId32, key2: number): Promise<[v81.AccountId32, number][]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<[v81.AccountId32, number][]>
    getKeysPaged(pageSize: number, block: Block, key1: v81.AccountId32): AsyncIterable<[v81.AccountId32, number][]>
    getKeysPaged(pageSize: number, block: Block, key1: v81.AccountId32, key2: number): AsyncIterable<[v81.AccountId32, number][]>
    getPairs(block: Block): Promise<[k: [v81.AccountId32, number], v: (number | undefined)][]>
    getPairs(block: Block, key1: v81.AccountId32): Promise<[k: [v81.AccountId32, number], v: (number | undefined)][]>
    getPairs(block: Block, key1: v81.AccountId32, key2: number): Promise<[k: [v81.AccountId32, number], v: (number | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: [v81.AccountId32, number], v: (number | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key1: v81.AccountId32): AsyncIterable<[k: [v81.AccountId32, number], v: (number | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key1: v81.AccountId32, key2: number): AsyncIterable<[k: [v81.AccountId32, number], v: (number | undefined)][]>
}
