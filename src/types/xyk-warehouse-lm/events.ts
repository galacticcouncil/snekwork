import {sts, Block, Bytes, Option, Result, EventType, RuntimeCtx} from '../support'
import * as v81 from '../v81'

export const globalFarmAccRpzUpdated =  {
    name: 'XYKWarehouseLM.GlobalFarmAccRPZUpdated',
    /**
     * Global farm accumulated reward per share was updated.
     */
    v81: new EventType(
        'XYKWarehouseLM.GlobalFarmAccRPZUpdated',
        sts.struct({
            globalFarmId: sts.number(),
            accumulatedRpz: v81.FixedU128,
            totalSharesZ: sts.bigint(),
        })
    ),
}

export const yieldFarmAccRpvsUpdated =  {
    name: 'XYKWarehouseLM.YieldFarmAccRPVSUpdated',
    /**
     * Yield farm accumulated reward per valued share was updated.
     */
    v81: new EventType(
        'XYKWarehouseLM.YieldFarmAccRPVSUpdated',
        sts.struct({
            globalFarmId: sts.number(),
            yieldFarmId: sts.number(),
            accumulatedRpvs: v81.FixedU128,
            totalValuedShares: sts.bigint(),
        })
    ),
}
