import {sts, Result, Option, Bytes, BitSequence} from './support'

export type PoolId = Bytes

export interface Pool {
    owner: AccountId
    start: BlockNumber
    end: BlockNumber
    assets: AssetPair
    initialWeights: LBPWeight
    finalWeights: LBPWeight
    weightCurve: WeightCurveType
    pausable: boolean
    paused: boolean
    fee: Fee
    feeReceiver: AccountId
}

export interface Fee {
    numerator: number
    denominator: number
}

export type WeightCurveType = WeightCurveType_Linear

export interface WeightCurveType_Linear {
    __kind: 'Linear'
}

export type LBPWeight = number

export interface AssetPair {
    assetIn: AssetId
    assetOut: AssetId
}

export type BlockNumber = number

export interface AssetMetadata {
    symbol: Bytes
    decimals: number
}

export const AssetMetadata: sts.Type<AssetMetadata> = sts.struct(() => {
    return  {
        symbol: sts.bytes(),
        decimals: sts.number(),
    }
})

export type AssetNativeLocation = AssetNativeLocation_Here | AssetNativeLocation_X1 | AssetNativeLocation_X2 | AssetNativeLocation_X3 | AssetNativeLocation_X4 | AssetNativeLocation_X5 | AssetNativeLocation_X6 | AssetNativeLocation_X7 | AssetNativeLocation_X8

export interface AssetNativeLocation_Here {
    __kind: 'Here'
}

export interface AssetNativeLocation_X1 {
    __kind: 'X1'
    value: JunctionV0
}

export interface AssetNativeLocation_X2 {
    __kind: 'X2'
    value: [JunctionV0, JunctionV0]
}

export interface AssetNativeLocation_X3 {
    __kind: 'X3'
    value: [JunctionV0, JunctionV0, JunctionV0]
}

export interface AssetNativeLocation_X4 {
    __kind: 'X4'
    value: [JunctionV0, JunctionV0, JunctionV0, JunctionV0]
}

export interface AssetNativeLocation_X5 {
    __kind: 'X5'
    value: [JunctionV0, JunctionV0, JunctionV0, JunctionV0, JunctionV0]
}

export interface AssetNativeLocation_X6 {
    __kind: 'X6'
    value: [JunctionV0, JunctionV0, JunctionV0, JunctionV0, JunctionV0, JunctionV0]
}

export interface AssetNativeLocation_X7 {
    __kind: 'X7'
    value: [JunctionV0, JunctionV0, JunctionV0, JunctionV0, JunctionV0, JunctionV0, JunctionV0]
}

export interface AssetNativeLocation_X8 {
    __kind: 'X8'
    value: [JunctionV0, JunctionV0, JunctionV0, JunctionV0, JunctionV0, JunctionV0, JunctionV0, JunctionV0]
}

export type JunctionV0 = JunctionV0_AccountId32 | JunctionV0_AccountIndex64 | JunctionV0_AccountKey20 | JunctionV0_GeneralIndex | JunctionV0_GeneralKey | JunctionV0_OnlyChild | JunctionV0_PalletInstance | JunctionV0_Parachain | JunctionV0_Parent | JunctionV0_Plurality

export interface JunctionV0_AccountId32 {
    __kind: 'AccountId32'
    network: NetworkId
    id: AccountId
}

export interface JunctionV0_AccountIndex64 {
    __kind: 'AccountIndex64'
    network: NetworkId
    index: bigint
}

export interface JunctionV0_AccountKey20 {
    __kind: 'AccountKey20'
    network: NetworkId
    key: Bytes
}

export interface JunctionV0_GeneralIndex {
    __kind: 'GeneralIndex'
    value: bigint
}

export interface JunctionV0_GeneralKey {
    __kind: 'GeneralKey'
    value: Bytes
}

export interface JunctionV0_OnlyChild {
    __kind: 'OnlyChild'
}

export interface JunctionV0_PalletInstance {
    __kind: 'PalletInstance'
    value: number
}

export interface JunctionV0_Parachain {
    __kind: 'Parachain'
    value: number
}

export interface JunctionV0_Parent {
    __kind: 'Parent'
}

export interface JunctionV0_Plurality {
    __kind: 'Plurality'
    id: BodyId
    part: BodyPart
}

