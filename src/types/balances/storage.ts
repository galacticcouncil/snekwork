import {sts, Block, Bytes, Option, Result, StorageType, RuntimeCtx} from '../support'
import * as v16 from '../v16'
import * as v108 from '../v108'

export const totalIssuance =  {
    /**
     *  The total units issued in the system.
     */
    v16: new StorageType('Balances.TotalIssuance', 'Default', [], v16.Balance) as TotalIssuanceV16,
}

/**
 *  The total units issued in the system.
 */
export interface TotalIssuanceV16  {
    is(block: RuntimeCtx): boolean
    getDefault(block: Block): v16.Balance
    get(block: Block): Promise<(v16.Balance | undefined)>
}

export const account =  {
    /**
     *  The balance of an account.
     * 
     *  NOTE: This is only used in the case that this pallet is used to store balances.
     */
    v16: new StorageType('Balances.Account', 'Default', [v16.AccountId], v16.AccountData) as AccountV16,
    /**
     *  The Balances pallet example of storing the balance of an account.
     * 
     *  # Example
     * 
     *  ```nocompile
     *   impl pallet_balances::Config for Runtime {
     *     type AccountStore = StorageMapShim<Self::Account<Runtime>, frame_system::Provider<Runtime>, AccountId, Self::AccountData<Balance>>
     *   }
     *  ```
     * 
     *  You can also store the balance of an account in the `System` pallet.
     * 
     *  # Example
     * 
     *  ```nocompile
     *   impl pallet_balances::Config for Runtime {
     *    type AccountStore = System
     *   }
     *  ```
     * 
     *  But this comes with tradeoffs, storing account balances in the system pallet stores
     *  `frame_system` data alongside the account data contrary to storing account balances in the
     *  `Balances` pallet, which uses a `StorageMap` to store balances data only.
     *  NOTE: This is only used in the case that this pallet is used to store balances.
     */
    v108: new StorageType('Balances.Account', 'Default', [v108.AccountId32], v108.AccountData) as AccountV108,
}

/**
 *  The balance of an account.
 * 
 *  NOTE: This is only used in the case that this pallet is used to store balances.
 */
export interface AccountV16  {
    is(block: RuntimeCtx): boolean
    getDefault(block: Block): v16.AccountData
    get(block: Block, key: v16.AccountId): Promise<(v16.AccountData | undefined)>
    getMany(block: Block, keys: v16.AccountId[]): Promise<(v16.AccountData | undefined)[]>
    getKeys(block: Block): Promise<v16.AccountId[]>
    getKeys(block: Block, key: v16.AccountId): Promise<v16.AccountId[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<v16.AccountId[]>
    getKeysPaged(pageSize: number, block: Block, key: v16.AccountId): AsyncIterable<v16.AccountId[]>
    getPairs(block: Block): Promise<[k: v16.AccountId, v: (v16.AccountData | undefined)][]>
    getPairs(block: Block, key: v16.AccountId): Promise<[k: v16.AccountId, v: (v16.AccountData | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: v16.AccountId, v: (v16.AccountData | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: v16.AccountId): AsyncIterable<[k: v16.AccountId, v: (v16.AccountData | undefined)][]>
}

/**
 *  The Balances pallet example of storing the balance of an account.
 * 
 *  # Example
 * 
 *  ```nocompile
 *   impl pallet_balances::Config for Runtime {
 *     type AccountStore = StorageMapShim<Self::Account<Runtime>, frame_system::Provider<Runtime>, AccountId, Self::AccountData<Balance>>
 *   }
 *  ```
 * 
 *  You can also store the balance of an account in the `System` pallet.
 * 
 *  # Example
 * 
 *  ```nocompile
 *   impl pallet_balances::Config for Runtime {
 *    type AccountStore = System
 *   }
 *  ```
 * 
 *  But this comes with tradeoffs, storing account balances in the system pallet stores
 *  `frame_system` data alongside the account data contrary to storing account balances in the
 *  `Balances` pallet, which uses a `StorageMap` to store balances data only.
 *  NOTE: This is only used in the case that this pallet is used to store balances.
 */
export interface AccountV108  {
    is(block: RuntimeCtx): boolean
    getDefault(block: Block): v108.AccountData
    get(block: Block, key: v108.AccountId32): Promise<(v108.AccountData | undefined)>
    getMany(block: Block, keys: v108.AccountId32[]): Promise<(v108.AccountData | undefined)[]>
    getKeys(block: Block): Promise<v108.AccountId32[]>
    getKeys(block: Block, key: v108.AccountId32): Promise<v108.AccountId32[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<v108.AccountId32[]>
    getKeysPaged(pageSize: number, block: Block, key: v108.AccountId32): AsyncIterable<v108.AccountId32[]>
    getPairs(block: Block): Promise<[k: v108.AccountId32, v: (v108.AccountData | undefined)][]>
    getPairs(block: Block, key: v108.AccountId32): Promise<[k: v108.AccountId32, v: (v108.AccountData | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: v108.AccountId32, v: (v108.AccountData | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: v108.AccountId32): AsyncIterable<[k: v108.AccountId32, v: (v108.AccountData | undefined)][]>
}
