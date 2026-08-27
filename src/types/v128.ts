import {sts, Result, Option, Bytes, BitSequence} from './support'

export interface AssetLocation {
    parents: number
    interior: V5Junctions
}

export type V5Junctions = V5Junctions_Here | V5Junctions_X1 | V5Junctions_X2 | V5Junctions_X3 | V5Junctions_X4 | V5Junctions_X5 | V5Junctions_X6 | V5Junctions_X7 | V5Junctions_X8

export interface V5Junctions_Here {
    __kind: 'Here'
}

export interface V5Junctions_X1 {
    __kind: 'X1'
    value: V5Junction[]
}

export interface V5Junctions_X2 {
    __kind: 'X2'
    value: V5Junction[]
}

export interface V5Junctions_X3 {
    __kind: 'X3'
    value: V5Junction[]
}

export interface V5Junctions_X4 {
    __kind: 'X4'
    value: V5Junction[]
}

export interface V5Junctions_X5 {
    __kind: 'X5'
    value: V5Junction[]
}

export interface V5Junctions_X6 {
    __kind: 'X6'
    value: V5Junction[]
}

export interface V5Junctions_X7 {
    __kind: 'X7'
    value: V5Junction[]
}

export interface V5Junctions_X8 {
    __kind: 'X8'
    value: V5Junction[]
}

export type V5Junction = V5Junction_AccountId32 | V5Junction_AccountIndex64 | V5Junction_AccountKey20 | V5Junction_GeneralIndex | V5Junction_GeneralKey | V5Junction_GlobalConsensus | V5Junction_OnlyChild | V5Junction_PalletInstance | V5Junction_Parachain | V5Junction_Plurality

export interface V5Junction_AccountId32 {
    __kind: 'AccountId32'
    network?: (V5NetworkId | undefined)
    id: Bytes
}

export interface V5Junction_AccountIndex64 {
    __kind: 'AccountIndex64'
    network?: (V5NetworkId | undefined)
    index: bigint
}

export interface V5Junction_AccountKey20 {
    __kind: 'AccountKey20'
    network?: (V5NetworkId | undefined)
    key: Bytes
}

export interface V5Junction_GeneralIndex {
    __kind: 'GeneralIndex'
    value: bigint
}

export interface V5Junction_GeneralKey {
    __kind: 'GeneralKey'
    length: number
    data: Bytes
}

export interface V5Junction_GlobalConsensus {
    __kind: 'GlobalConsensus'
    value: V5NetworkId
}

export interface V5Junction_OnlyChild {
    __kind: 'OnlyChild'
}

export interface V5Junction_PalletInstance {
    __kind: 'PalletInstance'
    value: number
}

export interface V5Junction_Parachain {
    __kind: 'Parachain'
    value: number
}

export interface V5Junction_Plurality {
    __kind: 'Plurality'
    id: V3BodyId
    part: V3BodyPart
}

export type V3BodyPart = V3BodyPart_AtLeastProportion | V3BodyPart_Fraction | V3BodyPart_Members | V3BodyPart_MoreThanProportion | V3BodyPart_Voice

export interface V3BodyPart_AtLeastProportion {
    __kind: 'AtLeastProportion'
    nom: number
    denom: number
}

export interface V3BodyPart_Fraction {
    __kind: 'Fraction'
    nom: number
    denom: number
}

export interface V3BodyPart_Members {
    __kind: 'Members'
    count: number
}

export interface V3BodyPart_MoreThanProportion {
    __kind: 'MoreThanProportion'
    nom: number
    denom: number
}

export interface V3BodyPart_Voice {
    __kind: 'Voice'
}

export type V3BodyId = V3BodyId_Administration | V3BodyId_Defense | V3BodyId_Executive | V3BodyId_Index | V3BodyId_Judicial | V3BodyId_Legislative | V3BodyId_Moniker | V3BodyId_Technical | V3BodyId_Treasury | V3BodyId_Unit

export interface V3BodyId_Administration {
    __kind: 'Administration'
}

export interface V3BodyId_Defense {
    __kind: 'Defense'
}

export interface V3BodyId_Executive {
    __kind: 'Executive'
}

export interface V3BodyId_Index {
    __kind: 'Index'
    value: number
}

export interface V3BodyId_Judicial {
    __kind: 'Judicial'
}

export interface V3BodyId_Legislative {
    __kind: 'Legislative'
}

