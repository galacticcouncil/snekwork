import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  activityRowMatchesAction,
  exactActivityMismatch,
  isLocatedActivityRequest,
  liqActionFor,
  liquidityActionEventNames,
  POOL_LIFECYCLE_EVENTS,
} from '../src/services/explorerService.ts'
import type { ActivityRow } from '../src/services/explorerService.ts'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')
const routes = readFileSync(new URL('../src/routes/explorer.ts', import.meta.url), 'utf8')

// A page is located by counting the feed per block in SQL and then classifying only
// the blocks that hold its ranks. The two halves have to be reconciled BEFORE a page
// is served, and reconciled per block: the failure worth guarding against is a read
// that returns the right NUMBER of rows for the wrong blocks, which leaves every
// total intact. (The ANY-join analyzer bug did exactly that — right count, wrong
// blocks.)
describe('exactActivityMismatch', () => {
  it('accepts a page whose blocks each hold the counted number of rows', () => {
    expect(exactActivityMismatch([7, 7, 9], new Map([[7, 2], [9, 1]]))).toBeNull()
  })

  it('names the block a read under-delivered', () => {
    expect(exactActivityMismatch([7, 9], new Map([[7, 2], [9, 1]]))).toBe('block 7 counted 2, built 1')
  })

  it('names the block a read over-delivered', () => {
    expect(exactActivityMismatch([7, 7, 7], new Map([[7, 2]]))).toBe('block 7 counted 2, built 3')
  })

  it('catches a block the count never mentioned', () => {
    expect(exactActivityMismatch([7, 8], new Map([[7, 1]]))).toBe('block 8 counted 0, built 1')
  })

  it('catches a block that vanished entirely', () => {
    expect(exactActivityMismatch([7], new Map([[7, 1], [4, 1]]))).toBe('block 4 counted 1, built 0')
  })

  // The whole point: the same rows in the wrong blocks.
  it('sees the right row count spread over the wrong blocks', () => {
    expect(exactActivityMismatch([7, 7], new Map([[7, 1], [4, 1]]))).not.toBeNull()
  })
})

