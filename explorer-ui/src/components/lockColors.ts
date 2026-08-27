/* ============ lock palette (CVD-validated — fixed, never cycled) ============ */
// Lock types: the SAME entity keeps the SAME hue everywhere, in fixed
// categorical order vote / vesting / other. This is the single source of truth
// for lock colors on the per-account balance breakdown bar.
//
// A lock names the activity that placed it, so it wears that activity's colour:
// governance locks are vote lavender. Vesting leaves red — red means the bad
// outcome now, and vesting is just capital on a schedule — for a teal no
// category claims.
export const LOCK_ORDER = ['vote', 'vesting', 'other'] as const
const LOCK_COLORS: Record<string, string> = {
  vote: 'var(--cat-vote)',
  vesting: 'var(--lock-vesting)',
  other: 'var(--neutral)',
}
export function lockColor(key: string): string { return LOCK_COLORS[key] ?? LOCK_COLORS.other }