export interface V3BodyId_Moniker {
    __kind: 'Moniker'
    value: Bytes
}

export interface V3BodyId_Technical {
    __kind: 'Technical'
}

export interface V3BodyId_Treasury {
    __kind: 'Treasury'
}

export interface V3BodyId_Unit {
    __kind: 'Unit'
}

export type V5NetworkId = V5NetworkId_BitcoinCash | V5NetworkId_BitcoinCore | V5NetworkId_ByFork | V5NetworkId_ByGenesis | V5NetworkId_Ethereum | V5NetworkId_Kusama | V5NetworkId_Polkadot | V5NetworkId_PolkadotBulletin

export interface V5NetworkId_BitcoinCash {
    __kind: 'BitcoinCash'
}

export interface V5NetworkId_BitcoinCore {
    __kind: 'BitcoinCore'
}

export interface V5NetworkId_ByFork {
    __kind: 'ByFork'
    blockNumber: bigint
    blockHash: Bytes
}

export interface V5NetworkId_ByGenesis {
    __kind: 'ByGenesis'
    value: Bytes
}

export interface V5NetworkId_Ethereum {
    __kind: 'Ethereum'
    chainId: bigint
}

export interface V5NetworkId_Kusama {
    __kind: 'Kusama'
}

export interface V5NetworkId_Polkadot {
    __kind: 'Polkadot'
}

export interface V5NetworkId_PolkadotBulletin {
    __kind: 'PolkadotBulletin'
}

export const ExecutionType: sts.Type<ExecutionType> = sts.closedEnum(() => {
    return  {
        Batch: sts.number(),
        DCA: sts.tuple(() => [sts.number(), sts.number()]),
        Omnipool: sts.number(),
        Router: sts.number(),
        Xcm: sts.tuple(() => [sts.bytes(), sts.number()]),
        XcmExchange: sts.number(),
    }
})

export type ExecutionType = ExecutionType_Batch | ExecutionType_DCA | ExecutionType_Omnipool | ExecutionType_Router | ExecutionType_Xcm | ExecutionType_XcmExchange

export interface ExecutionType_Batch {
    __kind: 'Batch'
    value: number
}

export interface ExecutionType_DCA {
    __kind: 'DCA'
    value: [number, number]
}

export interface ExecutionType_Omnipool {
    __kind: 'Omnipool'
    value: number
}

export interface ExecutionType_Router {
    __kind: 'Router'
    value: number
}

export interface ExecutionType_Xcm {
    __kind: 'Xcm'
    value: [Bytes, number]
}

export interface ExecutionType_XcmExchange {
    __kind: 'XcmExchange'
    value: number
}

export const Fee: sts.Type<Fee> = sts.struct(() => {
    return  {
        asset: sts.number(),
        amount: sts.bigint(),
        destination: Destination,
    }
})

export const Destination: sts.Type<Destination> = sts.closedEnum(() => {
    return  {
        Account: AccountId32,
        Burned: sts.unit(),
    }
})

export type Destination = Destination_Account | Destination_Burned

export interface Destination_Account {
    __kind: 'Account'
    value: AccountId32
}

export interface Destination_Burned {
    __kind: 'Burned'
}

export type AccountId32 = Bytes

export interface Fee {
    asset: number
    amount: bigint
    destination: Destination
}

export const Asset: sts.Type<Asset> = sts.struct(() => {
    return  {
        asset: sts.number(),
        amount: sts.bigint(),
    }
})

export interface Asset {
    asset: number
    amount: bigint
}

export const TradeOperation: sts.Type<TradeOperation> = sts.closedEnum(() => {
    return  {
        ExactIn: sts.unit(),
        ExactOut: sts.unit(),
        Limit: sts.unit(),
        LiquidityAdd: sts.unit(),
        LiquidityRemove: sts.unit(),
    }
})

export type TradeOperation = TradeOperation_ExactIn | TradeOperation_ExactOut | TradeOperation_Limit | TradeOperation_LiquidityAdd | TradeOperation_LiquidityRemove

export interface TradeOperation_ExactIn {
    __kind: 'ExactIn'
}

export interface TradeOperation_ExactOut {
    __kind: 'ExactOut'
}

export interface TradeOperation_Limit {
    __kind: 'Limit'
}

export interface TradeOperation_LiquidityAdd {
    __kind: 'LiquidityAdd'
}