export type BodyPart = BodyPart_AtLeastProportion | BodyPart_Fraction | BodyPart_Members | BodyPart_MoreThanProportion | BodyPart_Voice

export interface BodyPart_AtLeastProportion {
    __kind: 'AtLeastProportion'
    nom: number
    denom: number
}

export interface BodyPart_Fraction {
    __kind: 'Fraction'
    nom: number
    denom: number
}

export interface BodyPart_Members {
    __kind: 'Members'
    value: number
}

export interface BodyPart_MoreThanProportion {
    __kind: 'MoreThanProportion'
    nom: number
    denom: number
}

export interface BodyPart_Voice {
    __kind: 'Voice'
}

export type BodyId = BodyId_Executive | BodyId_Index | BodyId_Judicial | BodyId_Legislative | BodyId_Named | BodyId_Technical | BodyId_Unit

export interface BodyId_Executive {
    __kind: 'Executive'
}

export interface BodyId_Index {
    __kind: 'Index'
    value: number
}

export interface BodyId_Judicial {
    __kind: 'Judicial'
}

export interface BodyId_Legislative {
    __kind: 'Legislative'
}

export interface BodyId_Named {
    __kind: 'Named'
    value: Bytes
}

export interface BodyId_Technical {
    __kind: 'Technical'
}

export interface BodyId_Unit {
    __kind: 'Unit'
}

export type NetworkId = NetworkId_Any | NetworkId_Kusama | NetworkId_Named | NetworkId_Polkadot

export interface NetworkId_Any {
    __kind: 'Any'
}

export interface NetworkId_Kusama {
    __kind: 'Kusama'
}

export interface NetworkId_Named {
    __kind: 'Named'
    value: Bytes
}

export interface NetworkId_Polkadot {
    __kind: 'Polkadot'
}

export type AssetId = number

export interface AssetDetails {
    name: Bytes
    assetType: AssetType
    existentialDeposit: Balance
    locked: boolean
}

export type AssetType = AssetType_PoolShare | AssetType_Token

export interface AssetType_PoolShare {
    __kind: 'PoolShare'
    value: [AssetId, AssetId]
}

export interface AssetType_Token {
    __kind: 'Token'
}

export const AssetDetails: sts.Type<AssetDetails> = sts.struct(() => {
    return  {
        name: sts.bytes(),
        assetType: AssetType,
        existentialDeposit: Balance,
        locked: sts.boolean(),
    }
})

export interface OrmlAccountData {
    free: Balance
    frozen: Balance
    reserved: Balance
}

export const OrmlAccountData: sts.Type<OrmlAccountData> = sts.struct(() => {
    return  {
        free: Balance,
        frozen: Balance,
        reserved: Balance,
    }
})

export type CurrencyId = number

export interface AccountData {
    free: Balance
    reserved: Balance
    miscFrozen: Balance
    feeFrozen: Balance
}

export const AccountData: sts.Type<AccountData> = sts.struct(() => {
    return  {
        free: Balance,
        reserved: Balance,
        miscFrozen: Balance,
        feeFrozen: Balance,
    }
})

export type Balance = bigint

export type AccountId = Bytes

export interface AccountInfo {
    nonce: Index
    consumers: RefCount
    providers: RefCount
    sufficients: RefCount
    data: AccountData
}

export type RefCount = number

export type Index = number

export const AccountInfo: sts.Type<AccountInfo> = sts.struct(() => {
    return  {
        nonce: Index,
        consumers: RefCount,
        providers: RefCount,
        sufficients: RefCount,
        data: AccountData,
    }
})

export const RefCount = sts.number()

export const Index = sts.number()

export const KeyValue = sts.tuple(() => [StorageKey, StorageData])

export const StorageData = sts.bytes()

export const StorageKey = sts.bytes()

export const BalanceOf = sts.bigint()

export const Pool: sts.Type<Pool> = sts.struct(() => {
    return  {
        owner: AccountId,
        start: BlockNumber,
        end: BlockNumber,
        assets: AssetPair,
        initialWeights: LBPWeight,
        finalWeights: LBPWeight,
        weightCurve: WeightCurveType,
        pausable: sts.boolean(),
        paused: sts.boolean(),
        fee: Fee,
        feeReceiver: AccountId,
    }
})

export const Fee: sts.Type<Fee> = sts.struct(() => {
    return  {
        numerator: sts.number(),
        denominator: sts.number(),
    }
})

