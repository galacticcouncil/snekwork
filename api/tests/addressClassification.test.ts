import { describe, it, expect, vi } from 'vitest'
import { initExplorerService, resolveRelatedAccounts } from '../src/services/explorerService.ts'

// Basilisk has no EVM and no bridge aliasing, so an account has no alias graph to
// fold: it resolves to exactly itself, and the resolution costs no query at all. It
// used to read an EVM alias directory this fork's schema does not declare, and then
// to carry a truncated ETH-marker twin of every account — an id no Basilisk row can
// hold, which doubled every account-scoped SQL list for nothing. Every per-account
// endpoint scopes its reads through this set.
describe('resolveRelatedAccounts', () => {
  const SUBSTRATE = '0xe606906b34077e322f4cf752b19d67d989352d9dad8140488ffde5fc3df4c10e'

  it('resolves an account to itself without querying ClickHouse', async () => {
    const query = vi.fn()
    initExplorerService({ query } as never)

    const resolved = await resolveRelatedAccounts(SUBSTRATE)

    expect(query).not.toHaveBeenCalled()
    expect(resolved?.norm.accountId).toBe(SUBSTRATE)
    expect(resolved?.related).toEqual([SUBSTRATE])
  })

  // A bare 20-byte input is an address here only when it is the runtime truncation
  // of a reserved ('modl'/'sibl'/'para') account — the shape an AccountKey20 XCM
  // junction can carry. Anything else 20 bytes wide names no account on this chain.
  it('recovers a reserved truncation and rejects any other H160', async () => {
    initExplorerService({ query: vi.fn() } as never)

    const sovereign = await resolveRelatedAccounts('0x7369626c32080000000000000000000000000000')
    expect(sovereign?.norm.accountId).toBe('0x7369626c32080000000000000000000000000000000000000000000000000000')
    expect(await resolveRelatedAccounts('0xf1db8c4bfbb3d6a97c9b669a2ffc0b70f41f3547')).toBeNull()
  })

  it('returns null for an input that is not an address', async () => {
    const query = vi.fn()
    initExplorerService({ query } as never)

    expect(await resolveRelatedAccounts('not-an-address')).toBeNull()
    expect(query).not.toHaveBeenCalled()
  })
})
