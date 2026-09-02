export interface FinalityGateDeps {
  /** null means "the RPC did not answer" — never "there is no finalized head". */
  fetchFinalizedHead: () => Promise<number | null>
  sleep: (ms: number) => Promise<void>
  pollMs: number
  /** consecutive unanswered polls tolerated before giving up */
  maxUnanswered: number
  log?: (message: string) => void
}

export interface FinalityGateResult {
  finalizedHead: number
  waited: boolean
}

/**
 * Block until the chain's finalized head is strictly above `lastProcessedBlock`.
 *
 * The sqd runner only enters its finalized-follow loop when finality is above our
 * checkpoint; started while already caught up it falls through to processHotBlocks()
 * and asserts on `supportsHotBlocks`, which RawDatabase cannot support. So an
 * unanswered head poll must NOT be read as "we are at the head" — under our own
 * backfill load the endpoint 429s, and treating that as an answer is what let the
 * follower start into the crash.
 */
export async function waitForFinalityAbove(
  lastProcessedBlock: number,
  deps: FinalityGateDeps,
): Promise<FinalityGateResult> {
  let unanswered = 0
  let waited = false
  let announcedCaughtUp = false
  let announcedUnanswered = false

  for (;;) {
    const head = await deps.fetchFinalizedHead()

    if (head == null) {
      unanswered += 1
      if (unanswered >= deps.maxUnanswered) {
        throw new Error(
          `finalized head unanswered for ${unanswered} consecutive polls; refusing to start the `
          + 'follower, because starting while caught up crashes on supportsHotBlocks',
        )
      }
      if (!announcedUnanswered) {
        deps.log?.(`finalized head unanswered; waiting rather than starting the follower blind`)
        announcedUnanswered = true
      }
      waited = true
      await deps.sleep(deps.pollMs)
      continue
    }

    // only a real answer clears the budget, so intermittent 429s cannot accumulate
    unanswered = 0

    if (head > lastProcessedBlock) return { finalizedHead: head, waited }

    if (!announcedCaughtUp) {
      deps.log?.(
        `caught up to finalized head ${head} (checkpoint ${lastProcessedBlock}); `
        + 'waiting for on-chain finality to advance before following',
      )
      announcedCaughtUp = true
    }
    waited = true
    await deps.sleep(deps.pollMs)
  }
}