export interface TradeOperation_LiquidityRemove {
    __kind: 'LiquidityRemove'
}

export const Filler: sts.Type<Filler> = sts.closedEnum(() => {
    return  {
        AAVE: sts.unit(),
        HSM: sts.unit(),
        LBP: sts.unit(),
        OTC: sts.number(),
        Omnipool: sts.unit(),
        Stableswap: sts.number(),
        XYK: sts.number(),
    }
})

export type Filler = Filler_AAVE | Filler_HSM | Filler_LBP | Filler_OTC | Filler_Omnipool | Filler_Stableswap | Filler_XYK

export interface Filler_AAVE {
    __kind: 'AAVE'
}

export interface Filler_HSM {
    __kind: 'HSM'
}

export interface Filler_LBP {
    __kind: 'LBP'
}

export interface Filler_OTC {
    __kind: 'OTC'
    value: number
}

export interface Filler_Omnipool {
    __kind: 'Omnipool'
}

export interface Filler_Stableswap {
    __kind: 'Stableswap'
    value: number
}

export interface Filler_XYK {
    __kind: 'XYK'
    value: number
}

export const AccountId32 = sts.bytes()

export const AssetLocation: sts.Type<AssetLocation> = sts.struct(() => {
    return  {
        parents: sts.number(),
        interior: V5Junctions,
    }
})

export const V5Junctions: sts.Type<V5Junctions> = sts.closedEnum(() => {
    return  {
        Here: sts.unit(),
        X1: sts.array(() => V5Junction),
        X2: sts.array(() => V5Junction),
        X3: sts.array(() => V5Junction),
        X4: sts.array(() => V5Junction),
        X5: sts.array(() => V5Junction),
        X6: sts.array(() => V5Junction),
        X7: sts.array(() => V5Junction),
        X8: sts.array(() => V5Junction),
    }
})

export const V5Junction: sts.Type<V5Junction> = sts.closedEnum(() => {
    return  {
        AccountId32: sts.enumStruct({
            network: sts.option(() => V5NetworkId),
            id: sts.bytes(),
        }),
        AccountIndex64: sts.enumStruct({
            network: sts.option(() => V5NetworkId),
            index: sts.bigint(),
        }),
        AccountKey20: sts.enumStruct({
            network: sts.option(() => V5NetworkId),
            key: sts.bytes(),
        }),
        GeneralIndex: sts.bigint(),
        GeneralKey: sts.enumStruct({
            length: sts.number(),
            data: sts.bytes(),
        }),
        GlobalConsensus: V5NetworkId,
        OnlyChild: sts.unit(),
        PalletInstance: sts.number(),
        Parachain: sts.number(),
        Plurality: sts.enumStruct({
            id: V3BodyId,
            part: V3BodyPart,
        }),
    }
})

export const V3BodyPart: sts.Type<V3BodyPart> = sts.closedEnum(() => {
    return  {
        AtLeastProportion: sts.enumStruct({
            nom: sts.number(),
            denom: sts.number(),
        }),
        Fraction: sts.enumStruct({
            nom: sts.number(),
            denom: sts.number(),
        }),
        Members: sts.enumStruct({
            count: sts.number(),
        }),
        MoreThanProportion: sts.enumStruct({
            nom: sts.number(),
            denom: sts.number(),
        }),
        Voice: sts.unit(),
    }
})

export const V3BodyId: sts.Type<V3BodyId> = sts.closedEnum(() => {
    return  {
        Administration: sts.unit(),
        Defense: sts.unit(),
        Executive: sts.unit(),
        Index: sts.number(),
        Judicial: sts.unit(),
        Legislative: sts.unit(),
        Moniker: sts.bytes(),
        Technical: sts.unit(),
        Treasury: sts.unit(),
        Unit: sts.unit(),
    }
})

export const V5NetworkId: sts.Type<V5NetworkId> = sts.closedEnum(() => {
    return  {
        BitcoinCash: sts.unit(),
        BitcoinCore: sts.unit(),
        ByFork: sts.enumStruct({
            blockNumber: sts.bigint(),
            blockHash: sts.bytes(),
        }),
        ByGenesis: sts.bytes(),
        Ethereum: sts.enumStruct({
            chainId: sts.bigint(),
        }),
        Kusama: sts.unit(),
        Polkadot: sts.unit(),
        PolkadotBulletin: sts.unit(),
    }
})
