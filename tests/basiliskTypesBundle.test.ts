import { describe, expect, it } from 'vitest'
import { basiliskTypesBundle } from '../src/basiliskTypesBundle.ts'
import { tokensAccountsCodec } from '../src/chainEras.ts'
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

  // The V13 span decodes orml balances by the bundle's field ORDER, and the
  // bundle disagrees with every self-describing runtime: specs 25..134 all
  // declare {free, reserved, frozen}. Nothing on chain settles it — blocks
  // 0-395,663 carry no Tokens/Currencies/Balances event whatsoever, so
  // Tokens.Accounts is empty across the whole V13 span. What makes the
  // disagreement safe is that `free` leads both orders and is the only field
  // read. Pin all three facts: the declared order, `free` first, and that the
  // reserved/frozen pair is the only thing in dispute.
  it('pins the disputed genesis-era orml field order to a harmless one', () => {
    const declared = Object.keys(basiliskTypesBundle.types?.OrmlAccountData as object)
    expect(declared).toEqual(['free', 'frozen', 'reserved'])
    expect(declared[0]).toBe('free')

    // Order as read from the chain's own V14 metadata (specs 25 through 134).
    const selfDescribing = ['free', 'reserved', 'frozen']
    expect(selfDescribing[0]).toBe('free')
    expect([...declared].sort()).toEqual([...selfDescribing].sort())
    expect(declared).not.toEqual(selfDescribing)
  })

  // The only field any reader takes from Tokens.Accounts, in every era.
  it('exposes free as the sole balance field the era selector promises', () => {
    const codec = tokensAccountsCodec({ _runtime: { checkStorageType: () => true } } as never)
    expect(codec).toBe(tokensStorage.accounts.v16)
  })

  // With the alias in place orml-tokens has exactly one balance shape across all
  // 35 spec versions, which is why the era selectors carry a single codec. A second
  // generated version here means a real shape change to route.
  it('leaves Tokens.Accounts with a single generated codec', () => {
    expect(Object.keys(tokensStorage.accounts)).toEqual(['v16'])
  })
})
