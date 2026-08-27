import {sts, Block, Bytes, Option, Result, StorageType, RuntimeCtx} from '../support'
import * as v16 from '../v16'
import * as v19 from '../v19'
import * as v25 from '../v25'
import * as v101 from '../v101'
import * as v108 from '../v108'
import * as v115 from '../v115'
import * as v124 from '../v124'
import * as v128 from '../v128'

export const assets =  {
    /**
     *  Details of an asset.
     */
    v16: new StorageType('AssetRegistry.Assets', 'Optional', [v16.AssetId], v16.AssetDetails) as AssetsV16,
    /**
     *  Details of an asset.
     */
    v25: new StorageType('AssetRegistry.Assets', 'Optional', [sts.number()], v25.AssetDetails) as AssetsV25,
    /**
     *  Details of an asset.
     */
    v101: new StorageType('AssetRegistry.Assets', 'Optional', [sts.number()], v101.AssetDetails) as AssetsV101,
    /**
     *  Details of an asset.
     */
    v108: new StorageType('AssetRegistry.Assets', 'Optional', [sts.number()], v108.AssetDetails) as AssetsV108,
    /**
     *  Details of an asset.
     */
    v115: new StorageType('AssetRegistry.Assets', 'Optional', [sts.number()], v115.AssetDetails) as AssetsV115,
    /**
     *  Details of an asset.
     */
    v124: new StorageType('AssetRegistry.Assets', 'Optional', [sts.number()], v124.AssetDetails) as AssetsV124,
}

/**
 *  Details of an asset.
 */
