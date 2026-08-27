import { describe, expect, it } from 'vitest'
import {
  mergeRawRanges,
  missingRawCoverage,
} from '../../src/raw/ranges.ts'

describe('raw range coverage helpers', () => {
  it('merges overlapping and adjacent completed ranges', () => {
    expect(mergeRawRanges([
      { fromBlock: 20, toBlock: 30 },
      { fromBlock: 1, toBlock: 10 },
      { fromBlock: 11, toBlock: 15 },
      { fromBlock: 14, toBlock: 18 },
    ])).toEqual([
      { fromBlock: 1, toBlock: 18 },
      { fromBlock: 20, toBlock: 30 },
    ])
  })

  it('finds uncovered intervals inside a requested range', () => {
    expect(missingRawCoverage(1, 30, [
      { fromBlock: 1, toBlock: 10 },
      { fromBlock: 15, toBlock: 20 },
      { fromBlock: 25, toBlock: 30 },
    ])).toEqual([
      { fromBlock: 11, toBlock: 14 },
      { fromBlock: 21, toBlock: 24 },
    ])
  })
})
