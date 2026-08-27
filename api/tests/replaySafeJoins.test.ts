import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

// raw_blocks/raw_extrinsics/raw_events all replace on their event identity, so a
// re-indexed range holds each row twice until its parts merge. The blocks list
// paged and counted those rows directly, showing a block twice with doubled
// extrinsic and event counts.
describe('block list reads are replay-safe', () => {
  it('pages the block list from a deduplicated source', () => {
    const at = explorerService.indexOf('SELECT block_height, toString(block_timestamp) AS ts, block_hash, author, spec_version')
    expect(at).toBeGreaterThan(-1)
    const paged = explorerService.slice(at, explorerService.indexOf('OFFSET {offset:UInt32}', at))

    expect(paged).toContain('FROM price_data.raw_blocks FINAL')
  })

  it('counts extrinsic and event identities per block, not rows', () => {
    expect(explorerService).toContain('SELECT block_height, uniqExact(extrinsic_index) AS c FROM price_data.raw_extrinsics')
    expect(explorerService).toContain('SELECT block_height, uniqExact(event_index) AS c FROM price_data.raw_events')
    expect(explorerService).toContain('SELECT uniqExact(event_index) AS c FROM price_data.raw_events WHERE block_height = {h:UInt32}')
    expect(explorerService).not.toContain('SELECT block_height, count() AS c FROM price_data.raw_events')
  })
})
