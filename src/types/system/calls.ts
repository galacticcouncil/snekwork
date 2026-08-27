import {sts, Block, Bytes, Option, Result, CallType, RuntimeCtx} from '../support'
import * as v16 from '../v16'

export const setStorage =  {
    name: 'System.set_storage',
    /**
     *  Set some items of storage.
     * 
     *  # <weight>
     *  - `O(I)` where `I` length of `items`
     *  - `I` storage writes (`O(1)`).
     *  - Base Weight: 0.568 * i µs
     *  - Writes: Number of items
     *  # </weight>
     */
    v16: new CallType(
        'System.set_storage',
        sts.struct({
            items: sts.array(() => v16.KeyValue),
        })
    ),
}
