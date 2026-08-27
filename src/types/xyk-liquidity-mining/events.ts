import {sts, Block, Bytes, Option, Result, EventType, RuntimeCtx} from '../support'
import * as v81 from '../v81'

export const sharesDeposited =  {
    name: 'XYKLiquidityMining.SharesDeposited',
    /**
     * New LP tokens was deposited.
     */
    v81: new EventType(
        'XYKLiquidityMining.SharesDeposited',
        sts.struct({
            globalFarmId: sts.number(),
            yieldFarmId: sts.number(),
            who: v81.AccountId32,
            amount: sts.bigint(),
            lpToken: sts.number(),
            depositId: sts.bigint(),
        })
    ),
}

export const sharesRedeposited =  {
    name: 'XYKLiquidityMining.SharesRedeposited',
    /**
     * LP token was redeposited for a new yield farm entry
     */
    v81: new EventType(
        'XYKLiquidityMining.SharesRedeposited',
        sts.struct({
            globalFarmId: sts.number(),
            yieldFarmId: sts.number(),
            who: v81.AccountId32,
            amount: sts.bigint(),
            lpToken: sts.number(),
            depositId: sts.bigint(),
        })
    ),
}

export const rewardClaimed =  {
    name: 'XYKLiquidityMining.RewardClaimed',
    /**
     * Rewards was claimed.
     */
    v81: new EventType(
        'XYKLiquidityMining.RewardClaimed',
        sts.struct({
            globalFarmId: sts.number(),
            yieldFarmId: sts.number(),
            who: v81.AccountId32,
            claimed: sts.bigint(),
            rewardCurrency: sts.number(),
            depositId: sts.bigint(),
        })
    ),
}

export const sharesWithdrawn =  {
    name: 'XYKLiquidityMining.SharesWithdrawn',
    /**
     * LP tokens was withdrawn.
     */
    v81: new EventType(
        'XYKLiquidityMining.SharesWithdrawn',
        sts.struct({
            globalFarmId: sts.number(),
            yieldFarmId: sts.number(),
            who: v81.AccountId32,
            lpToken: sts.number(),
            amount: sts.bigint(),
            depositId: sts.bigint(),
        })
    ),
}
