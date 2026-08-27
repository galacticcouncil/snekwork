import { describe, it, expect, vi } from 'vitest'
import { initExplorerService, resolveRelatedAccounts } from '../src/services/explorerService.ts'

// Basilisk has no EVM, so an account has no indexed alias graph to fold: it
// resolves to itself plus its own runtime-truncated EVM form, and the resolution
// costs no query at all. It used to read an EVM alias directory this fork's
// schema does not declare — every per-account endpoint goes through here, so
// that read would have failed the whole account page.
describe('resolveRelatedAccounts', () => {
  const SUBSTRATE = '0xe606906b34077e322f4cf752b19d67d989352d9dad8140488ffde5fc3df4c10e'
  const OWN_EVM_FORM = '0x45544800e606906b34077e322f4cf752b19d67d989352d9d0000000000000000'

  it('resolves an account to itself without querying ClickHouse', async () => {
    const query = vi.fn()
    initExplorerService({ query } as never)

    const resolved = await resolveRelatedAccounts(SUBSTRATE)

    expect(query).not.toHaveBeenCalled()
    expect(resolved?.norm.accountId).toBe(SUBSTRATE)
    expect(resolved?.related).toEqual([SUBSTRATE, OWN_EVM_FORM])
  })

  it('returns null for an input that is not an address', async () => {
    const query = vi.fn()
    initExplorerService({ query } as never)

    expect(await resolveRelatedAccounts('not-an-address')).toBeNull()
    expect(query).not.toHaveBeenCalled()
  })
})
