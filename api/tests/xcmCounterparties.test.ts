import { describe, expect, it } from 'vitest'
import { parachainName, ocnChainName, originTxExplorerUrl } from '../src/services/explorerService.ts'

// Basilisk is para 2090 on KUSAMA, so every counterparty id in this explorer is a
// Kusama id. Para numbers are per-relay and heavily reused, so a table left on the
// Polkadot relay does not merely miss chains — it confidently names the wrong one:
// 2000 is Acala there and Karura here, 2004 Moonbeam there and Khala here, 2092
// Zeitgeist there and Kintsugi here. Each of those collisions is pinned below,
// because a wrong chain name on an XCM row is indistinguishable from a right one.
describe('kusama xcm counterparties', () => {
  it('names the Kusama chain at each para id the Polkadot table also claimed', () => {
    expect(parachainName(2000)).toBe('Karura')
    expect(parachainName(2004)).toBe('Khala')
    expect(parachainName(2092)).toBe('Kintsugi')
    expect(parachainName(2001)).toBe('Bifrost')
    expect(parachainName(2023)).toBe('Moonriver')
  })

  it('names Basilisk itself, so a self-referencing journey leg is not a bare id', () => {
    expect(parachainName(2090)).toBe('Basilisk')
  })

  it('falls back to the id rather than inventing a name', () => {
    expect(parachainName(2034)).toBe('Parachain 2034')
  })

  // Ocelloids urns carry their consensus system, and only the kusama one may be
  // read through the parachain table.
  it('resolves a kusama urn through the table and leaves a polkadot one unresolved', () => {
    expect(ocnChainName('urn:ocn:kusama:0')).toBe('Kusama')
    expect(ocnChainName('urn:ocn:kusama:2000')).toBe('Karura')
    expect(ocnChainName('urn:ocn:polkadot:2000')).toBe('Polkadot 2000')
    expect(ocnChainName('urn:ocn:polkadot:0')).toBe('Polkadot')
  })

  // A deep link is only offered where Subscan still serves that chain; most Kusama
  // parachain explorers have been retired, and a link to a 404 is worse than none.
  it('links only chains whose explorer the table actually knows', () => {
    const tx = `0x${'ab'.repeat(32)}`
    expect(originTxExplorerUrl('urn:ocn:kusama:0', tx)).toBe(`https://kusama.subscan.io/extrinsic/${tx}`)
    expect(originTxExplorerUrl('urn:ocn:kusama:1000', tx)).toBe(`https://assethub-kusama.subscan.io/extrinsic/${tx}`)
    expect(originTxExplorerUrl('urn:ocn:kusama:2000', tx)).toBeNull()
    expect(originTxExplorerUrl('urn:ocn:polkadot:0', tx)).toBeNull()
  })
})
