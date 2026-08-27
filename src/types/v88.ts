import {sts, Result, Option, Bytes, BitSequence} from './support'

export interface DepositData {
    shares: bigint
    ammPoolId: AccountId32
    yieldFarmEntries: YieldFarmEntry[]
}

export interface YieldFarmEntry {
    globalFarmId: number
    yieldFarmId: number
    valuedShares: bigint
    accumulatedRpvs: FixedU128
    accumulatedClaimedRewards: bigint
    enteredAt: number
    updatedAt: number
    stoppedAtCreation: number
}

export type FixedU128 = bigint

export const DepositData: sts.Type<DepositData> = sts.struct(() => {
    return  {
        shares: sts.bigint(),
        ammPoolId: AccountId32,
        yieldFarmEntries: sts.array(() => YieldFarmEntry),
    }
})

export const YieldFarmEntry: sts.Type<YieldFarmEntry> = sts.struct(() => {
    return  {
        globalFarmId: sts.number(),
        yieldFarmId: sts.number(),
        valuedShares: sts.bigint(),
        accumulatedRpvs: FixedU128,
        accumulatedClaimedRewards: sts.bigint(),
        enteredAt: sts.number(),
        updatedAt: sts.number(),
        stoppedAtCreation: sts.number(),
    }
})

export const FixedU128 = sts.bigint()

export type AccountId32 = Bytes

export interface YieldFarmData {
    id: number
    updatedAt: number
    totalShares: bigint
    totalValuedShares: bigint
    accumulatedRpvs: FixedU128
    accumulatedRpz: FixedU128
    loyaltyCurve?: (LoyaltyCurve | undefined)
    multiplier: FixedU128
    state: FarmState
    entriesCount: bigint
    leftToDistribute: bigint
    totalStopped: number
}

export type FarmState = FarmState_Active | FarmState_Stopped | FarmState_Terminated

export interface FarmState_Active {
    __kind: 'Active'
}

export interface FarmState_Stopped {
    __kind: 'Stopped'
}

export interface FarmState_Terminated {
    __kind: 'Terminated'
}

export interface LoyaltyCurve {
    initialRewardPercentage: FixedU128
    scaleCoef: number
}

export const YieldFarmData: sts.Type<YieldFarmData> = sts.struct(() => {
    return  {
        id: sts.number(),
        updatedAt: sts.number(),
        totalShares: sts.bigint(),
        totalValuedShares: sts.bigint(),
        accumulatedRpvs: FixedU128,
        accumulatedRpz: FixedU128,
        loyaltyCurve: sts.option(() => LoyaltyCurve),
        multiplier: FixedU128,
        state: FarmState,
        entriesCount: sts.bigint(),
        leftToDistribute: sts.bigint(),
        totalStopped: sts.number(),
    }
})

export const FarmState: sts.Type<FarmState> = sts.closedEnum(() => {
    return  {
        Active: sts.unit(),
        Stopped: sts.unit(),
        Terminated: sts.unit(),
    }
})

export const LoyaltyCurve: sts.Type<LoyaltyCurve> = sts.struct(() => {
    return  {
        initialRewardPercentage: FixedU128,
        scaleCoef: sts.number(),
    }
})

export const AccountId32 = sts.bytes()

export interface GlobalFarmData {
    id: number
    owner: AccountId32
    updatedAt: number
    totalSharesZ: bigint
    accumulatedRpz: FixedU128
    rewardCurrency: number
    pendingRewards: bigint
    accumulatedPaidRewards: bigint
    yieldPerPeriod: Perquintill
    plannedYieldingPeriods: number
    blocksPerPeriod: number
    incentivizedAsset: number
    maxRewardPerPeriod: bigint
    minDeposit: bigint
    liveYieldFarmsCount: number
    totalYieldFarmsCount: number
    priceAdjustment: FixedU128
    state: FarmState
}

export type Perquintill = bigint

export const GlobalFarmData: sts.Type<GlobalFarmData> = sts.struct(() => {
    return  {
        id: sts.number(),
        owner: AccountId32,
        updatedAt: sts.number(),
        totalSharesZ: sts.bigint(),
        accumulatedRpz: FixedU128,
        rewardCurrency: sts.number(),
        pendingRewards: sts.bigint(),
        accumulatedPaidRewards: sts.bigint(),
        yieldPerPeriod: Perquintill,
        plannedYieldingPeriods: sts.number(),
        blocksPerPeriod: sts.number(),
        incentivizedAsset: sts.number(),
        maxRewardPerPeriod: sts.bigint(),
        minDeposit: sts.bigint(),
        liveYieldFarmsCount: sts.number(),
        totalYieldFarmsCount: sts.number(),
        priceAdjustment: FixedU128,
        state: FarmState,
    }
})

export const Perquintill = sts.bigint()
