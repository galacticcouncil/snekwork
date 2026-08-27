import { describe, expect, it } from 'vitest'
import { activityBadge, categoryColor, CAT, UNFILTERED_COLOR } from '../src/components/activityColors'
import { ACTIVITY_ACTIONS } from '../src/components/ui'
import type { ActivityRow } from '../src/types'

// A row carrying only the fields the badge reads. The rest of ActivityRow is
// irrelevant to the coding, so it is cast in rather than fixtured.
function row(r: Partial<ActivityRow>): ActivityRow {
  return r as ActivityRow
}

// The coding is only worth anything if a hue means one thing. These pin the parts
// that would silently drift: a new action falling through to the grey default, or
// a family leaking into a hue that belongs to another.
describe('activity category coding', () => {
  it('gives every action in the shared filter list a color from its own family', () => {
    const family: Record<string, string[]> = {
      trade: [CAT.trade],
      liquidity: [CAT.liquidity, CAT.liquidityRemove, CAT.liquidityCreate, CAT.liquidityClaim],
      vote: [CAT.vote, CAT.aye, CAT.nay],
      xcm: [CAT.xcm],
    }
    // Build the row shape each action arrives in, mirroring how the server fills them.
    const build: Record<string, (v: string) => ActivityRow> = {
      trade: () => row({ type: 'trade' }),
      liquidity: v => row({ type: 'liquidity', liqAction: v as ActivityRow['liqAction'] }),
      vote: v => row({ type: 'vote', voteAction: v }),
      xcm: () => row({ type: 'xcm' }),
    }
    for (const [type, actions] of Object.entries(ACTIVITY_ACTIONS)) {
      for (const a of actions) {
        const { col, label } = activityBadge(build[type](a.v))
        expect(family[type], `${type} has no declared family`).toBeDefined()
        expect(family[type], `${type}/${a.v} (${label}) fell outside its family`).toContain(col)
      }
    }
  })

  it('never falls through to the unstyled default for a known activity type', () => {
    const types: ActivityRow['type'][] = ['transfer', 'trade', 'xcm', 'liquidity', 'vote']
    for (const type of types) {
      expect(activityBadge(row({ type })).col, type).not.toBe('var(--text-medium)')
    }
  })

  // Valence beats category wherever a row has a side, so these read the same here
  // as in the votes table and the bubble map.
  it('keeps AYE green and NAY red, and leaves lavender for a sideless vote', () => {
    expect(activityBadge(row({ type: 'vote', voteAction: 'Aye' })).col).toBe(CAT.aye)
    expect(activityBadge(row({ type: 'vote', voteAction: 'Nay' })).col).toBe(CAT.nay)
    expect(activityBadge(row({ type: 'vote', voteAction: null })).col).toBe(CAT.vote)
    expect(CAT.aye).toBe('var(--green)')
    expect(CAT.nay).toBe('var(--red)')
  })

  it('names the act "Vote", not the feed\'s "Voted"', () => {
    expect(activityBadge(row({ type: 'vote', voteAction: 'Voted' })).label).toBe('Vote')
    expect(activityBadge(row({ type: 'vote', voteAction: null })).label).toBe('Vote')
    expect(activityBadge(row({ type: 'vote', voteAction: 'Aye' })).label).toBe('Aye')
  })

  // The whole point of the ramp: two actions a reader sees side by side in one
  // feed must never resolve to the same shade.
  it('gives every action in a family its own shade', () => {
    const families: Record<string, ActivityRow[]> = {
      liquidity: ['Add', 'Remove', 'Create', 'Claim'].map(a => row({ type: 'liquidity', liqAction: a as ActivityRow['liqAction'] })),
    }
    for (const [fam, rows] of Object.entries(families)) {
      const cols = rows.map(r => activityBadge(r).col)
      expect(new Set(cols).size, `${fam}: ${cols.join(', ')}`).toBe(cols.length)
    }
  })

  it('keeps movement grey and out of the hues that carry meaning elsewhere', () => {
    const transfer = activityBadge(row({ type: 'transfer' })).col
    const xcm = activityBadge(row({ type: 'xcm' })).col
    expect(transfer).toBe(CAT.transfer)
    expect(xcm).toBe(CAT.xcm)
    expect(transfer).not.toBe(xcm)
    for (const col of [transfer, xcm]) {
      expect([CAT.trade, CAT.liquidity, CAT.vote, CAT.bad]).not.toContain(col)
    }
  })

  it('maps a category to one color for the chips and the histogram, and never colors "all"', () => {
    expect(categoryColor('trade')).toBe(CAT.trade)
    expect(categoryColor('liquidity')).toBe(CAT.liquidity)
    expect(categoryColor('vote')).toBe(CAT.vote)
    // An unfiltered view is not a category; it takes a neutral slate no family owns.
    expect(categoryColor('all')).toBe(UNFILTERED_COLOR)
    expect(UNFILTERED_COLOR).toBe('var(--chart-neutral)')
  })
})
