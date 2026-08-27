import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SHARE_TOKEN_UNDERLYING_ID } from '../src/services/explorerAssets.ts'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

// A display asset holds its supply in hidden pool-share ids. getAssetTotals folds
// those into the display asset, so its holder count must come from the same folded
// identity the detail page pages — otherwise an asset with real holders shows "—",
// or names one share pot as its only holder.
describe('assets directory holder counts', () => {
  it('folds share-token holders into every display asset', () => {
    const at = explorerService.indexOf('export async function getAssetHolderCounts')
    const body = explorerService.slice(at, explorerService.indexOf('\n// A display asset holds its supply', at))

    // The one path that returns a count map carries the folded counts.
    const returns = (body.match(/return withFolded\([^\n]*/g) ?? [])
    expect(returns).toHaveLength(1)
  })

  it('groups every configured share token under its display asset', () => {
    const at = explorerService.indexOf('async function foldedDisplayHolderCounts')
    const fn = explorerService.slice(at, explorerService.indexOf('\n}', at))

    expect(fn).toContain('Object.entries(SHARE_TOKEN_UNDERLYING_ID)')
    expect(fn).toContain('getFoldedDisplayAssetHolders(displayId, shareIds)')
    // The mapping is non-empty, so the fold covers real assets.
    expect(Object.keys(SHARE_TOKEN_UNDERLYING_ID).length).toBeGreaterThan(0)
  })
})
