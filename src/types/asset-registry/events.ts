import {sts, Block, Bytes, Option, Result, EventType, RuntimeCtx} from '../support'
import * as v16 from '../v16'
import * as v19 from '../v19'
import * as v25 from '../v25'
import * as v55 from '../v55'
import * as v101 from '../v101'
import * as v108 from '../v108'
import * as v115 from '../v115'
import * as v124 from '../v124'
import * as v128 from '../v128'

export const registered =  {
    name: 'AssetRegistry.Registered',
    /**
     *  Asset was registered. \[asset_id, name, type\]
     */
    v16: new EventType(
        'AssetRegistry.Registered',
        sts.tuple([v16.AssetId, sts.bytes(), v16.AssetType])
    ),
    /**
     * Asset was registered. \[asset_id, name, type\]
     */
    v25: new EventType(
        'AssetRegistry.Registered',
        sts.tuple([sts.number(), v25.BoundedVec, v25.AssetType])
    ),
    /**
     * Asset was registered.
     */
    v55: new EventType(
        'AssetRegistry.Registered',
        sts.struct({
            assetId: sts.number(),
            assetName: sts.bytes(),
            assetType: v55.AssetType,
        })
    ),
    /**
     * Asset was registered.
     */
    v108: new EventType(
        'AssetRegistry.Registered',
        sts.struct({
            assetId: sts.number(),
            assetName: sts.bytes(),
            assetType: v108.AssetType,
        })
    ),
    /**
     * Asset was registered.
     */
    v115: new EventType(
        'AssetRegistry.Registered',
        sts.struct({
            assetId: sts.number(),
            assetName: sts.bytes(),
            assetType: v115.AssetType,
        })
    ),
    /**
     * Asset was registered.
     */
    v124: new EventType(
        'AssetRegistry.Registered',
        sts.struct({
            assetId: sts.number(),
            assetName: sts.bytes(),
            assetType: v124.AssetType,
        })
    ),
}

export const updated =  {
    name: 'AssetRegistry.Updated',
    /**
     *  Asset was updated. \[asset_id, name, type\]
     */
    v16: new EventType(
        'AssetRegistry.Updated',
        sts.tuple([v16.AssetId, sts.bytes(), v16.AssetType])
    ),
    /**
     * Asset was updated. \[asset_id, name, type\]
     */
    v25: new EventType(
        'AssetRegistry.Updated',
        sts.tuple([sts.number(), v25.BoundedVec, v25.AssetType])
    ),
    /**
     * Asset was updated.
     */
    v55: new EventType(
        'AssetRegistry.Updated',
        sts.struct({
            assetId: sts.number(),
            assetName: sts.bytes(),
            assetType: v55.AssetType,
        })
    ),
    /**
     * Asset was updated.
     */
    v101: new EventType(
        'AssetRegistry.Updated',
        sts.struct({
            assetId: sts.number(),
            assetName: sts.bytes(),
            assetType: v101.AssetType,
            existentialDeposit: sts.bigint(),
            xcmRateLimit: sts.option(() => sts.bigint()),
        })
    ),
    /**
     * Asset was updated.
     */
    v108: new EventType(
        'AssetRegistry.Updated',
        sts.struct({
            assetId: sts.number(),
            assetName: sts.bytes(),
            assetType: v108.AssetType,
            existentialDeposit: sts.bigint(),
            xcmRateLimit: sts.option(() => sts.bigint()),
        })
    ),
    /**
     * Asset was updated.
     */
    v115: new EventType(
        'AssetRegistry.Updated',
        sts.struct({
            assetId: sts.number(),
            assetName: sts.bytes(),
            assetType: v115.AssetType,
            existentialDeposit: sts.bigint(),
            xcmRateLimit: sts.option(() => sts.bigint()),
        })
    ),
    /**
     * Asset was updated.
     */
    v124: new EventType(
        'AssetRegistry.Updated',
        sts.struct({
            assetId: sts.number(),
            assetName: sts.bytes(),
            assetType: v124.AssetType,
            existentialDeposit: sts.bigint(),
            xcmRateLimit: sts.option(() => sts.bigint()),
        })
    ),
}

export const metadataSet =  {
    name: 'AssetRegistry.MetadataSet',
    /**
     *  Metadata set for an asset. \[asset_id, symbol, decimals\]
     */
    v16: new EventType(
        'AssetRegistry.MetadataSet',
        sts.tuple([v16.AssetId, sts.bytes(), sts.number()])
    ),
    /**
     * Metadata set for an asset.
     */
    v55: new EventType(
        'AssetRegistry.MetadataSet',
        sts.struct({
            assetId: sts.number(),
            symbol: sts.bytes(),
            decimals: sts.number(),
        })
    ),
}

export const locationSet =  {
    name: 'AssetRegistry.LocationSet',
    /**
     *  Native location set for an asset. \[asset_id, location\]
     */
    v16: new EventType(
        'AssetRegistry.LocationSet',
        sts.tuple([v16.AssetId, v16.AssetNativeLocation])
    ),
    /**
     *  Native location set for an asset. \[asset_id, location\]
     */
    v19: new EventType(
        'AssetRegistry.LocationSet',
        sts.tuple([v19.AssetId, v19.AssetNativeLocation])
    ),
    /**
     * Native location set for an asset. \[asset_id, location\]
     */
    v25: new EventType(
        'AssetRegistry.LocationSet',
        sts.tuple([sts.number(), v25.AssetLocation])
    ),
    /**
     * Native location set for an asset.
     */
    v55: new EventType(
        'AssetRegistry.LocationSet',
        sts.struct({
            assetId: sts.number(),
            location: v55.AssetLocation,
        })
    ),
    /**
     * Native location set for an asset.
     */
    v101: new EventType(
        'AssetRegistry.LocationSet',
        sts.struct({
            assetId: sts.number(),
            location: v101.AssetLocation,
        })
    ),
    /**
     * Native location set for an asset.
     */
    v115: new EventType(
        'AssetRegistry.LocationSet',
        sts.struct({
            assetId: sts.number(),
            location: v115.AssetLocation,
        })
    ),
    /**
     * Native location set for an asset.
     */
    v128: new EventType(
        'AssetRegistry.LocationSet',
        sts.struct({
            assetId: sts.number(),
            location: v128.AssetLocation,
        })
    ),
}