export const WeightCurveType: sts.Type<WeightCurveType> = sts.closedEnum(() => {
    return  {
        Linear: sts.unit(),
    }
})

export const LBPWeight = sts.number()

export const AssetPair: sts.Type<AssetPair> = sts.struct(() => {
    return  {
        assetIn: AssetId,
        assetOut: AssetId,
    }
})

export const BlockNumber = sts.number()

export const PoolId = sts.bytes()

export const IntentionId = sts.bytes()

export const IntentionType: sts.Type<IntentionType> = sts.closedEnum(() => {
    return  {
        BUY: sts.unit(),
        SELL: sts.unit(),
    }
})

export type IntentionType = IntentionType_BUY | IntentionType_SELL

export interface IntentionType_BUY {
    __kind: 'BUY'
}

export interface IntentionType_SELL {
    __kind: 'SELL'
}

export const AssetNativeLocation: sts.Type<AssetNativeLocation> = sts.closedEnum(() => {
    return  {
        Here: sts.unit(),
        X1: JunctionV0,
        X2: sts.tuple(() => [JunctionV0, JunctionV0]),
        X3: sts.tuple(() => [JunctionV0, JunctionV0, JunctionV0]),
        X4: sts.tuple(() => [JunctionV0, JunctionV0, JunctionV0, JunctionV0]),
        X5: sts.tuple(() => [JunctionV0, JunctionV0, JunctionV0, JunctionV0, JunctionV0]),
        X6: sts.tuple(() => [JunctionV0, JunctionV0, JunctionV0, JunctionV0, JunctionV0, JunctionV0]),
        X7: sts.tuple(() => [JunctionV0, JunctionV0, JunctionV0, JunctionV0, JunctionV0, JunctionV0, JunctionV0]),
        X8: sts.tuple(() => [JunctionV0, JunctionV0, JunctionV0, JunctionV0, JunctionV0, JunctionV0, JunctionV0, JunctionV0]),
    }
})

export const JunctionV0: sts.Type<JunctionV0> = sts.closedEnum(() => {
    return  {
        AccountId32: sts.enumStruct({
            network: NetworkId,
            id: AccountId,
        }),
        AccountIndex64: sts.enumStruct({
            network: NetworkId,
            index: sts.bigint(),
        }),
        AccountKey20: sts.enumStruct({
            network: NetworkId,
            key: sts.bytes(),
        }),
        GeneralIndex: sts.bigint(),
        GeneralKey: sts.bytes(),
        OnlyChild: sts.unit(),
        PalletInstance: sts.number(),
        Parachain: sts.number(),
        Parent: sts.unit(),
        Plurality: sts.enumStruct({
            id: BodyId,
            part: BodyPart,
        }),
    }
})

export const BodyPart: sts.Type<BodyPart> = sts.closedEnum(() => {
    return  {
        AtLeastProportion: sts.enumStruct({
            nom: sts.number(),
            denom: sts.number(),
        }),
        Fraction: sts.enumStruct({
            nom: sts.number(),
            denom: sts.number(),
        }),
        Members: sts.number(),
        MoreThanProportion: sts.enumStruct({
            nom: sts.number(),
            denom: sts.number(),
        }),
        Voice: sts.unit(),
    }
})

export const BodyId: sts.Type<BodyId> = sts.closedEnum(() => {
    return  {
        Executive: sts.unit(),
        Index: sts.number(),
        Judicial: sts.unit(),
        Legislative: sts.unit(),
        Named: sts.bytes(),
        Technical: sts.unit(),
        Unit: sts.unit(),
    }
})

export const NetworkId: sts.Type<NetworkId> = sts.closedEnum(() => {
    return  {
        Any: sts.unit(),
        Kusama: sts.unit(),
        Named: sts.bytes(),
        Polkadot: sts.unit(),
    }
})

export const AssetType: sts.Type<AssetType> = sts.closedEnum(() => {
    return  {
        PoolShare: sts.tuple(() => [AssetId, AssetId]),
        Token: sts.unit(),
    }
})

export const AssetId = sts.number()

export const CurrencyId = sts.number()

export const Amount = sts.bigint()

export const Currency = sts.number()

export const Balance = sts.bigint()

export const AccountId = sts.bytes()
