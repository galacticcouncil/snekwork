import type { ActivityRow } from '../types'

// Activity color coding, across two layers that never compete:
//   CATEGORY  what kind of activity this is — orange trade, blue liquidity,
//             grey movement, purple governance,
//   VALENCE   which way it went — green good, red bad.
// Valence WINS wherever a row has a side, so AYE/NAY read the same here as they
// do on every other surface.
//
// Every surface that colors by category reads from this module, so changing a
// shade is one edit here plus its token in global.css.
//
// A family is a RAMP with one shade per action, not one hue with a light and a
// dark variant. The shades move in lightness AND chroma; a pure lightness ramp
// inside a single hue leaves neighbouring steps indistinguishable at 10px.
export const CAT = {
  // trade — orange
  trade: 'var(--cat-trade)',
  // liquidity — blue
  liquidity: 'var(--cat-liquidity)',
  liquidityRemove: 'var(--cat-liquidity-remove)',
  liquidityCreate: 'var(--cat-liquidity-create)',
  liquidityClaim: 'var(--cat-liquidity-claim)',
  // movement, governance, outcome
  transfer: 'var(--cat-transfer)',
  xcm: 'var(--cat-xcm)',
  vote: 'var(--cat-vote)',
  aye: 'var(--green)',
  nay: 'var(--red)',
  bad: 'var(--cat-bad)',
} as const

// The color a whole category answers to — for the filter chips, the activity
// histogram, and anything else naming a category rather than a single row. Each
// family is represented by its primary shade.
const CATEGORY_COLORS: Record<string, string> = {
  trade: CAT.trade,
  liquidity: CAT.liquidity,
  transfer: CAT.transfer,
  xcm: CAT.xcm,
  vote: CAT.vote,
}
// Charts that are not scoped to a category — the unfiltered activity histogram,
// and the block/extrinsic/event counts, which are not activities at all — take a
// neutral slate, so they never claim a meaning the coding assigned elsewhere.
export const UNFILTERED_COLOR = 'var(--chart-neutral)'
export function categoryColor(type: string): string {
  return CATEGORY_COLORS[type] ?? UNFILTERED_COLOR
}

// A vote's side is valence, not category — AYE and NAY carry the same green and
// red here as in the votes table and the bubble map. Only a sideless vote (a
// collective vote, which has no aye/nay) falls back to the category's lavender.
function voteColor(action: string | null | undefined): string {
  if (/^aye$/i.test(action ?? '')) return CAT.aye
  if (/^nay$/i.test(action ?? '')) return CAT.nay
  return CAT.vote
}
// The feed reports a sideless vote as "Voted"; the badge names the act, like every
// other badge in the table does.
function voteLabel(action: string | null | undefined): string {
  return !action || /^voted$/i.test(action) ? 'Vote' : action
}

// Destroy (pool closure) shares Create's shade rather than a new token — the two
// are the pool's lifecycle bookends, distinct from an ordinary Add/Remove trade,
// and the family has no dedicated closure/negative variant to reach for instead.
const LIQ_COLORS: Record<string, string> = {
  Add: CAT.liquidity, Remove: CAT.liquidityRemove, Create: CAT.liquidityCreate, Destroy: CAT.liquidityCreate, Claim: CAT.liquidityClaim,
}
export const LIQ_LABELS: Record<string, string> = {
  Add: 'Add liquidity', Remove: 'Remove liquidity', Create: 'Create pool', Destroy: 'Destroy pool', Claim: 'Claim LP Rewards',
}

// Label + color for one activity row. Labels are the badges the rest of the app
// names its filters and detail routes after, so they stay in step with
// ACTIVITY_ACTIONS and activitySlug().
export function activityBadge(r: ActivityRow): { label: string; col: string } {
  if (r.type === 'vote') return { label: voteLabel(r.voteAction), col: voteColor(r.voteAction) }
  if (r.type === 'liquidity') {
    const a = r.liqAction ?? ''
    return { label: LIQ_LABELS[a] ?? 'Liquidity', col: LIQ_COLORS[a] ?? CAT.liquidity }
  }
  if (r.type === 'trade') return { label: 'Swap', col: CAT.trade }
  if (r.type === 'transfer') return { label: 'Transfer', col: CAT.transfer }
  if (r.type === 'xcm') return { label: 'Cross-chain', col: CAT.xcm }
  return { label: 'Activity', col: 'var(--text-medium)' }
}