// Which requests page by locating their ranks decides the route's offset bound, so the
// two must agree on the vocabulary — and a filter no count arm states puts the request
// back on the candidate window however countable its category is.
describe('isLocatedActivityRequest', () => {
  it('covers every category', () => {
    for (const type of ['all', 'transfer', 'trade', 'liquidity', 'xcm', 'vote']) {
      expect(isLocatedActivityRequest(type), type).toBe(true)
    }
  })

  it('excludes a category the vocabulary does not know', () => {
    expect(isLocatedActivityRequest('extrinsics')).toBe(false)
  })

  // A min-USD floor is the only filter still decided outside SQL: it needs the row's
  // event-time valuation over an amount that, for one liquidity row in eight, is not in
  // the read model at all. It keeps the window, and the window says what it covers.
  it('excludes only the request whose filter no arm states', () => {
    expect(isLocatedActivityRequest('all', { min: 10 })).toBe(false)
    expect(isLocatedActivityRequest('all', { min: 10, token: 'DOT' })).toBe(false)
  })

  // A token is mirrored by every counted arm now, so it must not send the request back
  // to the window — and the route must not be able to reintroduce that by passing an
  // action, which is why the action is no longer a parameter at all.
  it('keeps a token-filtered request on the located path', () => {
    expect(isLocatedActivityRequest('all', { token: 'DOT' })).toBe(true)
    expect(isLocatedActivityRequest('trade', { token: '0' })).toBe(true)
  })

  it('takes no action argument, so no caller can make one a fallback', () => {
    expect(explorerService).toContain('export function isLocatedActivityRequest(type: string, filters: ValueListFilters = {})')
    const calls = routes.match(/isLocatedActivityRequest\(.*/g) ?? []
    expect(calls).toEqual(['isLocatedActivityRequest(type, valueFilters(q))'])
  })
})

// The action filter is exact only if the events an arm counts are exactly the events
// whose rows carry that action label. Both mappings below are therefore derived by
// APPLYING the labelling function, never by restating it backwards.
describe('action filters invert their labelling exactly', () => {
  const LIQUIDITY_ACTIONS = ['Add', 'Remove', 'Create', 'Claim', 'Destroy']

  it('selects every liquidity event under exactly one action', () => {
    const all = liquidityActionEventNames()
    // XYK's four (Added/Removed/PoolCreated/PoolDestroyed), LBP's two
    // (LiquidityAdded/LiquidityRemoved) and the farm's RewardClaimed.
    expect(all.length).toBe(7)
    const selected = LIQUIDITY_ACTIONS.flatMap(action => liquidityActionEventNames(action))
    expect([...selected].sort()).toEqual([...all].sort())
    // Add and Remove each carry an XYK and an LBP event; the rest are singletons.
    expect(LIQUIDITY_ACTIONS.map(action => liquidityActionEventNames(action).length)).toEqual([2, 2, 1, 1, 1])
  })

  it('gives an action no liquidity event produces an empty selection, not everything', () => {
    expect(liquidityActionEventNames('swap')).toEqual([])
    expect(liquidityActionEventNames('ClaimRewards')).toEqual([])
  })

  // A liquidity row's label is liqActionFor(event_name); the inverse has to
  // round-trip for every event in the list.
  it('round-trips every liquidity event through its own label', () => {
    const all = liquidityActionEventNames()
    for (const name of all) {
      expect(liquidityActionEventNames(liqActionFor(name)), name).toContain(name)
    }
  })
})

// The arms are only exact if the per-action selections PARTITION the category: an
// action matching a row another action also matches counts it twice across the chips,
// and one matching none of them loses it. This is the same sum the live feeds are
// checked against, stated over the predicate itself.
describe('per-action selections partition their category', () => {
  const row = (fields: Partial<ActivityRow> & Pick<ActivityRow, 'type'>): ActivityRow => fields as ActivityRow
  // Every action the UI offers, next to the rows that category can produce.
  const categories: { actions: string[]; rows: ActivityRow[] }[] = [
    { actions: ['swap'], rows: [row({ type: 'trade' })] },
    {
      actions: ['Add', 'Remove', 'Create', 'Claim', 'Destroy'],
      rows: liquidityActionEventNames().map(name => row({ type: 'liquidity', liqAction: liqActionFor(name) })),
    },
    { actions: ['out', 'in'], rows: [row({ type: 'xcm', xcmDir: 'out' }), row({ type: 'xcm', xcmDir: 'in' })] },
    { actions: ['Aye', 'Nay'], rows: [row({ type: 'vote', voteSide: 'Aye' }), row({ type: 'vote', voteSide: 'Nay' })] },
  ]

  it('matches each row under exactly one action of its category', () => {
    let checked = 0
    for (const { actions, rows } of categories) {
      for (const r of rows) {
        const hits = actions.filter(action => activityRowMatchesAction(r, action))
        expect(hits, `${r.type} ${JSON.stringify(r)}`).toHaveLength(1)
        checked += 1
      }
    }
    // Pinned so a category dropped from the table above fails here rather than silently
    // shrinking the check to nothing.
    expect(checked).toBe(12)
  })

  it('keeps every transfer under every action, which is why no transfer arm filters', () => {
    for (const action of ['swap', 'Add', 'in', 'Aye']) {
      expect(activityRowMatchesAction(row({ type: 'transfer' }), action), action).toBe(true)
    }
  })
})

// Filtering the SUPPRESSION CONTEXT is the failure this whole split exists to avoid: a
// trade the filter excludes still owns its transfer legs, and a narrowed context lets
// those legs surface as transfers the count never counted.
describe('the token filter reaches candidates only', () => {
  const body = (name: string): string => {
    const at = explorerService.indexOf(`function ${name}`)
    expect(at, name).toBeGreaterThan(-1)
    // `\n}\n` rather than `\n}`: an argument object's closing brace is followed by `)`.
    const end = explorerService.indexOf('\n}\n', at)
    expect(end, name).toBeGreaterThan(at)
    return explorerService.slice(at, end)
  }

  it('leaves both transfer-suppression context sets unfiltered', () => {
    for (const name of ['semanticExtrinsicSql', 'hookOwnerSql']) {
      const sql = body(name)
      expect(sql, name).not.toContain('tokenFilter')
      expect(sql, name).not.toContain('asset_refs')
      expect(sql, name).not.toContain('tokenIds')
    }
  })

  it('applies it in each of the counted arms and nowhere else in them', () => {
    const armed: Record<string, RegExp> = {
      accountSwapTradeArm: /rep_in IN \(\$\{ids\}\) OR rep_out IN \(\$\{ids\}\)/,
      accountLiquidityArm: /hasAny\(asset_refs, \[\$\{ids\}\]\)/,
      accountTransferArm: /potFilters, tokenFilter\)/,
    }
    for (const [name, predicate] of Object.entries(armed)) {
      expect(body(name), name).toMatch(predicate)
    }
    // Counted once per arm.
    expect((explorerService.match(/armTokenFilter\(tokenIds(?: &&[^,]+)?, /g) ?? []).length).toBe(3)
  })

  // Only the candidate read inside the transfer arm is narrowed, and it is narrowed in
  // exactly one place.
  it('threads the transfer arm’s filter into the candidate read alone', () => {
    expect((explorerService.match(/transferCandidateSql\(/g) ?? []).length).toBe(2)   // definition + one call
    expect(body('accountTransferArm')).toContain('transferCandidateSql(accList, bound, potFilters, tokenFilter)')
  })

  // The page half has to make the same split, and under a closed block set it can:
  // there is no LIMIT for the unfiltered context rows to crowd a rare match out of.
  it('drops the page read’s push-downs under an exact plan', () => {
    expect((explorerService.match(/const tokenIds = exact \? undefined : assetIdsForToken\(filters\.token\)/g) ?? []).length).toBe(1)
  })

  // `!A && A` is false for every A, so this guard never once produced a filter — and the
  // saturation recheck it gates never ran. The fallback read it belongs to is the one
  // that does NOT use the transfer read model.
  it('prefilters the raw transfer fallback instead of guarding itself out', () => {
    expect(explorerService).not.toMatch(/!useTransferReadModel && tokenIds == null/)
    expect((explorerService.match(/const transferRefsFilter = useTransferReadModel \? ''/g) ?? []).length).toBe(1)
    expect((explorerService.match(/if \(transferRefsFilter && rawTransferRows\.length < catFetch\) \{/g) ?? []).length).toBe(1)
    // A short prefiltered read is rechecked and, if the cap cut, taken again over the
    // whole bound — so re-enabling the prefilter can only cost a query, never a row.
    expect((explorerService.match(/transferReadNeedsWholeBound\(/g) ?? []).length).toBe(2)   // definition + one call
    expect((explorerService.match(/await readTransfers\(/g) ?? []).length).toBe(2)
  })
})

// A viewed account can be admitted to a liquidity_activity read through `who` (the LP)
// or `pool_account` (the pool itself), but the pool_account arm must never widen beyond
// the pool's own lifecycle — otherwise a future event that starts carrying a `pool` arg
// would silently attribute every LP's add/remove on that pool to the pool account's own
// feed, and a pool account's page would stop being lifecycle-markers-only.
describe('POOL_LIFECYCLE_EVENTS confines the pool_account admission arm', () => {
  it('names exactly pool creation and destruction', () => {
    expect([...POOL_LIFECYCLE_EVENTS].sort()).toEqual(['XYK.PoolCreated', 'XYK.PoolDestroyed'])
  })

  it('is a subset of the full liquidity event list', () => {
    const all = liquidityActionEventNames()
    for (const name of POOL_LIFECYCLE_EVENTS) expect(all, name).toContain(name)
  })

  it('scopes pool_account inside its own event_name test, not the caller’s', () => {
    const at = explorerService.indexOf('function liquidityWhoOrPoolSql')
    expect(at).toBeGreaterThan(-1)
    const body = explorerService.slice(at, explorerService.indexOf('\n}\n', at))
    expect(body).toMatch(/pool_account IN \(\$\{list\}\) AND event_name IN \(\$\{sqlEventNameList\(\[\.\.\.POOL_LIFECYCLE_EVENTS\]\)\}\)/)
  })

  // The failure this guards: reverting any one of the three sites to the old
  // `(who IN (${list}) OR pool_account IN (${list}))` shape (no inner event_name test)
  // would compile and pass every OTHER test here, since the outer per-call event list
  // often masks it today by coincidence of which events currently populate pool_account.
  it('leaves no liquidity_activity read with an unscoped pool_account arm', () => {
    expect(explorerService).not.toMatch(/who IN \(\$\{list\}\) OR pool_account IN \(\$\{list\}\)\)/)
  })

  // accountLiquidityArm (the liquidity count arm), semanticExtrinsicSql (the transfer
  // count arm's suppression context), and collectAccountActivity's liquidity page read
  // must all call the one shared builder — not three copies that can drift apart.
  it('is shared verbatim by all three liquidity_activity reads that admit a pool account', () => {
    expect((explorerService.match(/liquidityWhoOrPoolSql\(list\)/g) ?? []).length).toBe(3)
    for (const name of ['accountLiquidityArm', 'semanticExtrinsicSql']) {
      const at = explorerService.indexOf(`function ${name}`)
      expect(at, name).toBeGreaterThan(-1)
      const fn = explorerService.slice(at, explorerService.indexOf('\n}\n', at))
      expect(fn, name).toContain('liquidityWhoOrPoolSql(list)')
    }
    // The page read is a closure inside collectAccountActivity, not a top-level
    // function `body()` can extract by name — assert its call site directly.
    expect(explorerService).toContain('AND ${liquidityWhoOrPoolSql(list)}\n                ${liquidityTokenFilter}')
  })
})

// Pool-share membership is asset-registry state ClickHouse does not hold. It is
// interpolated from the live registry per request precisely so a newly registered
// share token cannot leave a baked classification stale.
describe('the share-asset list', () => {
  it('is derived from the live registry', () => {
    const at = explorerService.indexOf('function shareAssetIdsSql')
    expect(at).toBeGreaterThan(-1)
    const body = explorerService.slice(at, explorerService.indexOf('\n}', at))

    expect(body).toContain('allExplorerAssets()')
    expect(body).toContain('isShareAssetId')
    // No baked list beside the registry-derived one.
    expect(body).not.toMatch(/\[\s*\d+\s*,/)
  })
})
