import { describe, expect, it } from 'vitest'
import { waitForFinalityAbove } from '../../src/raw/finalityGate.ts'

/** Drives the gate off a scripted sequence of head answers; null = RPC did not answer. */
function gate(answers: (number | null)[], opts: { maxUnanswered?: number } = {}) {
  const asked: number[] = []
  const sleeps: number[] = []
  let i = 0
  return {
    asked,
    sleeps,
    run: (lastProcessedBlock: number) =>
      waitForFinalityAbove(lastProcessedBlock, {
        fetchFinalizedHead: async () => {
          const answer = i < answers.length ? answers[i] : answers[answers.length - 1]
          i += 1
          asked.push(i)
          return answer
        },
        sleep: async ms => { sleeps.push(ms) },
        pollMs: 4_000,
        maxUnanswered: opts.maxUnanswered ?? 75,
      }),
  }
}

describe('raw live finality gate', () => {
  it('starts immediately when finality is already above the checkpoint', async () => {
    const g = gate([16_867_800])
    await expect(g.run(16_867_798)).resolves.toEqual({ finalizedHead: 16_867_800, waited: false })
    expect(g.sleeps).toHaveLength(0)
  })

  it('waits while caught up, then starts once finality advances', async () => {
    const g = gate([16_867_798, 16_867_798, 16_867_801])
    await expect(g.run(16_867_798)).resolves.toEqual({ finalizedHead: 16_867_801, waited: true })
    expect(g.sleeps).toEqual([4_000, 4_000])
  })

  // the regression: an unanswered poll used to exit the wait loop and start the
  // follower blind, which asserts on supportsHotBlocks inside processHotBlocks()
  it('does not start the follower when the head poll goes unanswered', async () => {
    const g = gate([null, null, null, 16_867_801])
    await expect(g.run(16_867_798)).resolves.toEqual({ finalizedHead: 16_867_801, waited: true })
    expect(g.sleeps).toEqual([4_000, 4_000, 4_000])
  })

  it('never treats an unanswered poll as "caught up to the head"', async () => {
    // every answer is null: the only correct outcome is to give up, never to return
    const g = gate([null], { maxUnanswered: 3 })
    await expect(g.run(16_867_798)).rejects.toThrow(/unanswered for 3 consecutive polls/)
  })

  it('resets the unanswered budget after a real answer, so intermittent 429s never accumulate', async () => {
    // 2 nulls, an answer that is still caught up, then 2 more nulls: with a cap of
    // 3 this must survive, because the good answer clears the count
    const g = gate([null, null, 16_867_798, null, null, 16_867_802], { maxUnanswered: 3 })
    await expect(g.run(16_867_798)).resolves.toEqual({ finalizedHead: 16_867_802, waited: true })
  })

  it('reports the observed head, not the checkpoint, once it starts', async () => {
    const g = gate([null, 16_900_000])
    const result = await g.run(16_867_798)
    expect(result.finalizedHead).toBe(16_900_000)
  })
})
