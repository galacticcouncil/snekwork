import { describe, expect, it } from 'vitest'
import { HYDRATION_CHAIN_KEY, localIdentityChain } from '../../src/scripts/identityChains.ts'

const RPC_URL = 'https://basilisk-rpc.example'

describe('identity chain configuration', () => {
  it('reads the local chain at the finalized head, at the highest priority', () => {
    expect(localIdentityChain(RPC_URL)).toEqual({
      key: HYDRATION_CHAIN_KEY,
      url: RPC_URL,
      block: null,
      priority: 0,
    })
  })
})
