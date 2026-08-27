import { describe, expect, it } from 'vitest'
import { basiliskTypesBundle } from '../src/basiliskTypesBundle.ts'
import * as tokensStorage from '../src/types/tokens/storage.ts'

describe('basilisk old-types bundle', () => {
  // V13 metadata (specs 16 and 19, blocks 0-395,663) names both Balances.Account
  // and Tokens.Accounts `AccountData<T::Balance>`, but pallet-balances stores four
  // u128s and orml-tokens stores three. Without this pallet-scoped alias every
  // Tokens.Accounts read in that range — including the default-value decode the raw
  // balance indexer does on every block — dies with "Unexpected EOF". The bundle
  // shipped by @subsquid/substrate-runtime omits it; its hydradx bundle has it.
  it('aliases the genesis-era Tokens AccountData to the orml struct', () => {
    expect(basiliskTypesBundle.typesAlias?.tokens?.AccountData).toBe('OrmlAccountData')
  })

  it('keeps the definitions from the shipped bundle', () => {
    expect(basiliskTypesBundle.types?.OrmlAccountData).toEqual({
      free: 'Balance',
      frozen: 'Balance',
      reserved: 'Balance',
    })
  })

  // With the alias in place orml-tokens has exactly one balance shape across all
  // 35 spec versions, which is why the era selectors carry a single codec. A second
  // generated version here means a real shape change to route.
  it('leaves Tokens.Accounts with a single generated codec', () => {
    expect(Object.keys(tokensStorage.accounts)).toEqual(['v16'])
  })
})
