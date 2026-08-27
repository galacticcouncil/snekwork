import {sts, Block, Bytes, Option, Result, EventType, RuntimeCtx} from '../support'
import * as v124 from '../v124'
import * as v128 from '../v128'

export const swapped =  {
    name: 'Broadcast.Swapped',
    /**
     * Trade executed.
     */
    v124: new EventType(
        'Broadcast.Swapped',
        sts.struct({
            swapper: v124.AccountId32,
            filler: v124.AccountId32,
            fillerType: v124.Filler,
            operation: v124.TradeOperation,
            inputs: sts.array(() => v124.Asset),
            outputs: sts.array(() => v124.Asset),
            fees: sts.array(() => v124.Fee),
            operationStack: sts.array(() => v124.ExecutionType),
        })
    ),
}

export const swapped3 =  {
    name: 'Broadcast.Swapped3',
    /**
     * Trade executed.
     * 
     * Swapped3 is a fixed and renamed version of original Swapped,
     * as Swapped contained wrong input/output amounts for XYK buy trade
     * 
     * Swapped3 is a fixed and renamed version of original Swapped3,
     * as Swapped contained wrong filler account on AAVE trades
     * 
     */
    v128: new EventType(
        'Broadcast.Swapped3',
        sts.struct({
            swapper: v128.AccountId32,
            filler: v128.AccountId32,
            fillerType: v128.Filler,
            operation: v128.TradeOperation,
            inputs: sts.array(() => v128.Asset),
            outputs: sts.array(() => v128.Asset),
            fees: sts.array(() => v128.Fee),
            operationStack: sts.array(() => v128.ExecutionType),
        })
    ),
}
