import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SHARE_TOKEN_UNDERLYING_ID } from '../src/services/explorerAssets.ts'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

// A display asset can hold part of its supply under hidden folded ids. getAssetTotals
// folds those into the display asset, so its holder count must come from the same
// folded identity the detail page pages — otherwise an asset with real holders shows
// "—", or names one folded pot as its only holder. SHARE_TOKEN_UNDERLYING_ID is empty
// on Basilisk, so the fold currently covers nothing; what is pinned here is that the
// count arm reads that table rather than a second definition of its own, which is
// what would let the two surfaces disagree the moment an entry is added.
describe('assets directory holder counts', () => {
  it('folds share-token holders into every display asset', () => {
    const at = explorerService.indexOf('export async function getAssetHolderCounts')
    const body = explorerService.slice(at, explorerService.indexOf('\n// A display asset holds its supply', at))

    // The one path that returns a count map carries the folded counts.
    const returns = (body.match(/return withFolded\([^\n]*/g) ?? [])
    expect(returns).toHaveLength(1)
  })

  it('groups every folded asset under its display asset, from the shared table', () => {
    const at = explorerService.indexOf('async function foldedDisplayHolderCounts')
    const fn = explorerService.slice(at, explorerService.indexOf('\n}', at))

    expect(fn).toContain('Object.entries(SHARE_TOKEN_UNDERLYING_ID)')
    expect(fn).toContain('getFoldedDisplayAssetHolders(displayId, shareIds)')
    // Nothing folds today; the arm must still be a no-op rather than a wrong count.
    expect(Object.keys(SHARE_TOKEN_UNDERLYING_ID)).toHaveLength(0)
  })
})