export interface AssetsV16  {
    is(block: RuntimeCtx): boolean
    get(block: Block, key: v16.AssetId): Promise<(v16.AssetDetails | undefined)>
    getMany(block: Block, keys: v16.AssetId[]): Promise<(v16.AssetDetails | undefined)[]>
    getKeys(block: Block): Promise<v16.AssetId[]>
    getKeys(block: Block, key: v16.AssetId): Promise<v16.AssetId[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<v16.AssetId[]>
    getKeysPaged(pageSize: number, block: Block, key: v16.AssetId): AsyncIterable<v16.AssetId[]>
    getPairs(block: Block): Promise<[k: v16.AssetId, v: (v16.AssetDetails | undefined)][]>
    getPairs(block: Block, key: v16.AssetId): Promise<[k: v16.AssetId, v: (v16.AssetDetails | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: v16.AssetId, v: (v16.AssetDetails | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: v16.AssetId): AsyncIterable<[k: v16.AssetId, v: (v16.AssetDetails | undefined)][]>
}

/**
 *  Details of an asset.
 */
export interface AssetsV25  {
    is(block: RuntimeCtx): boolean
    get(block: Block, key: number): Promise<(v25.AssetDetails | undefined)>
    getMany(block: Block, keys: number[]): Promise<(v25.AssetDetails | undefined)[]>
    getKeys(block: Block): Promise<number[]>
    getKeys(block: Block, key: number): Promise<number[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<number[]>
    getKeysPaged(pageSize: number, block: Block, key: number): AsyncIterable<number[]>
    getPairs(block: Block): Promise<[k: number, v: (v25.AssetDetails | undefined)][]>
    getPairs(block: Block, key: number): Promise<[k: number, v: (v25.AssetDetails | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: number, v: (v25.AssetDetails | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: number): AsyncIterable<[k: number, v: (v25.AssetDetails | undefined)][]>
}

/**
 *  Details of an asset.
 */
export interface AssetsV101  {
    is(block: RuntimeCtx): boolean
    get(block: Block, key: number): Promise<(v101.AssetDetails | undefined)>
    getMany(block: Block, keys: number[]): Promise<(v101.AssetDetails | undefined)[]>
    getKeys(block: Block): Promise<number[]>
    getKeys(block: Block, key: number): Promise<number[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<number[]>
    getKeysPaged(pageSize: number, block: Block, key: number): AsyncIterable<number[]>
    getPairs(block: Block): Promise<[k: number, v: (v101.AssetDetails | undefined)][]>
    getPairs(block: Block, key: number): Promise<[k: number, v: (v101.AssetDetails | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: number, v: (v101.AssetDetails | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: number): AsyncIterable<[k: number, v: (v101.AssetDetails | undefined)][]>
}

/**
 *  Details of an asset.
 */
export interface AssetsV108  {
    is(block: RuntimeCtx): boolean
    get(block: Block, key: number): Promise<(v108.AssetDetails | undefined)>
    getMany(block: Block, keys: number[]): Promise<(v108.AssetDetails | undefined)[]>
    getKeys(block: Block): Promise<number[]>
    getKeys(block: Block, key: number): Promise<number[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<number[]>
    getKeysPaged(pageSize: number, block: Block, key: number): AsyncIterable<number[]>
    getPairs(block: Block): Promise<[k: number, v: (v108.AssetDetails | undefined)][]>
    getPairs(block: Block, key: number): Promise<[k: number, v: (v108.AssetDetails | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: number, v: (v108.AssetDetails | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: number): AsyncIterable<[k: number, v: (v108.AssetDetails | undefined)][]>
}

/**
 *  Details of an asset.
 */
export interface AssetsV115  {
    is(block: RuntimeCtx): boolean
    get(block: Block, key: number): Promise<(v115.AssetDetails | undefined)>
    getMany(block: Block, keys: number[]): Promise<(v115.AssetDetails | undefined)[]>
    getKeys(block: Block): Promise<number[]>
    getKeys(block: Block, key: number): Promise<number[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<number[]>
    getKeysPaged(pageSize: number, block: Block, key: number): AsyncIterable<number[]>
    getPairs(block: Block): Promise<[k: number, v: (v115.AssetDetails | undefined)][]>
    getPairs(block: Block, key: number): Promise<[k: number, v: (v115.AssetDetails | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: number, v: (v115.AssetDetails | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: number): AsyncIterable<[k: number, v: (v115.AssetDetails | undefined)][]>
}

/**
 *  Details of an asset.
 */
export interface AssetsV124  {
    is(block: RuntimeCtx): boolean
    get(block: Block, key: number): Promise<(v124.AssetDetails | undefined)>
    getMany(block: Block, keys: number[]): Promise<(v124.AssetDetails | undefined)[]>
    getKeys(block: Block): Promise<number[]>
    getKeys(block: Block, key: number): Promise<number[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<number[]>
    getKeysPaged(pageSize: number, block: Block, key: number): AsyncIterable<number[]>
    getPairs(block: Block): Promise<[k: number, v: (v124.AssetDetails | undefined)][]>
    getPairs(block: Block, key: number): Promise<[k: number, v: (v124.AssetDetails | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: number, v: (v124.AssetDetails | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: number): AsyncIterable<[k: number, v: (v124.AssetDetails | undefined)][]>
}

export const nextAssetId =  {
    /**
     *  Next available asset id. This is sequential id assigned for each new registered asset.
     */
    v16: new StorageType('AssetRegistry.NextAssetId', 'Default', [], v16.AssetId) as NextAssetIdV16,
}

/**
 *  Next available asset id. This is sequential id assigned for each new registered asset.
 */
export interface NextAssetIdV16  {
    is(block: RuntimeCtx): boolean
    getDefault(block: Block): v16.AssetId
    get(block: Block): Promise<(v16.AssetId | undefined)>
}

export const assetIds =  {
    /**
     *  Mapping between asset name and asset id.
     */
    v16: new StorageType('AssetRegistry.AssetIds', 'Optional', [sts.bytes()], v16.AssetId) as AssetIdsV16,
}

/**
 *  Mapping between asset name and asset id.
 */
export interface AssetIdsV16  {
    is(block: RuntimeCtx): boolean
    get(block: Block, key: Bytes): Promise<(v16.AssetId | undefined)>
    getMany(block: Block, keys: Bytes[]): Promise<(v16.AssetId | undefined)[]>
    getKeys(block: Block): Promise<Bytes[]>
    getKeys(block: Block, key: Bytes): Promise<Bytes[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<Bytes[]>
    getKeysPaged(pageSize: number, block: Block, key: Bytes): AsyncIterable<Bytes[]>
    getPairs(block: Block): Promise<[k: Bytes, v: (v16.AssetId | undefined)][]>
    getPairs(block: Block, key: Bytes): Promise<[k: Bytes, v: (v16.AssetId | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: Bytes, v: (v16.AssetId | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: Bytes): AsyncIterable<[k: Bytes, v: (v16.AssetId | undefined)][]>
}

export const assetLocations =  {
    /**
     *  Native location of an asset.
     */
    v16: new StorageType('AssetRegistry.AssetLocations', 'Optional', [v16.AssetId], v16.AssetNativeLocation) as AssetLocationsV16,
    /**
     *  Native location of an asset.
     */
    v19: new StorageType('AssetRegistry.AssetLocations', 'Optional', [v19.AssetId], v19.AssetNativeLocation) as AssetLocationsV19,
    /**
     *  Native location of an asset.
     */
    v25: new StorageType('AssetRegistry.AssetLocations', 'Optional', [sts.number()], v25.AssetLocation) as AssetLocationsV25,
    /**
     *  Native location of an asset.
     */
    v101: new StorageType('AssetRegistry.AssetLocations', 'Optional', [sts.number()], v101.AssetLocation) as AssetLocationsV101,
    /**
     *  Native location of an asset.
     */
    v115: new StorageType('AssetRegistry.AssetLocations', 'Optional', [sts.number()], v115.AssetLocation) as AssetLocationsV115,
    /**
     *  Native location of an asset.
     */
    v128: new StorageType('AssetRegistry.AssetLocations', 'Optional', [sts.number()], v128.AssetLocation) as AssetLocationsV128,
}

/**
 *  Native location of an asset.
 */
export interface AssetLocationsV16  {
    is(block: RuntimeCtx): boolean
    get(block: Block, key: v16.AssetId): Promise<(v16.AssetNativeLocation | undefined)>
    getMany(block: Block, keys: v16.AssetId[]): Promise<(v16.AssetNativeLocation | undefined)[]>
    getKeys(block: Block): Promise<v16.AssetId[]>
    getKeys(block: Block, key: v16.AssetId): Promise<v16.AssetId[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<v16.AssetId[]>
    getKeysPaged(pageSize: number, block: Block, key: v16.AssetId): AsyncIterable<v16.AssetId[]>
    getPairs(block: Block): Promise<[k: v16.AssetId, v: (v16.AssetNativeLocation | undefined)][]>
    getPairs(block: Block, key: v16.AssetId): Promise<[k: v16.AssetId, v: (v16.AssetNativeLocation | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: v16.AssetId, v: (v16.AssetNativeLocation | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: v16.AssetId): AsyncIterable<[k: v16.AssetId, v: (v16.AssetNativeLocation | undefined)][]>
}

/**
 *  Native location of an asset.
 */
export interface AssetLocationsV19  {
    is(block: RuntimeCtx): boolean
    get(block: Block, key: v19.AssetId): Promise<(v19.AssetNativeLocation | undefined)>
    getMany(block: Block, keys: v19.AssetId[]): Promise<(v19.AssetNativeLocation | undefined)[]>
    getKeys(block: Block): Promise<v19.AssetId[]>
    getKeys(block: Block, key: v19.AssetId): Promise<v19.AssetId[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<v19.AssetId[]>
    getKeysPaged(pageSize: number, block: Block, key: v19.AssetId): AsyncIterable<v19.AssetId[]>
    getPairs(block: Block): Promise<[k: v19.AssetId, v: (v19.AssetNativeLocation | undefined)][]>
    getPairs(block: Block, key: v19.AssetId): Promise<[k: v19.AssetId, v: (v19.AssetNativeLocation | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: v19.AssetId, v: (v19.AssetNativeLocation | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: v19.AssetId): AsyncIterable<[k: v19.AssetId, v: (v19.AssetNativeLocation | undefined)][]>
}

/**
 *  Native location of an asset.
 */
export interface AssetLocationsV25  {
    is(block: RuntimeCtx): boolean
    get(block: Block, key: number): Promise<(v25.AssetLocation | undefined)>
    getMany(block: Block, keys: number[]): Promise<(v25.AssetLocation | undefined)[]>
    getKeys(block: Block): Promise<number[]>
    getKeys(block: Block, key: number): Promise<number[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<number[]>
    getKeysPaged(pageSize: number, block: Block, key: number): AsyncIterable<number[]>
    getPairs(block: Block): Promise<[k: number, v: (v25.AssetLocation | undefined)][]>
    getPairs(block: Block, key: number): Promise<[k: number, v: (v25.AssetLocation | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: number, v: (v25.AssetLocation | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: number): AsyncIterable<[k: number, v: (v25.AssetLocation | undefined)][]>
}

/**
 *  Native location of an asset.
 */
export interface AssetLocationsV101  {
    is(block: RuntimeCtx): boolean
    get(block: Block, key: number): Promise<(v101.AssetLocation | undefined)>
    getMany(block: Block, keys: number[]): Promise<(v101.AssetLocation | undefined)[]>
    getKeys(block: Block): Promise<number[]>
    getKeys(block: Block, key: number): Promise<number[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<number[]>
    getKeysPaged(pageSize: number, block: Block, key: number): AsyncIterable<number[]>
    getPairs(block: Block): Promise<[k: number, v: (v101.AssetLocation | undefined)][]>
    getPairs(block: Block, key: number): Promise<[k: number, v: (v101.AssetLocation | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: number, v: (v101.AssetLocation | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: number): AsyncIterable<[k: number, v: (v101.AssetLocation | undefined)][]>
}

/**
 *  Native location of an asset.
 */
export interface AssetLocationsV115  {
    is(block: RuntimeCtx): boolean
    get(block: Block, key: number): Promise<(v115.AssetLocation | undefined)>
    getMany(block: Block, keys: number[]): Promise<(v115.AssetLocation | undefined)[]>
    getKeys(block: Block): Promise<number[]>
    getKeys(block: Block, key: number): Promise<number[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<number[]>
    getKeysPaged(pageSize: number, block: Block, key: number): AsyncIterable<number[]>
    getPairs(block: Block): Promise<[k: number, v: (v115.AssetLocation | undefined)][]>
    getPairs(block: Block, key: number): Promise<[k: number, v: (v115.AssetLocation | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: number, v: (v115.AssetLocation | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: number): AsyncIterable<[k: number, v: (v115.AssetLocation | undefined)][]>
}

/**
 *  Native location of an asset.
 */
export interface AssetLocationsV128  {
    is(block: RuntimeCtx): boolean
    get(block: Block, key: number): Promise<(v128.AssetLocation | undefined)>
    getMany(block: Block, keys: number[]): Promise<(v128.AssetLocation | undefined)[]>
    getKeys(block: Block): Promise<number[]>
    getKeys(block: Block, key: number): Promise<number[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<number[]>
    getKeysPaged(pageSize: number, block: Block, key: number): AsyncIterable<number[]>
    getPairs(block: Block): Promise<[k: number, v: (v128.AssetLocation | undefined)][]>
    getPairs(block: Block, key: number): Promise<[k: number, v: (v128.AssetLocation | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: number, v: (v128.AssetLocation | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: number): AsyncIterable<[k: number, v: (v128.AssetLocation | undefined)][]>
}

export const assetMetadataMap =  {
    /**
     *  Metadata of an asset.
     */
    v16: new StorageType('AssetRegistry.AssetMetadataMap', 'Optional', [v16.AssetId], v16.AssetMetadata) as AssetMetadataMapV16,
}

/**
 *  Metadata of an asset.
 */
export interface AssetMetadataMapV16  {
    is(block: RuntimeCtx): boolean
    get(block: Block, key: v16.AssetId): Promise<(v16.AssetMetadata | undefined)>
    getMany(block: Block, keys: v16.AssetId[]): Promise<(v16.AssetMetadata | undefined)[]>
    getKeys(block: Block): Promise<v16.AssetId[]>
    getKeys(block: Block, key: v16.AssetId): Promise<v16.AssetId[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<v16.AssetId[]>
    getKeysPaged(pageSize: number, block: Block, key: v16.AssetId): AsyncIterable<v16.AssetId[]>
    getPairs(block: Block): Promise<[k: v16.AssetId, v: (v16.AssetMetadata | undefined)][]>
    getPairs(block: Block, key: v16.AssetId): Promise<[k: v16.AssetId, v: (v16.AssetMetadata | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: v16.AssetId, v: (v16.AssetMetadata | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: v16.AssetId): AsyncIterable<[k: v16.AssetId, v: (v16.AssetMetadata | undefined)][]>
}
