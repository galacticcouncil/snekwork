import { nodeApi } from './nodeApi.ts'

// Runtime constants read straight out of the node's METADATA.
//
// The node connection (nodeApi.ts) holds a connected ApiPromise for the whole
// process lifetime, and a runtime's `#[pallet::constant]` values are decoded
// into that object when the metadata loads. Reading one is therefore a property
// access on an in-memory object — no round trip, nothing to cache, nothing to
// budget against the archive node. This module is the seam that makes those
// values available to services that must otherwise PIN them in code.
//
// Every reader returns null when the value cannot be had — the node connection
// failed, the pallet is absent, or the constant is not published. Null means "the chain could not
// be consulted"; it must never be treated as a value, and every caller here
// falls back to a documented pin.
//
// Verified against the live Basilisk runtime (spec 134, Aug 2026):
//   aura.slotDuration                   = 6000      (the SLOT, not the block)
//   system.blockHashCount               = 250       (a bare count, see below)
//   treasury.spendPeriod                = 129600    (3 days of 2s blocks)
//   convictionVoting.voteLockingPeriod  = 302400    (7 days of 2s blocks)

function constantBigInt(pallet: string, name: string): bigint | null {
  const api = nodeApi()
  if (!api) return null
  try {
    const consts = (api.consts as Record<string, Record<string, unknown> | undefined>)[pallet]
    const value = consts?.[name] as { toBigInt?: () => bigint; toString: () => string } | undefined
    if (value == null) return null
    return value.toBigInt ? value.toBigInt() : BigInt(value.toString())
  } catch {
    return null
  }
}

function constantNumber(pallet: string, name: string, max: number): number | null {
  const raw = constantBigInt(pallet, name)
  if (raw == null || raw <= 0n || raw > BigInt(max)) return null
  return Number(raw)
}

// `aura.slotDuration` — the AUTHOR SLOT length, which is NOT the block time and
// must never be used as one.
//
// Basilisk's spec-134 upgrade decoupled the two: SLOT_DURATION stays 6000 while
// MILLISECS_PER_BLOCK becomes 2000 and `AllowMultipleBlocksPerSlot` lets one
// author produce 3 blocks inside its slot. Read at block 8,000,000 (spec 123,
// a 6s chain), at 13,000,000 (spec 128, still 6s) and at the head (spec 134, a
// measured 2.2s chain), this constant reads 6000 at all three — the one metadata
// constant that looks authoritative about the block time and silently is not.
// It is kept because the slot length is a real quantity, but the block time
// comes from `runtimeParaBlockMs()` below.
export function runtimeSlotDurationMs(): number | null {
  return constantNumber('aura', 'slotDuration', 600_000)
}

// Wall-clock premises behind the two constants the block time is derived from.
// Each is a fixed DURATION the runtime expresses in blocks, so dividing it by the
// published block count yields the milliseconds per block in whatever era the
// chain is in. Both are confirmed to be durations rather than block counts by
// reading them across Basilisk's own block-time changes — each was restated by
// exactly the ratio of the change while its wall-clock value stayed put:
//
//                        spec 105 (12s)   spec 123/128 (6s)   spec 134 (2s)
//   treasury.spendPeriod       21 600            43 200          129 600   = 3d
//   convictionVoting
//     .voteLockingPeriod            —           100 800          302 400   = 7d
//
// `system.blockHashCount` is deliberately NOT among them: Basilisk publishes the
// substrate default 250 and left it at 250 through both changes, so it is a bare
// count carrying no duration to divide.
const SPEND_PERIOD_MS = 3 * 86_400_000
const VOTE_LOCKING_PERIOD_MS = 7 * 86_400_000

// Exact integer division only: a premise that no longer divides cleanly means
// the wall-clock quantity itself changed, which is a fact we must not guess at.
function msPerBlock(totalMs: number, blocks: number | null): number | null {
  if (blocks == null || blocks <= 0) return null
  return totalMs % blocks === 0 ? totalMs / blocks : null
}

// The parachain's nominal MILLISECONDS PER BLOCK, derived from constants that
// actually track it (see the note on `runtimeSlotDurationMs` for why the obvious
// one does not). Two independent pallets publish a wall-clock quantity in blocks;
// when both are readable they must agree. A disagreement means one of the
// premises above changed, so we return null and let the caller fall back to the
// measured ladder rather than silently rescaling every projected date. The two
// durations are deliberately coprime-ish (3 days and 7 days), so a block count
// that satisfies one premise by accident cannot satisfy the other.
export function paraBlockMsFromConstants(
  spendPeriodBlocks: number | null,
  voteLockingPeriodBlocks: number | null,
): number | null {
  const fromSpend = msPerBlock(SPEND_PERIOD_MS, spendPeriodBlocks)
  const fromVoteLocking = msPerBlock(VOTE_LOCKING_PERIOD_MS, voteLockingPeriodBlocks)
  if (fromSpend != null && fromVoteLocking != null) {
    return fromSpend === fromVoteLocking ? fromSpend : null
  }
  return fromSpend ?? fromVoteLocking
}

export function runtimeParaBlockMs(): number | null {
  return paraBlockMsFromConstants(runtimeSpendPeriodBlocks(), runtimeVoteLockingPeriodBlocks())
}

// `treasury.spendPeriod` — parachain blocks between treasury spend rounds, a
// fixed 3 days. Present in every Basilisk runtime, including the pre-OpenGov
// ones, which makes it the constant that still resolves the oldest eras.
export function runtimeSpendPeriodBlocks(): number | null {
  return constantNumber('treasury', 'spendPeriod', 100_000_000)
}

// `convictionVoting.voteLockingPeriod` — parachain blocks a 1x-conviction vote
// stays locked, a fixed 7 days. Absent before OpenGov, which is why the pair
// above must tolerate either constant alone.
export function runtimeVoteLockingPeriodBlocks(): number | null {
  return constantNumber('convictionVoting', 'voteLockingPeriod', 100_000_000)
}
