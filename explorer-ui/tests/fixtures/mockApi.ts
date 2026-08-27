/* Deterministic API fixtures shared by Vitest and Playwright.

   One mock world, served through the routes the API actually exposes. Every
   surface reads the same generators, so a row opened from a feed is the same
   row its block, its extrinsic and its detail page report — the identity rule
   in AGENTS.md's UI section. */
import type {
  ExplorerStats, IndexerStatus, BlockSummary, BlockDetail, ExtrinsicSummary, ExtrinsicDetail,
  EventRow, EventDetail, ActivityRow, AssetDetail, HoldersResponse,
  AddressDetail, AddressBalance, AccountHistoryResponse, CloseAccountsResponse, TagDetail,
  SearchResult, AssetListItem, TopAccountRow, AccountsPage, DailyPoint, Tag,
  AccountRef, AssetRef, ExplorerAssetType, FeePayment, ValueEvent, VoteRow, VoteGroupRow, VotesByReferendumPage,
  AssetLiquidity, AssetLiquiditySource, PoolDetail, PoolsIndexResponse, PoolCompositionEntry,
  PoolLpsResponse, LpPosition,
  GovernanceOverview, GovernanceReferendaPage, CollectiveMotionsPage, TreasuryTipsPage, ReferendumDetail,
  TradeDetail as TradeDetailResponse,
  FilterNames,
} from '../../src/types'

/* ---------- deterministic helpers ---------- */
function rng(seed: number) { let a = seed >>> 0; return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296 } }
function series(seed: number, n: number, base: number, vol = 0.12): number[] {
  const r = rng(seed); const out: number[] = []; let v = base * (0.6 + r() * 0.5)
  for (let i = 0; i < n; i++) { v = Math.max(base * 0.05, v * (1 - vol + r() * vol * 2)); out.push(v) }
  const s = base / (out[out.length - 1] || 1); return out.map(x => +(x * s).toFixed(base < 0.01 ? 7 : 4))
}
const TIP = 12_848_613
const MOCK_NOW_MS = Date.UTC(2026, 6, 15, 12)
// The paging bounds the real API publishes, so the mock pagers face the same three
// shapes: a counted feed (vote), an uncounted one bounded only by serving depth, and
// a total longer than the depth that serves it (events). The vote total leaves a
// part-full last page (128 pages of 25, the last holding 12).
export const MOCK_VOTE_ACTIVITY_TOTAL = 3_187
export const MOCK_ACTIVITY_MAX_OFFSET = 2_500
export const MOCK_NARROW_ACTIVITY_MAX_OFFSET = 250_000
export const MOCK_LIST_MAX_OFFSET = 20_000_000
function tsAt(height: number): string {
  const ms = MOCK_NOW_MS - (TIP - height) * 6000
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
}
// Same "YYYY-MM-DD HH:MM:SS" shape as tsAt, but from an explicit timestamp.
function tsMs(ms: number): string { return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '') }
function hx(seed: number, n: number): string { const r = rng(seed); let s = '0x'; for (let i = 0; i < n; i++) s += Math.floor(r() * 16).toString(16); return s }

/* ---------- assets ---------- */
type MAsset = AssetRef & { price: number; ch: number; ch7d: number; ch1h: number; type: ExplorerAssetType }
const ASSETS: MAsset[] = [
  { assetId: 0, symbol: 'HDX', name: 'Hydration', decimals: 12, parachainId: null, price: 0.02184, ch: 4.28, ch7d: 11.2, ch1h: 0.4, type: 'Native' },
  { assetId: 5, symbol: 'DOT', name: 'Polkadot', decimals: 10, parachainId: null, price: 4.4422, ch: -1.16, ch7d: -3.1, ch1h: -0.2, type: 'Token' },
  { assetId: 10, symbol: 'USDT', name: 'Tether USD', decimals: 6, parachainId: 1000, price: 1.0001, ch: 0.01, ch7d: 0.02, ch1h: 0.0, type: 'Token' },
  { assetId: 1002, symbol: 'aUSDT', name: 'Aave USDT', decimals: 6, parachainId: null, price: 1.0001, ch: 0.01, ch7d: 0.02, ch1h: 0.0, type: 'Token' },
  { assetId: 22, symbol: 'USDC', name: 'USD Coin', decimals: 6, parachainId: 1000, price: 0.9999, ch: -0.01, ch7d: -0.01, ch1h: 0.0, type: 'Token' },
  { assetId: 15, symbol: 'vDOT', name: 'Voucher DOT', decimals: 10, parachainId: 2030, price: 5.8401, ch: 1.84, ch7d: 4.0, ch1h: 0.1, type: 'Derivative' },
  { assetId: 19, symbol: 'WBTC', name: 'Wrapped BTC', decimals: 8, parachainId: 1000, price: 67241.1, ch: -0.72, ch7d: 2.4, ch1h: -0.05, type: 'Token' },
  { assetId: 20, symbol: 'WETH', name: 'Wrapped ETH', decimals: 18, parachainId: 1000, price: 3204.4, ch: 2.18, ch7d: 5.9, ch1h: 0.3, type: 'Token' },
  { assetId: 16, symbol: 'GLMR', name: 'Moonbeam', decimals: 18, parachainId: 2004, price: 0.1842, ch: 9.18, ch7d: 14.0, ch1h: 1.1, type: 'Token' },
  { assetId: 1000, symbol: 'HOLLAR', name: 'Hollar', decimals: 18, parachainId: null, price: 1.0, ch: 0.02, ch7d: 0.0, ch1h: 0.0, type: 'Token' },
  { assetId: 1001, symbol: 'GDOT', name: 'Gigadot', decimals: 10, parachainId: null, price: 4.4501, ch: -1.1, ch7d: -2.0, ch1h: -0.1, type: 'Derivative' },
  // An XYK pair's LP token: pool id == share asset id, so /pool/690 and the
  // Liquidity tab's card for it share one identity.
  { assetId: 690, symbol: 'vDOT/DOT LP', name: 'vDOT/DOT share token', decimals: 18, parachainId: null, price: 5.1, ch: 0.4, ch7d: 1.1, ch1h: 0.0, type: 'Token' },
]
const assetById = new Map(ASSETS.map(a => [a.assetId, a]))
function aref(a: MAsset): AssetRef { return { assetId: a.assetId, symbol: a.symbol, name: a.name, decimals: a.decimals, parachainId: a.parachainId } }
function raw(v: number, dec: number): string { return BigInt(Math.round(v * 1e6)).toString() + '0'.repeat(Math.max(0, dec - 6)) }

/* ---------- accounts ---------- */
function acc(accountId: string, address: string, emoji: string, tag: AccountRef['tag'] = null, identity: AccountRef['identity'] = null): AccountRef {
  return { accountId, address, emoji, tag, identity }
}
const KRAKEN_TAG = { id: 'kraken', name: 'Kraken', color: '#7b6cf6', icon: '/tag-icons/kraken.jpg' }
const A = {
  krakenEvm: acc('0xf73a2b8c1d4e9a06b5c8f2e1a3d70c9b4e6f18ad', '0xF73a2B8c1D4e9A06b5C8f2E1a3D70c9B4e6F18aD', '🦑', KRAKEN_TAG),
  krakenSub: acc('0x9d8bafc9cbe3ae4f1a7c4d2e0b9f86dc31aa5e72aa11bb22cc33dd44ee55ff66', '1MqRsT3uV4wX5yZ6aB7cD8eF9gH0iJ1kL2mN3pQ4rS5tU6v', '🦑', KRAKEN_TAG),
  treasury: acc('0x6d6f646c70792f74727372790000000000000000000000000000000000000000', '7L53bUTBopXqDXSXjBdQXFV7jZ8FtdRZS5JoMjGq5z3Cv2zr', '🏦', { id: 'treasury', name: 'Treasury', color: '#74C742', icon: '🏦' }),
  binance: acc('0x2c1f9eb7a4d0c83e5f6a1b9d2c7e04af8b3d16c9bb22cc33dd44ee55ff6600aa', '0x2c1F9eB7a4D0c83E5f6A1b9D2c7E04aF8b3D16C9', '🐳'),
  fox: acc('0xaa11bb22cc33dd44ee55ff6677889900aabbccddeeff00112233445566778899', '1L53bUTBopXqDXSXjBdQXFV7jZ8FtdRZS5JoMjGq5z3Cv2zr', '🦊', null, { display: 'StakerNode', verified: true, email: 'info@stakernode.com', web: 'https://stakernode.com/', twitter: '@NodeStaker' }),
  owl: acc('0xbb22cc33dd44ee55ff6677889900aabbccddeeff0011223344556677889900aa', '1NPoMQbiA6trJKkjB35uk96MeJD4PGWkLQLH7k7hXEkZpiba', '🦉'),
  swan: acc('0xcc33dd44ee55ff6677889900aabbccddeeff0011223344556677889900aabbcc', '1Rs5Uv6Wx7Yz8Ab9Cd0Ef1Gh2Ij3Kl4Mn5Op6Qr7St8Uv9w', '🦢'),
}
const ACCS = [A.krakenEvm, A.binance, A.fox, A.owl, A.treasury, A.swan]
const COLLATORS = [acc('0xf617ddeb11327140143ea2c663520f91c6f56d351fa2fb5cb5f2b0e80b755b37', '16ZfsSG7swhuyw79EMUcjmV3LEpYpAroUuMv13FZYuYSpb7B', '🌳')]

/* ---------- call/event catalogue ---------- */
const CALLS = ['XYK.sell', 'XYK.buy', 'Router.sell', 'Tokens.transfer', 'Balances.transfer_keep_alive', 'XTokens.transfer', 'XYK.add_liquidity', 'XYK.remove_liquidity']

// What `/explorer/filter-names` serves: the names the indexed data holds, which
// the Extrinsics/Events name filters offer. Deliberately a SUPERSET of the
// mock's own rows — the real endpoint answers from a block window, not from the
// page in front of you — but every call the mock extrinsics carry is in it, so a
// name picked from the list matches rows the mock feeds actually return.
// Sorted, exactly as the endpoint sorts.
export const MOCK_FILTER_NAMES: FilterNames = {
  calls: [...CALLS, 'ParachainSystem.set_validation_data', 'Referenda.submit', 'Timestamp.set'].sort(),
  events: [
    'Balances.Transfer', 'XYK.BuyExecuted', 'XYK.SellExecuted', 'XYK.LiquidityAdded', 'XYK.LiquidityRemoved',
    'Referenda.Approved', 'Referenda.Cancelled', 'Referenda.Confirmed', 'Referenda.DecisionStarted', 'Referenda.Rejected', 'Referenda.Submitted',
    'System.ExtrinsicFailed', 'System.ExtrinsicSuccess', 'Tokens.Transfer', 'TransactionPayment.TransactionFeePaid',
  ].sort(),
}

// How many extrinsics a mock block holds. Shared so every surface that walks a
// block — the block detail, the feeds, and the extrinsic-at lookup's bounds —
// agrees on the same block, exactly as the real API does.
export function blockExtrinsicCount(height: number): number { return 2 + (height % 6) }

function genExtrinsic(height: number, idx: number): ExtrinsicDetail {
  const r = rng(height * 31 + idx * 7)
  const call = CALLS[Math.floor(r() * CALLS.length)]
  const signer = ACCS[Math.floor(r() * ACCS.length)]
  const dest = ACCS[Math.floor(r() * ACCS.length)]
  const aIn = ASSETS[Math.floor(r() * ASSETS.length)], aOut = ASSETS[Math.floor(r() * ASSETS.length)]
  const success = r() > 0.06
  const isInherent = idx < 2
  const callName = isInherent ? (idx === 0 ? 'Timestamp.set' : 'ParachainSystem.set_validation_data') : call
  const amt = +(10 + r() * 4000).toFixed(4)
  const callArgs: Record<string, unknown> = isInherent
    ? (idx === 0 ? { now: Date.parse(tsAt(height).replace(' ', 'T') + 'Z') } : { data: '0x…relay-chain-state-proof' })
    : call.startsWith('XYK.sell') || call.startsWith('XYK.buy') || call.startsWith('Router')
      ? { asset_in: aIn.assetId, asset_out: aOut.assetId, amount: raw(amt, aIn.decimals), min_buy_amount: raw(amt * 0.99, aOut.decimals) }
      : call.startsWith('Tokens.transfer') ? { currency_id: aIn.assetId, dest: dest.address, amount: raw(amt, aIn.decimals) }
      : call.startsWith('Balances') ? { dest: dest.address, value: raw(amt, 12) }
      : call.startsWith('XTokens') ? { currency_id: aIn.assetId, amount: raw(amt, aIn.decimals), dest: { V3: { parents: 1, interior: { X2: [{ Parachain: 2004 }, { AccountId32: { id: dest.address } }] } } } }
      : { asset_a: aIn.assetId, asset_b: aOut.assetId, amount_a: raw(amt, aIn.decimals) }
  const events = isInherent
    ? [{ eventIndex: 0, name: 'System.ExtrinsicSuccess', args: { weight: 137_316_000 } }]
    : success
      ? [
        { eventIndex: 0, name: call.startsWith('Balances') ? 'Balances.Transfer' : 'Tokens.Transfer', args: { currency_id: aIn.assetId, from: signer.address, to: dest.address, amount: raw(amt, aIn.decimals) } },
        { eventIndex: 2, name: 'TransactionPayment.TransactionFeePaid', args: { who: signer.address, actual_fee: raw(0.02, 12), tip: '0' } },
        { eventIndex: 3, name: 'System.ExtrinsicSuccess', args: { weight: 412_000_000 } },
      ]
      : [{ eventIndex: 0, name: 'System.ExtrinsicFailed', args: { dispatch_error: 'Token.BelowMinimum' } }]
  const feePayment = mockFeePayment(height, idx, isInherent)
  return {
    blockHeight: height, index: idx, hash: hx(height * 17 + idx, 64), timestamp: tsAt(height),
    signer: isInherent ? null : signer, success: isInherent ? true : success, callName,
    fee: isInherent ? null : raw(0.002 + r() * 0.05, 12), version: 4,
    tip: mockTip(idx, isInherent),
    callArgs, error: success || isInherent ? null : { module: 'Tokens', error: 'BelowMinimum' },
    errorReason: success || isInherent ? null : { label: 'Token.BelowMinimum', docs: 'The transfer would leave the account below the existential deposit.' },
    events,
    ...(feePayment ? { feePayment } : {}),
  }
}

/** The mock's non-HDX fee payers, by extrinsic index within a block. */
const MOCK_FEE_CURRENCY: Record<number, number> = { 3: 5, 4: 10 }
// The one extrinsic index that tips, so a surface which shows the tip only when
// there is one has both shapes reachable from a fixed URL. Its HDX figure and
// its share of the fee asset's fee+tip charge have to agree, the way the api's
// proportional split makes them agree on chain.
const MOCK_TIP_INDEX = 4
const MOCK_TIP_HDX = raw(0.5, 12)
function mockTip(idx: number, isInherent: boolean): string | null {
  if (isInherent) return null
  return idx === MOCK_TIP_INDEX ? MOCK_TIP_HDX : '0'
}

// The fee currency an extrinsic settled in, when that is not HDX. The api derives
// this from the extrinsic's own balance events (extrinsicFeePayment.ts), so the
// mock has to state it the same way: a nominated-currency payer pays fee and tip
// in that asset.
function mockFeePayment(height: number, idx: number, isInherent: boolean): FeePayment | null {
  if (isInherent) return null
  const assetId = MOCK_FEE_CURRENCY[idx]
  const a = assetId != null ? assetById.get(assetId) : undefined
  if (!a) return null
  return {
    asset: aref(a),
    amount: raw(0.0041 * (1 + (height % 7) / 10), a.decimals),
    tipAmount: idx === MOCK_TIP_INDEX ? raw(0.0041 * 3, a.decimals) : '0',
  }
}

// Rows above the fixture's finalized boundary (stats.finalizedBlock = TIP - 2)
// carry the pending-head marker, mirroring the api's unfinalized merge.
function mockFinal(h: number): { finalized?: boolean } {
  return h > TIP - 2 ? { finalized: false } : {}
}

function recentExtrinsics(limit: number, signedOnly: boolean): ExtrinsicSummary[] {
  const out: ExtrinsicSummary[] = []
  let h = TIP
  while (out.length < limit && h > TIP - 400) {
    const n = blockExtrinsicCount(h)
    for (let i = n - 1; i >= 0 && out.length < limit; i--) {
      const x = genExtrinsic(h, i)
      if (signedOnly && !x.signer) continue
      out.push({ blockHeight: x.blockHeight, index: x.index, hash: x.hash, timestamp: x.timestamp, signer: x.signer, success: x.success, callName: x.callName, fee: x.fee, ...mockFinal(h) })
    }
    h--
  }
  return out.slice(0, limit)
}

function recentEvents(limit: number): EventRow[] {
  const out: EventRow[] = []
  let h = TIP
  while (out.length < limit && h > TIP - 200) {
    const n = blockExtrinsicCount(h)
    for (let i = n - 1; i >= 0 && out.length < limit; i--) {
      const x = genExtrinsic(h, i)
      for (const e of x.events) {
        out.push({ blockHeight: h, eventIndex: out.length, extrinsicIndex: x.index, timestamp: x.timestamp, name: e.name, args: e.args, decoded: true, ...mockFinal(h) })
        if (out.length >= limit) break
      }
    }
    h--
  }
  return out.slice(0, limit)
}

function mockExtrinsicActivity(height: number, index: number): ActivityRow[] {
  const x = genExtrinsic(height, index)
  const r = rng(height * 37 + index * 11)
  const aIn = ASSETS[Math.floor(r() * ASSETS.length)]
  const aOut = ASSETS[Math.floor(r() * ASSETS.length)]
  const amount = +(25 + r() * 2500).toFixed(4)
  const base = {
    blockHeight: height,
    timestamp: x.timestamp,
    eventIndex: 0,
    extrinsicIndex: index,
    who: x.signer,
    to: null as AccountRef | null,
    asset: null as AssetRef | null,
    assetIn: null as AssetRef | null,
    assetOut: null as AssetRef | null,
    amount: null as string | null,
    amountIn: null as string | null,
    amountOut: null as string | null,
    valueUsd: amount * aIn.price,
    linkBlock: height,
    linkIndex: index,
  }
  if (!x.signer) return []
  if (/transfer/i.test(x.callName)) return [{ ...base, type: x.callName.startsWith('XTokens') ? 'xcm' : 'transfer', to: ACCS[(index + 1) % ACCS.length], asset: aref(aIn), amount: raw(amount, aIn.decimals), destChain: x.callName.startsWith('XTokens') ? 'Moonbeam' : undefined }]
  if (/liquidity/i.test(x.callName)) return [{ ...base, type: 'liquidity', asset: aref(aIn), amount: raw(amount, aIn.decimals), liqAction: /remove/i.test(x.callName) ? 'Remove' : 'Add' }]
  return [{ ...base, type: 'trade', assetIn: aref(aIn), assetOut: aref(aOut), amountIn: raw(amount, aIn.decimals), amountOut: raw(amount * aIn.price / aOut.price, aOut.decimals) }]
}

// The categories the feeds classify into — the ActivityRow union minus `vote`,
// which has its own generator (a vote is not part of the per-height cycle).
const FEED_TYPES: ActivityRow['type'][] = ['trade', 'transfer', 'xcm', 'liquidity']

// Deterministic single row for a given height, computed the same way the
// `/explorer/activity` feed's per-height loop does — a pure function of `h` via
// its own freshly-seeded rng, so it reproduces byte-identical output to whatever
// the feed showed for that height. Included in mockBlockActivity so a row clicked
// in the Activity feed is still found when its own block's activity is re-fetched
// (e.g. by ActivityDetailPage's row lookup), instead of "not found".
function activityRowAtHeight(h: number): ActivityRow {
  const r = rng(h * 2654435761 + 13)
  const t = FEED_TYPES[h % FEED_TYPES.length]
  const aIn = ASSETS[Math.floor(r() * ASSETS.length)], aOut = ASSETS[Math.floor(r() * ASSETS.length)]
  const amt = r() < 0.25 ? +((0.5 + r() * 8) / aIn.price).toFixed(6) : +(10 + r() * 4000).toFixed(2)
  const who = ACCS[Math.floor(r() * ACCS.length)]
  const base = { blockHeight: h, timestamp: tsAt(h), eventIndex: h % 100, extrinsicIndex: 2 + Math.floor(r() * 3), who, to: null as AccountRef | null, asset: null as AssetRef | null, assetIn: null as AssetRef | null, assetOut: null as AssetRef | null, amount: null as string | null, amountIn: null as string | null, amountOut: null as string | null, valueUsd: amt * aIn.price }
  if (t === 'trade') return { ...base, type: t, assetIn: aref(aIn), assetOut: aref(aOut), amountIn: raw(amt, aIn.decimals), amountOut: raw(amt * aIn.price / aOut.price, aOut.decimals) }
  if (t === 'xcm' && h % 2 === 0) return { ...base, type: t, extrinsicIndex: null, asset: aref(aIn), amount: raw(amt, aIn.decimals), xcmDir: 'in', fromChain: 'AssetHub' }
  if (t === 'transfer' || t === 'xcm') return { ...base, type: t, to: ACCS[Math.floor(r() * ACCS.length)], asset: aref(aIn), amount: raw(amt, aIn.decimals), destChain: t === 'xcm' ? 'Moonbeam' : undefined, destAccount: t === 'xcm' ? xcmDestAccount(h) : undefined, xcmDir: t === 'xcm' ? 'out' : undefined }
  return { ...base, type: t, asset: aref(aIn), amount: raw(amt, aIn.decimals), liqAction: (['Add', 'Remove'] as const)[h % 2] }
}

// One vote per height, cycling the conviction values the chain actually emits —
// including `None`, the no-lock vote that carries 0.1x and used to render as the
// word "None" beside votes showing a multiplier, i.e. as missing data.
export const MOCK_VOTE_CONVICTIONS = ['Locked6x', 'None', 'Locked2x', 'Locked1x', 'Locked5x'] as const
export function voteRowAtHeight(h: number): ActivityRow {
  const conviction = MOCK_VOTE_CONVICTIONS[h % MOCK_VOTE_CONVICTIONS.length]
  const hdx = ASSETS[0]
  const amt = 1000 + (h % 9000)
  return {
    type: 'vote', blockHeight: h, timestamp: tsAt(h), eventIndex: 95, extrinsicIndex: 3,
    who: ACCS[h % ACCS.length], to: null, asset: aref(hdx), assetIn: null, assetOut: null,
    amount: raw(amt, hdx.decimals), amountIn: null, amountOut: null, valueUsd: amt * hdx.price,
    votePallet: 'ConvictionVoting', voteAction: 'Voted', voteRef: '380',
    voteSide: h % 7 === 0 ? 'Nay' : 'Aye', voteConviction: conviction,
    voteRefPallet: 'opengov', voteRefTitle: 'Security patch runtime upgrade v50.0.2',
    linkBlock: h, linkIndex: 3,
  }
}

// A Technical Committee vote. A collective vote is vote activity like any other,
// and it carries none of the things a conviction vote does: no locked capital, no
// conviction, and a proposal HASH where a referendum index would be — so it has no
// referendum page and its subject reads as the motion it is. The same identity is
// served by the global vote feed, the account feed and its own block, so opening it
// from any of them lands on the same detail page.
export const MOCK_TC_MOTION_HASH = '0x0529aa…664b5b'
export function collectiveVoteRowAtHeight(h: number, who: AccountRef = A.owl): ActivityRow {
  const hdx = ASSETS[0]
  return {
    type: 'vote', blockHeight: h, timestamp: tsAt(h), eventIndex: 96, extrinsicIndex: 4,
    who, to: null, asset: aref(hdx), assetIn: null, assetOut: null,
    amount: null, amountIn: null, amountOut: null, valueUsd: 0,
    votePallet: 'Technical Committee', voteAction: 'Voted', voteRef: MOCK_TC_MOTION_HASH,
    voteSide: h % 2 === 0 ? 'Aye' : 'Nay', voteConviction: null,
    voteRefPallet: null, voteRefTitle: null,
    linkBlock: h, linkIndex: 4,
  }
}

// An outbound XCM's destination account, cycling through a tagged, an
// identity-only, and a plain local account by the same pubkey — demonstrates the
// external account pill's full tag > identity > address precedence (same pubkey,
// same tag/identity, even shown as a destination-chain recipient).
function xcmDestAccount(h: number): NonNullable<ActivityRow['destAccount']> {
  const src = [A.krakenSub, A.fox, A.owl][(h / 2) % 3]
  return {
    kind: 'AccountId32', accountId: src.accountId, address: src.address, raw: src.accountId,
    subscanUrl: `https://moonbeam.subscan.io/account/${encodeURIComponent(src.address)}`,
    emoji: src.emoji, tag: src.tag, identity: src.identity ? { display: src.identity.display, verified: src.identity.verified } : null,
  }
}

function mockBlockActivity(height: number): ActivityRow[] {
  const n = blockExtrinsicCount(height)
  const rows = Array.from({ length: n }, (_, i) => mockExtrinsicActivity(height, i)).flat()
  rows.push(activityRowAtHeight(height))
  // So a vote opened from the feed is found again when its own block is
  // re-fetched by the detail page's row lookup — for both kinds of vote.
  rows.push(voteRowAtHeight(height))
  rows.push(collectiveVoteRowAtHeight(height))
  const aIn = ASSETS[2], aOut = ASSETS[1]
  rows.push({
    type: 'trade',
    blockHeight: height,
    timestamp: tsAt(height),
    eventIndex: 77,
    extrinsicIndex: null,
    who: A.fox,
    to: null,
    asset: null,
    assetIn: aref(aIn),
    assetOut: aref(aOut),
    amount: null,
    amountIn: raw(1234.56, aIn.decimals),
    amountOut: raw(1234.56 * aIn.price / aOut.price, aOut.decimals),
    valueUsd: 1234.56 * aIn.price,
  })
  return rows
}

/* ---------- builders per route ---------- */
function buildAssets(): AssetListItem[] {
  return ASSETS.map(a => ({ ...aref(a), price: a.price, change24h: a.ch / 100, change7d: a.ch7d / 100, type: a.type, amountUsd: 2_000_000 * (0.3 + rng(a.assetId + 9)() * 4), holderCount: 20 + Math.floor(rng(a.assetId + 17)() * 8000), sparkline: series(a.assetId * 13 + 1, 14, a.price) }))
}
// A structural pot touches balances on every trade, so its own activity feed runs deeper
// than the directory's counter can reach and its total is a FLOOR — "at least this many",
// rendered with a trailing '+'. The floor is deliberately the LARGEST number in the
// column so that both halves of the rule are observable: an ordering that forgot the
// completeness term would rank this row first instead of last.
const ACTIVITY_FLOOR_ACCOUNT = A.treasury
const ACTIVITY_FLOOR_COUNT = 50_000

function sortAccountRows(rows: TopAccountRow[], sort: string): TopAccountRow[] {
  return [...rows].sort((a, b) => {
    // Mirrors the server's `activity_count_complete DESC, activity_count DESC,
    // usd_total DESC`. The completeness term comes FIRST: a floor says only "at least
    // this many", so ranking it against an exact total by number alone would put a
    // "known to be at least 50k" above a "known to be exactly 2,143".
    if (sort === 'activity') {
      return Number(b.activityCountComplete ?? false) - Number(a.activityCountComplete ?? false)
        || (b.activityCount ?? -1) - (a.activityCount ?? -1)
        || b.portfolioUsd - a.portfolioUsd
    }
    if (sort === 'volume') return (b.tradingVolumeUsd ?? -1) - (a.tradingVolumeUsd ?? -1) || b.portfolioUsd - a.portfolioUsd
    if (sort === 'identity') {
      // Named rows first, alphabetically; unnamed by value (mirrors the server).
      const an = a.identity ?? a.tag?.name ?? '', bn = b.identity ?? b.tag?.name ?? ''
      return Number(Boolean(bn)) - Number(Boolean(an)) || an.localeCompare(bn) || b.portfolioUsd - a.portfolioUsd
    }
    return b.portfolioUsd - a.portfolioUsd
  })
}

// Holdings: the four largest as an icon stack, plus how many further holdings
// clear $10 without making the four. The shapes that matter are all here — a
// spread portfolio (few icons, big count), a plain one (no count), and an
// account holding nothing (the cell stays empty).
function holdings(i: number): { topAssets: { asset: AssetRef; valueUsd: number }[]; otherAssets?: number } {
  if (i === 4) return { topAssets: [] }
  const picks = ASSETS.slice(i % 3, (i % 3) + (i === 1 ? 2 : 4))
  return {
    topAssets: picks.map((x, k) => ({ asset: aref(x), valueUsd: 90_000 / (k + 1) })),
    ...(i === 0 ? { otherAssets: 17 } : i === 2 ? { otherAssets: 3 } : {}),
  }
}

function buildAccounts(offset: number, limit: number, sort: string): AccountsPage {
  const rows: TopAccountRow[] = []
  // Kraken tag (2 members) as one row.
  // 53 weekly points = the real API's 1Y padded sparkline shape.
  rows.push({ account: null, tag: { tagId: 'kraken', name: 'Kraken', color: '#7b6cf6', icon: '/tag-icons/kraken.jpg', memberCount: 2 }, portfolioUsd: 5_240_000, lastBlock: TIP - 12, identity: 'Kraken', sparkline: series(99, 53, 5_240_000), activityCount: 2143, activityCountComplete: true, tradingVolumeUsd: 82_400_000, ...holdings(0) })
  const seeds: [AccountRef, number][] = [[A.binance, 3_900_000], [A.fox, 1_240_000], [A.treasury, 980_000], [A.owl, 410_000], [A.swan, 96_000]]
  for (const [i, [a, usd]] of seeds.entries()) {
    const floor = a === ACTIVITY_FLOOR_ACCOUNT
    rows.push({ account: a, tag: null, portfolioUsd: usd, lastBlock: TIP - Math.floor(usd % 900), identity: a === A.binance ? 'Binance' : null, sparkline: series(a.accountId.length * 31, 53, usd), activityCount: floor ? ACTIVITY_FLOOR_COUNT : 100 + (usd % 4000), activityCountComplete: !floor, tradingVolumeUsd: usd * (12 + (a.accountId.charCodeAt(4) % 9)), ...holdings(i) })
  }
  const sorted = sortAccountRows(rows, sort)
  return { rows: sorted.slice(offset, offset + limit), total: sorted.length }
}

// Deterministic HDX lock/reserve breakdown for a balance of `bal` tokens (free =
// 92%, reserved = 8%, matching the mock balance split): overlapping vesting and
// governance locks, a binding unlock timeline whose slices sum exactly to
// `frozen`, and reserve components that deliberately cover only part of
// `reserved` so the "other" remainder row is exercised. Sources are the ones
// lockBreakdownService actually emits — an unknown source would render as its
// own raw name.
function hdxBreakdown(bal: number, dec: number): Pick<AddressBalance, 'frozen' | 'breakdown' | 'timeline'> {
  const f = (x: number) => raw(bal * x, dec)
  // Unlock `until` dates anchor to WALL-CLOCK now, not MOCK_NOW_MS: the panel
  // renders them relative to the real Date.now(), so a fixed anchor would make
  // the "in Nd" text drift and eventually flip to "now" as real time overtakes
  // it. Anchoring to now keeps the relative display (what tests assert) stable.
  const inDays = (n: number) => tsMs(Date.now() + n * 86400e3)
  return {
    frozen: f(0.566), // the binding lock envelope across the overlapping locks
    breakdown: [
      { kind: 'lock', source: 'vesting', amount: f(0.506), claimable: f(0.138) },
      { kind: 'lock', source: 'vote', amount: f(0.414) },
      { kind: 'lock', source: 'democracy', amount: f(0.276) },
      { kind: 'reserve', source: 'referenda', amount: f(0.03) },
      { kind: 'deposit', source: 'identity', amount: f(0.012) },
      { kind: 'deposit', source: 'multisig', amount: f(0.008) },
    ],
    // when · how much · why — sums to frozen
    // (0.08 + 0.155 + 0.09 + 0.211 + 0.03 = 0.566)
    timeline: [
      { state: 'releasable', cause: 'democracy', amount: f(0.08) },
      { state: 'scheduled', cause: 'democracy', amount: f(0.155), until: inDays(21) },
      { state: 'scheduled', cause: 'vote', amount: f(0.09), until: inDays(36) },
      { state: 'scheduled', cause: 'vesting', amount: f(0.211), until: inDays(230), linear: true },
      { state: 'active', cause: 'vote', amount: f(0.03) },
    ],
  }
}

function buildAddress(accountId: string): AddressDetail {
  const a = ACCS.find(x => x.accountId === accountId || x.address.toLowerCase() === accountId.toLowerCase()) ?? A.fox
  const r = rng(a.accountId.length * 17)
  const priced = ASSETS.filter((_, i) => (r() > 0.4) || i < 2).slice(0, 6).map(as => {
    const bal = +(r() * (as.price > 1000 ? 3 : as.price > 1 ? 6000 : 2_000_000)).toFixed(4)
    return {
      asset: aref(as), total: raw(bal, as.decimals), free: raw(bal * 0.92, as.decimals), reserved: raw(bal * 0.08, as.decimals), lastBlock: TIP - Math.floor(r() * 40000), valueUsd: bal * as.price,
      // HDX carries the full lock breakdown; DOT shows the single-component
      // shape (one clearable deposit) for a non-native asset.
      ...(as.assetId === 0 ? hdxBreakdown(bal, as.decimals) : {}),
      ...(as.assetId === 5 ? { breakdown: [{ kind: 'deposit' as const, source: 'other', amount: raw(bal * 0.08, as.decimals) }] } : {}),
    }
  }).sort((x, y) => (y.valueUsd ?? 0) - (x.valueUsd ?? 0))
  // The fox additionally holds one asset with no market price, so the "without a
  // market price" rows beneath the treemap are exercised.
  const unpricedHoldings: AddressBalance[] = a === A.fox
    ? [{ asset: { assetId: 424242, symbol: 'MYST', name: 'Mystery Token', decimals: 12, parachainId: null }, total: raw(150_000, 12), free: raw(150_000, 12), reserved: '0', lastBlock: TIP - 5000, valueUsd: null }]
    : []
  // The owl carries a long tail of small holdings (no market history), so its
  // treemap folds them into an "Other" tile — the fixture for the Other/no-history
  // hover behaviour. Two constraints set the values: each holding stays under the
  // per-asset fold threshold (0.8% of the portfolio) so none earns its own tile,
  // and the tail SUMS to a few percent so the folded tile is big enough to draw —
  // a tail of true cents folds into a sub-pixel sliver, which the map drops and
  // recovers as chips instead, and then there is no Other tile to hover.
  const dustHoldings: AddressBalance[] = a === A.owl
    ? Array.from({ length: 12 }, (_, i) => ({
        asset: { assetId: 700001 + i, symbol: `DUST${i + 1}`, name: `Dust asset ${i + 1}`, decimals: 12, parachainId: null },
        total: raw(100 + i * 7, 12), free: raw(100 + i * 7, 12), reserved: '0', lastBlock: TIP - 100 * i, valueUsd: 700 + i * 10,
      }))
    : []
  const balances = [...priced, ...unpricedHoldings, ...dustHoldings]
  const portfolioUsd = balances.reduce((s, b) => s + (b.valueUsd ?? 0), 0)
  const isEvm = a.address.startsWith('0x')
  return {
    input: a.address, kind: isEvm ? 'evm' : 'ss58', accountId: a.accountId, emoji: a.emoji,
    evmAddress: isEvm ? a.address : null,
    ss58: a.address.startsWith('1') || a.address.startsWith('7') ? a.address : '7' + a.accountId.slice(2, 47),
    ss58Polkadot: isEvm ? '1MqRsT3uV4wX5yZ6aB7cD8eF9gH0iJ1kL2mN3pQ4rS5tU6v' : a.address,
    tag: a.tag, identity: a.identity ?? null, relatedAccountIds: [a.accountId],
    balances,
    topAssets: balances.filter(b => (b.valueUsd ?? 0) > 10).slice(0, 4).map(b => ({ asset: b.asset, valueUsd: b.valueUsd ?? 0 })),
    portfolioUsd, tradingVolumeUsd: portfolioUsd * (18 + (a.accountId.charCodeAt(5) % 11)),
    liquidityPositions: a === A.fox ? mockLpPositions() : [],
    balanceHistory: [
      ...balances.slice(0, 5).map(b => {
        const tokens = Number(b.total) / 10 ** b.asset.decimals
        const ser = series(b.asset.assetId * 17 + 3, 30, Math.max(tokens, 1))
        return { asset: b.asset, current: tokens, points: ser.map((v, i) => ({ ts: tsAt(TIP - (29 - i) * 18000), blockHeight: TIP - (29 - i) * 18000, balance: v })) }
      }),
      // A holding the fox has since exited: it has a balance history but no
      // current balance, so it appears only in the "historically held" rows.
      ...(a === A.fox ? [{
        asset: { assetId: 313131, symbol: 'PAST', name: 'Former Holding', decimals: 10, parachainId: null } as AssetRef,
        current: 0,
        points: series(313131, 20, 5000).map((v, i, arr) => ({ ts: tsAt(TIP - (19 - i) * 18000), blockHeight: TIP - (19 - i) * 18000, balance: i >= arr.length - 3 ? 0 : v })),
      }] : []),
    ],
    portfolioSeries: series(a.accountId.length * 5, 52, portfolioUsd || 1000),
    // Proxy/multisig demo data: the fox is a 2-of-3 multisig controlled-by-proxy
    // account, the owl is one of its signatories, the swan is a pure proxy.
    proxy: a === A.fox ? {
      isPure: null,
      delegates: [{ account: A.owl, proxyType: 'Any', delay: 0 }, { account: A.swan, proxyType: 'Governance', delay: 300 }],
      delegatorOf: [{ account: A.binance, proxyType: 'Transfer', delay: 0 }],
    } : a === A.swan ? {
      isPure: { creator: A.fox, proxyType: 'Any', blockHeight: TIP - 220000, extrinsicIndex: 2, timestamp: tsAt(TIP - 220000) },
      delegates: [{ account: A.fox, proxyType: 'Any', delay: 0 }],
      delegatorOf: [],
    } : null,
    multisig: a === A.fox ? {
      threshold: 2,
      signatories: [A.owl, A.swan, A.binance],
      pending: [{ callHash: '0x25737077ac4eea2d3cc075243902f0d7e8e3a0ea9a39a00e6484121ba5b89aa8', depositor: A.owl, approvals: [A.owl], sinceBlock: TIP - 4200 }],
    } : null,
    multisigMemberships: a === A.owl ? [{ account: A.fox, threshold: 2, signatories: 3 }] : [],
  }
}

// Both LP venues in one account: shares held in the wallet, and the same pool's
// shares deposited in a liquidity-mining farm.
function mockLpPositions(): LpPosition[] {
  const share = assetById.get(690)!
  return [
    { positionId: 'xyk:690:direct', asset: aref(share), amount: raw(12_400, share.decimals), shares: raw(12_400, share.decimals), valueUsd: 12_400 * share.price, venue: 'XYK' },
    { positionId: 'xyk:690:farm', asset: aref(share), amount: raw(3_100, share.decimals), shares: raw(3_100, share.decimals), valueUsd: 3_100 * share.price, venue: 'XYK Farm' },
  ]
}

// A finite, deterministic account/tag activity feed. The detail pagers publish an
// exact row total, so the fixture needs a real end to page to: 137 rows is 6 pages
// of 25 with a partial last one.
const MOCK_ACTIVITY_ROWS = 137
function mockAccountActivity(a: AccountRef, r: () => number): ActivityRow[] {
  return [...accountActivityCycle(a, r), collectiveVoteRowAtHeight(TIP - MOCK_ACTIVITY_ROWS * 90 - 120, a)]
}
// The account feed's own rows, oldest last, with a committee vote appended after
// them: the account/tag feed merges the collective votes the same way the global
// one does, so the account page has to hold one too.
function accountActivityCycle(a: AccountRef, r: () => number): ActivityRow[] {
  return Array.from({ length: MOCK_ACTIVITY_ROWS }, (_, i) => {
    const h = TIP - i * 90 - Math.floor(r() * 30)
    const t = (['trade', 'transfer', 'liquidity', 'trade'] as const)[Math.floor(r() * 4)]
    const aIn = ASSETS[Math.floor(r() * ASSETS.length)], aOut = ASSETS[Math.floor(r() * ASSETS.length)]
    const amt = +(10 + r() * 4000).toFixed(2)
    const base = { blockHeight: h, timestamp: tsAt(h), extrinsicIndex: 2 + Math.floor(r() * 3), who: a, to: null as AccountRef | null, asset: null as AssetRef | null, assetIn: null as AssetRef | null, assetOut: null as AssetRef | null, amount: null as string | null, amountIn: null as string | null, amountOut: null as string | null, valueUsd: amt * aIn.price, linkBlock: h, linkIndex: 2 }
    if (t === 'transfer') return { ...base, type: t, to: ACCS[Math.floor(r() * ACCS.length)], asset: aref(aIn), amount: raw(amt, aIn.decimals) }
    if (t === 'liquidity') return { ...base, type: t, asset: aref(aIn), amount: raw(amt, aIn.decimals), liqAction: 'Add' as const }
    return { ...base, type: t, assetIn: aref(aIn), assetOut: aref(aOut), amountIn: raw(amt, aIn.decimals), amountOut: raw(amt * aIn.price / aOut.price, aOut.decimals) }
  })
}

// The account/tag detail feeds and their exact totals must be two views of ONE set
// of rows, or a pager would offer a page the feed cannot fill. Both go through these.
function accountActivityRows(rawAddress: string): ActivityRow[] {
  const wanted = decodeURIComponent(rawAddress)
  const account = ACCS.find(candidate => candidate.accountId === wanted || candidate.address.toLowerCase() === wanted.toLowerCase()) ?? A.fox
  return mockAccountActivity(account, rng(account.accountId.length * 17))
}
function tagActivityRows(): ActivityRow[] {
  return mockAccountActivity(A.krakenEvm, rng(A.krakenEvm.accountId.length * 17))
}
function filteredMockActivity(rows: ActivityRow[], qs: URLSearchParams): ActivityRow[] {
  const type = qs.get('type') ?? 'all'
  const min = qs.get('min') == null ? null : Number(qs.get('min'))
  return rows
    .filter(row => type === 'all' || row.type === type)
    .filter(row => min == null || (row.valueUsd ?? 0) >= min)
}
// Each tab's total counts the rows ITS feed serves. The extrinsics and events
// fixtures are recency generators without an end, so those two keep a stated length.
function mockListTotal(qs: URLSearchParams, activityRows: () => ActivityRow[]): number {
  switch (qs.get('tab')) {
    case 'activity': return filteredMockActivity(activityRows(), qs).length
    case 'extrinsics': return qs.get('call') || qs.get('result') || qs.get('origin') ? 87 : 1451
    case 'events': return qs.get('event') ? 312 : 26787
    default: return 0
  }
}

// The value chart's clickable markers, drawn from the account's own feed so a
// marker and the row it opens are the same event.
function mockValueEvents(rows: ActivityRow[]): ValueEvent[] {
  return rows.slice(0, 12).map(row => ({
    blockHeight: row.blockHeight, eventIndex: row.eventIndex ?? 0, extrinsicIndex: row.extrinsicIndex,
    timestamp: row.timestamp,
    kind: row.type === 'trade' ? 'swap' : row.type === 'liquidity' ? 'liquidity' : row.type === 'xcm' ? 'cross-chain' : 'transfer-out',
    valueUsd: row.valueUsd ?? 0,
    asset: row.asset ?? row.assetIn,
    counterparty: row.to,
  }))
}

function mockVoteRows(account: AccountRef | null, limit: number): VoteRow[] {
  const hdx = ASSETS[0]
  return Array.from({ length: limit }, (_, i) => {
    const h = TIP - i * 700 - 40
    const amt = 1000 + (h % 9000)
    return {
      blockHeight: h, timestamp: tsAt(h), eventIndex: 95, extrinsicIndex: 3,
      account: account ?? ACCS[i % ACCS.length], pallet: 'ConvictionVoting', action: 'Voted',
      referendum: String(380 - i), side: h % 7 === 0 ? 'Nay' : 'Aye',
      conviction: MOCK_VOTE_CONVICTIONS[h % MOCK_VOTE_CONVICTIONS.length],
      amount: raw(amt, hdx.decimals), asset: aref(hdx), valueUsd: amt * hdx.price,
      voteRefPallet: 'opengov', voteRefTitle: 'Security patch runtime upgrade v50.0.2',
      weighted: raw(amt * 6, hdx.decimals),
    }
  })
}

/* ---------- liquidity pools ---------- */
// One deterministic pool world shared by the asset Liquidity tab, /liquidity and
// /pool/:id, so a card and the page it links to always carry the same numbers.
// Two real XYK pairs — vDOT/DOT (share token 690) and HDX/DOT (share token
// 1000194) — plus a folded long tail of dust pairs.
const XYK_LP_ID = 1_000_194
const POOL_DAYS = 120
const POOL_BUCKETS = Array.from({ length: POOL_DAYS }, (_, i) => new Date(MOCK_NOW_MS - (POOL_DAYS - i) * 86_400_000).toISOString().slice(0, 10))
const POOL_690_ACCOUNT = acc(hx(690, 64), '167UdiHenqFRhRoXHwh6MBu9YV6NPkbCJx3MC71bfz9YTdzs', '💧', { id: 'xyk-pools', name: 'XYK Pool', color: '#57a5ec', icon: '💧' })
const XYK_PAIR_ACCOUNT = acc(hx(694, 64), '1XyKHdxDotPairAccountX1111111111111111111111111', '💧', { id: 'xyk-pools', name: 'XYK Pool', color: '#57a5ec', icon: '💧' })

interface MPool {
  lpAssetId: number; name: string; account: AccountRef
  assetA: number; reserveA: number; assetB: number; reserveB: number
  feePermill: number; totalShares: number; createdBlock: number
}
const POOLS: MPool[] = [
  { lpAssetId: 690, name: 'vDOT / DOT', account: POOL_690_ACCOUNT, assetA: 15, reserveA: 139_000, assetB: 5, reserveB: 219_000, feePermill: 690, totalShares: 4_150_000, createdBlock: TIP - 1_000_000 },
  { lpAssetId: XYK_LP_ID, name: 'HDX / DOT', account: XYK_PAIR_ACCOUNT, assetA: 0, reserveA: 5_200_000, assetB: 5, reserveB: 25_500, feePermill: 3000, totalShares: 3_100_000, createdBlock: TIP - 2_000_000 },
]
const poolById = new Map(POOLS.map(p => [p.lpAssetId, p]))

const priceof = (id: number) => assetById.get(id)!.price
const compEntry = (id: number, amount: number, tvlUsd: number): PoolCompositionEntry => {
  const a = assetById.get(id)!
  const usd = amount * a.price
  return { asset: aref(a), amount: raw(amount, a.decimals), usd, sharePct: tvlUsd > 0 ? usd / tvlUsd * 100 : null }
}
const poolTvlUsd = (p: MPool) => p.reserveA * priceof(p.assetA) + p.reserveB * priceof(p.assetB)
const poolLegs = (p: MPool): [number, number][] => [[p.assetA, p.reserveA], [p.assetB, p.reserveB]]

// A source's daily amount history: a gentle deterministic walk ending at the
// current reserve, so the chart's right edge agrees with the cards above it.
function poolAmountSeries(seed: number, current: number): number[] {
  return series(seed, POOL_DAYS, current, 0.05)
}

function buildAssetLiquidity(assetId: number): AssetLiquidity {
  const a = assetById.get(assetId) ?? ASSETS[0]
  const sources: AssetLiquiditySource[] = []
  const histSeries: AssetLiquidity['history']['series'] = []
  for (const p of POOLS) {
    const legs = poolLegs(p)
    const leg = legs.find(([id]) => id === assetId)
    if (!leg) continue
    const tvl = poolTvlUsd(p)
    const amount = leg[1]
    sources.push({
      kind: 'xyk', poolId: p.lpAssetId, name: p.name, tvlUsd: tvl,
      assetAmount: raw(amount, a.decimals), assetUsd: amount * a.price, assetSharePct: amount * a.price / tvl * 100,
      composition: legs.map(([id, reserve]) => compEntry(id, reserve, tvl)),
    })
    const amounts = poolAmountSeries(assetId * 31 + p.lpAssetId, amount)
    histSeries.push({ key: `xyk:${p.lpAssetId}`, label: p.name, amounts, usd: amounts.map(v => v * a.price) })
  }
  sources.sort((x, y) => (y.assetUsd ?? -1) - (x.assetUsd ?? -1))
  const totalAmountNum = sources.reduce((s, x) => s + Number(BigInt(x.assetAmount)) / 10 ** a.decimals, 0)
  return {
    asset: aref(a),
    totalAmount: raw(totalAmountNum, a.decimals),
    totalUsd: totalAmountNum * a.price,
    sources,
    // DOT keeps one former pool so the section renders deterministically.
    former: assetId === 5 ? [{ kind: 'xyk', poolId: 1_000_044, name: 'DOT / GLMR', lastActiveBlock: TIP - 400_000, lastActiveAt: tsAt(TIP - 400_000) }] : [],
    history: { buckets: POOL_BUCKETS, series: histSeries },
  }
}

function buildPoolDetail(poolId: number): PoolDetail | undefined {
  const p = poolById.get(poolId)
  if (!p) return undefined
  const tvl = poolTvlUsd(p)
  const share = assetById.get(p.lpAssetId)
  const legs = poolLegs(p)
  const compAmounts = legs.map(([id, reserve]) => poolAmountSeries(id * 5 + p.lpAssetId, reserve))
  return {
    kind: 'xyk', poolId: p.lpAssetId, name: p.name, account: p.account,
    shareToken: share ? aref(share) : { assetId: p.lpAssetId, symbol: `${p.name.replace(/ /g, '')} LP`, name: `${p.name} share token`, decimals: 12, parachainId: null },
    createdBlock: p.createdBlock, createdAt: tsAt(p.createdBlock), destroyed: false,
    tvlUsd: tvl, totalIssuance: raw(p.totalShares, share?.decimals ?? 12), feePermill: p.feePermill,
    assets: legs.map(([id, reserve]) => compEntry(id, reserve, tvl)),
    history: {
      buckets: POOL_BUCKETS,
      tvlUsd: POOL_BUCKETS.map((_, i) => legs.reduce((s, [id], k) => s + compAmounts[k][i] * priceof(id), 0)),
      composition: legs.map(([id], k) => ({ asset: aref(assetById.get(id)!), amounts: compAmounts[k], usd: compAmounts[k].map(v => v * priceof(id)) })),
    },
  }
}

// A pool's share-token holders, farm-deposited principal attributed to its owner
// (the rows marked "farm"). Shares and value are fractions of the SAME supply and
// TVL the pool card states, so the section reconciles with it by construction.
function buildPoolLps(poolId: number, offset: number, limit: number): PoolLpsResponse | undefined {
  const p = poolById.get(poolId)
  if (!p) return undefined
  const share = assetById.get(p.lpAssetId)
  const dec = share?.decimals ?? 12
  const tvl = poolTvlUsd(p)
  const all = ACCS.map((account, i) => {
    const shares = p.totalShares / (i + 2)
    const farmed = i % 3 === 0 ? shares * 0.4 : null
    return {
      rank: i + 1, account, shares: raw(shares, dec),
      farmedShares: farmed == null ? null : raw(farmed, dec),
      sharePct: shares / p.totalShares * 100,
      valueUsd: shares / p.totalShares * tvl,
    }
  })
  return {
    poolId: p.lpAssetId,
    shareToken: share ? aref(share) : { assetId: p.lpAssetId, symbol: 'LP', name: null, decimals: dec, parachainId: null },
    totalShares: raw(p.totalShares, dec), tvlUsd: tvl, total: all.length,
    lps: all.slice(offset, offset + limit),
  }
}

function buildPoolsIndex(): PoolsIndexResponse {
  const entry = (poolId: number, name: string, legs: [number, number][]) => {
    const composition = legs.map(([id, usd]) => ({ asset: aref(assetById.get(id) ?? ASSETS[0]), amount: raw(usd, 12), usd, sharePct: 0 }))
    const tvlUsd = composition.reduce((s, c) => s + (c.usd ?? 0), 0)
    for (const c of composition) c.sharePct = tvlUsd > 0 ? ((c.usd ?? 0) / tvlUsd) * 100 : 0
    return { kind: 'xyk' as const, poolId, name, tvlUsd, sharePct: 0, composition }
  }
  const pools = [
    ...POOLS.map(p => entry(p.lpAssetId, p.name, poolLegs(p).map(([id, reserve]) => [id, reserve * priceof(id)] as [number, number]))),
    // The tail: folded behind one line until a reader asks for it.
    ...Array.from({ length: 6 }, (_, i) => entry(1_000_100 + i, `LONGTAIL${i} / HDX`, [[0, i], [5, 0]])),
  ]
  const totalTvlUsd = pools.reduce((s, p) => s + (p.tvlUsd ?? 0), 0)
  for (const p of pools) p.sharePct = totalTvlUsd > 0 ? ((p.tvlUsd ?? 0) / totalTvlUsd) * 100 : 0
  return { totalTvlUsd, pools }
}

// Pools currently holding an asset (the Liquidity tab's count chip).
function mockLiquiditySourceCount(assetId: number): number {
  return POOLS.filter(p => p.assetA === assetId || p.assetB === assetId).length
}

// A pool's own activity: the swaps that happened IN it (between its member
// assets). That is the half the share token's own activity feed can never show,
// and its absence is what made a busy pool look idle.
function mockPoolActivity(poolId: number, limit: number): ActivityRow[] {
  const p = poolById.get(poolId)
  if (!p) return []
  const members = [p.assetA, p.assetB]
  const rows: ActivityRow[] = []
  for (let i = 0; i < 6 && rows.length < limit; i++) {
    const h = TIP - i * 3
    const [x, y] = i % 2 === 0 ? members : [...members].reverse()
    const aIn = assetById.get(x)!, aOut = assetById.get(y)!
    const amt = 120 + i * 37
    rows.push({
      type: 'trade', blockHeight: h, timestamp: tsAt(h), eventIndex: 40 + i, extrinsicIndex: 2,
      who: ACCS[i % ACCS.length], to: null, asset: null,
      assetIn: aref(aIn), assetOut: aref(aOut),
      amount: null, amountIn: raw(amt, aIn.decimals), amountOut: raw(amt * aIn.price / aOut.price, aOut.decimals),
      valueUsd: amt * aIn.price, linkBlock: h, linkIndex: 2,
    })
  }
  return rows.slice(0, limit)
}

function assetScopedActivityRows(qs: URLSearchParams): ActivityRow[] {
  const a = assetById.get(Number(qs.get('asset'))) ?? ASSETS[0]
  const activityType = qs.get('type') ?? 'all'; const limit = Number(qs.get('limit') ?? 40)
  const min = qs.get('min') ? Number(qs.get('min')) : null
  const out: ActivityRow[] = []; let h = TIP
  while (out.length < limit && h > TIP - 1200) {
    const r = rng(h * 2654435761 + a.assetId); const t = FEED_TYPES[h % FEED_TYPES.length]
    if (activityType !== 'all' && t !== activityType) { h -= 1 + Math.floor(r() * 3); continue }
    const other = ASSETS[Math.floor(r() * ASSETS.length)]
    // ~1 in 4 rows is smol so the "$ from" filter has something to drop
    const amt = r() < 0.25 ? +((0.5 + r() * 8) / a.price).toFixed(6) : +(10 + r() * 4000).toFixed(2)
    const who = ACCS[Math.floor(r() * ACCS.length)]
    const base = { blockHeight: h, timestamp: tsAt(h), eventIndex: h % 100, extrinsicIndex: 2 + Math.floor(r() * 3), who, to: null as AccountRef | null, asset: null as AssetRef | null, assetIn: null as AssetRef | null, assetOut: null as AssetRef | null, amount: null as string | null, amountIn: null as string | null, amountOut: null as string | null, valueUsd: amt * a.price }
    if (min != null && base.valueUsd < min) { h -= 1 + Math.floor(r() * 3); continue }
    if (t === 'trade') out.push({ ...base, type: t, assetIn: aref(a), assetOut: aref(other), amountIn: raw(amt, a.decimals), amountOut: raw(amt * a.price / other.price, other.decimals) })
    else if (t === 'xcm' && h % 2 === 0) out.push({ ...base, type: t, extrinsicIndex: null, asset: aref(a), amount: raw(amt, a.decimals), xcmDir: 'in', fromChain: 'AssetHub' })
    else if (t === 'transfer' || t === 'xcm') out.push({ ...base, type: t, to: ACCS[Math.floor(r() * ACCS.length)], asset: aref(a), amount: raw(amt, a.decimals), destChain: t === 'xcm' ? 'Moonbeam' : undefined, destAccount: t === 'xcm' ? xcmDestAccount(h) : undefined, xcmDir: t === 'xcm' ? 'out' : undefined })
    else out.push({ ...base, type: t, asset: aref(a), amount: raw(amt, a.decimals), liqAction: (['Add', 'Remove'] as const)[h % 2] })
    h -= 1 + Math.floor(r() * 3)
  }
  return out.slice(0, limit)
}

/* ---------- governance ---------- */
const GOV_TRACK = { id: 0, name: 'root' }
function govReferendumRow(index: number) {
  const h = TIP - (400 - index) * 1200
  return {
    pallet: 'opengov' as const, index, title: `Runtime upgrade proposal #${index}`,
    status: index % 4 === 0 ? 'Confirmed' : index % 4 === 1 ? 'Deciding' : index % 4 === 2 ? 'Rejected' : 'Approved',
    voters: 40 + (index % 60), blockHeight: h, timestamp: tsAt(h),
    track: GOV_TRACK, proposer: ACCS[index % ACCS.length],
    enactment: index % 4 === 3 ? ('ok' as const) : null,
  }
}
function buildGovernance(): GovernanceOverview {
  return {
    active: [380, 379, 378].map(index => {
      const row = govReferendumRow(index)
      return {
        index, title: row.title, status: 'Deciding', track: GOV_TRACK, proposer: row.proposer,
        submittedAt: { blockHeight: row.blockHeight, extrinsicIndex: 2, timestamp: row.timestamp },
        progress: null,
        tally: { ayes: raw(2_400_000, 12), nays: raw(310_000, 12), support: raw(2_710_000, 12), source: 'snapshot' as const },
      }
    }),
    counts: { opengov: 381, democracy: 264, tcMotions: 42, councilMotions: 0, tips: 17 },
  }
}
function buildReferendum(pallet: 'opengov' | 'democracy', index: number): ReferendumDetail {
  const row = govReferendumRow(index)
  const hdx = ASSETS[0]
  const voters = ACCS.map((account, i) => ({
    account, kind: 'Standard' as const, side: (i % 5 === 0 ? 'Nay' : 'Aye') as 'Aye' | 'Nay',
    conviction: MOCK_VOTE_CONVICTIONS[i % MOCK_VOTE_CONVICTIONS.length], convictionIndex: i % 6,
    balance: raw(100_000 * (i + 1), hdx.decimals),
    ayeBalance: i % 5 === 0 ? '0' : raw(100_000 * (i + 1), hdx.decimals),
    nayBalance: i % 5 === 0 ? raw(100_000 * (i + 1), hdx.decimals) : '0',
    abstainBalance: '0',
    weightedAye: i % 5 === 0 ? '0' : raw(600_000 * (i + 1), hdx.decimals),
    weightedNay: i % 5 === 0 ? raw(600_000 * (i + 1), hdx.decimals) : '0',
    weighted: raw(600_000 * (i + 1), hdx.decimals),
    valueUsd: 100_000 * (i + 1) * hdx.price,
    blockHeight: row.blockHeight + i, eventIndex: 95, extrinsicIndex: 3,
    timestamp: tsAt(row.blockHeight + i), removed: false,
  }))
  return {
    pallet, index, title: row.title, proposer: row.proposer,
    subsquareUrl: `https://hydration.subsquare.io/referenda/${index}`,
    track: GOV_TRACK.id, proposalHash: hx(index * 13 + 1, 64),
    proposalCall: { pallet: 'System', callName: 'set_code', args: { code: '0x…runtime' }, encoded: null, byteLength: 1_482_112, decodeError: null },
    status: row.status, enactment: row.enactment,
    submittedAt: { blockHeight: row.blockHeight, extrinsicIndex: 2, timestamp: row.timestamp },
    concludedAt: null,
    asset: aref(hdx),
    onChainTally: null,
    directTally: {
      ayes: raw(12_600_000, 12), nays: raw(600_000, 12), rawAyes: raw(2_100_000, 12), rawNays: raw(100_000, 12),
      support: raw(2_200_000, 12), ayeVoters: voters.length - 2, nayVoters: 2, splitVoters: 0, voters: voters.length,
    },
    indirectTally: null,
    voters, votesShown: voters.length, votesTotal: voters.length,
    timeline: [{ event: 'Submitted', blockHeight: row.blockHeight, extrinsicIndex: 2, timestamp: row.timestamp }],
    trackInfo: { ...GOV_TRACK, preparePeriod: 1200, decisionPeriod: 100_800, confirmPeriod: 7200, minEnactmentPeriod: 14_400, decisionDeposit: raw(500_000, 12) },
    liveTally: null,
    progress: null,
  }
}

/* ---------- routes ---------- */
const ROUTES: { re: RegExp; fn: (m: RegExpMatchArray, qs: URLSearchParams) => unknown }[] = [
  { re: /^\/explorer\/stats$/, fn: () => ({ headBlock: TIP, finalizedBlock: TIP - 2, headTime: tsAt(TIP), avgBlockSec: 5.7, nominalBlockSec: 6, transfers24h: 18204, extrinsics24h: 42318, activeAccounts24h: 7120, hdxPrice: 0.02184 } satisfies ExplorerStats) },
  { re: /^\/indexer$/, fn: () => ({ blockHeight: TIP, blockTimestamp: tsAt(TIP), lagSeconds: 6, chainBlockHeight: TIP + 1, blocksBehindHead: 1 } satisfies IndexerStatus) },
  // Two shapes off one directory, exactly as the API serves them: the full rows the
  // Assets page renders, and `fields=filter`'s id/symbol/name projection in the same
  // order, which is all a token combo shows and searches.
  { re: /^\/explorer\/assets$/, fn: (_m, qs) => qs.get('fields') === 'filter' ? buildAssets().map(a => ({ assetId: a.assetId, symbol: a.symbol, name: a.name, price: a.price })) : buildAssets() },
  // The call/event name catalogue behind the name filters.
  { re: /^\/explorer\/filter-names$/, fn: () => MOCK_FILTER_NAMES },
  { re: /^\/explorer\/accounts$/, fn: (_m, qs) => buildAccounts(Number(qs.get('offset') ?? 0), Number(qs.get('limit') ?? 50), qs.get('sort') ?? 'value') },
  { re: /^\/explorer\/daily\/(\w+)$/, fn: (m) => Array.from({ length: 45 }, (_, i) => { const d = new Date(MOCK_NOW_MS - (44 - i) * 86400000); const r = rng(i + m[1].length * 7); return { date: d.toISOString().slice(0, 10), value: Math.round((m[1] === 'events' ? 60000 : m[1] === 'extrinsics' ? 12000 : 4000) * (0.5 + r())) } as DailyPoint }) },
  { re: /^\/explorer\/accounts-daily$/, fn: () => Array.from({ length: 30 }, (_, i) => { const d = new Date(MOCK_NOW_MS - (29 - i) * 86400000); const r = rng(i * 31 + 5); return { date: d.toISOString().slice(0, 10), active: Math.round(6000 * (0.6 + r() * 0.8)), new: Math.round(350 * (0.4 + r())) } }) },
  // events is deliberately longer than MOCK_LIST_MAX_OFFSET can page, so the mock
  // reproduces the real shape: a total whose last pages the API will not serve.
  { re: /^\/explorer\/counts$/, fn: () => ({ blocks: 567764, extrinsics: 132771, events: 302863213, transfers: 410000, maxOffset: MOCK_LIST_MAX_OFFSET }) },
  // The global Activity feed's bounds. Vote is the one category the real API counts
  // (it pages in SQL over a single source); everything else publishes only how deep
  // it serves, exactly as the API does.
  {
    re: /^\/explorer\/activity\/count$/, fn: (_m, qs) => {
      const type = qs.get('type') ?? 'all'
      const countable = type === 'vote' && !qs.get('action')
      return {
        total: countable ? MOCK_VOTE_ACTIVITY_TOTAL : null,
        complete: countable,
        maxOffset: type === 'vote' ? MOCK_NARROW_ACTIVITY_MAX_OFFSET : MOCK_ACTIVITY_MAX_OFFSET,
      }
    },
  },
  {
    re: /^\/explorer\/blocks$/, fn: (_m, qs) => {
      const limit = Number(qs.get('limit') ?? 25); const offset = Number(qs.get('offset') ?? 0)
      return Array.from({ length: limit }, (_, i) => { const h = TIP - offset - i; return { height: h, timestamp: tsAt(h), hash: hx(h, 64), author: h > TIP - 2 ? null : COLLATORS[0], specVersion: 428, extrinsicCount: blockExtrinsicCount(h), eventCount: blockExtrinsicCount(h) * 3 + (h % 5), ...mockFinal(h) } satisfies BlockSummary })
    },
  },
  {
    re: /^\/explorer\/block\/(\d+)$/, fn: (m) => {
      const h = Number(m[1]); const n = blockExtrinsicCount(h)
      const exts = Array.from({ length: n }, (_, i) => genExtrinsic(h, i))
      const events: BlockDetail['events'] = []
      exts.forEach(x => x.events.forEach(e => events.push({ eventIndex: events.length, extrinsicIndex: x.index, name: e.name, args: e.args })))
      return {
        height: h, timestamp: tsAt(h), hash: hx(h, 64), author: COLLATORS[0], specVersion: 428, extrinsicCount: n, eventCount: events.length,
        parentHash: hx(h - 1, 64), stateRoot: hx(h * 3, 64), extrinsicsRoot: hx(h * 5, 64),
        extrinsics: exts.map(x => ({ blockHeight: x.blockHeight, index: x.index, hash: x.hash, timestamp: x.timestamp, signer: x.signer, success: x.success, callName: x.callName, fee: x.fee })),
        events,
        ...mockFinal(h),
      } satisfies BlockDetail
    },
  },
  { re: /^\/explorer\/block\/(\d+)\/activity$/, fn: (m) => mockBlockActivity(Number(m[1])) },
  { re: /^\/explorer\/extrinsics$/, fn: (_m, qs) => recentExtrinsics(Number(qs.get('limit') ?? 25), qs.get('signedOnly') === '1') },
  // Past the block's last index there is no extrinsic, so the fixture answers as the
  // API does — nothing, which the callers turn into a 404. Handing back an invented
  // extrinsic would make every block look endless to anything that pages or probes.
  { re: /^\/explorer\/extrinsic-at\/(\d+)\/(\d+)$/, fn: (m) => Number(m[2]) < blockExtrinsicCount(Number(m[1])) ? { ...genExtrinsic(Number(m[1]), Number(m[2])), ...mockFinal(Number(m[1])) } : undefined },
  { re: /^\/explorer\/extrinsic-at\/(\d+)\/(\d+)\/activity$/, fn: (m) => mockExtrinsicActivity(Number(m[1]), Number(m[2])) },
  // The extrinsic's SCALE bytes, fetched on demand by the "call data" copy button.
  { re: /^\/explorer\/extrinsic-at\/(\d+)\/(\d+)\/encoded$/, fn: (m) => Number(m[2]) < blockExtrinsicCount(Number(m[1])) ? { encoded: hx(Number(m[1]) * 23 + Number(m[2]), 120) } : undefined },
  { re: /^\/explorer\/extrinsic\/(0x[0-9a-f]+)$/, fn: () => genExtrinsic(12_848_613, 4) },
  { re: /^\/explorer\/extrinsic\/(0x[0-9a-f]+)\/activity$/, fn: () => mockExtrinsicActivity(12_848_613, 4) },
  {
    re: /^\/explorer\/trade\/(\d+)\/(\d+)$/, fn: (m) => {
      const h = Number(m[1]), i = Number(m[2]); const r = rng(h * 7 + i + 3)
      const aIn = ASSETS[2], mid = ASSETS[3], aOut = ASSETS[1]
      const amtIn = +(500 + r() * 3000).toFixed(2), amtMid = amtIn * aIn.price / mid.price, amtOut = amtIn * aIn.price / aOut.price
      return {
        blockHeight: h, timestamp: tsAt(h), extrinsicIndex: i, eventIndex: 42, hash: '0x' + 'ab'.repeat(32), success: true,
        who: ACCS[Math.floor(r() * ACCS.length)], venue: 'Router', direction: 'Sell',
        assetIn: aref(aIn), assetOut: aref(aOut), amountIn: raw(amtIn, aIn.decimals), amountOut: raw(amtOut, aOut.decimals),
        valueUsd: amtIn * aIn.price, executionPrice: aIn.price / aOut.price,
        limit: { kind: 'minReceived', amount: raw(amtOut * 0.985, aOut.decimals), asset: aref(aOut), marginPct: 1.52 },
        extrinsicFee: '12000000000000',
        extrinsicTip: '3000000000000',
        route: [
          { pool: 'XYK', poolId: null, assetIn: aref(aIn), assetOut: aref(mid), amountIn: null, amountOut: null, fee: null },
          { pool: 'XYK', poolId: XYK_LP_ID, assetIn: aref(mid), assetOut: aref(aOut), amountIn: raw(amtMid, mid.decimals), amountOut: raw(amtOut, aOut.decimals), fee: { amount: raw(amtOut * 0.0025, aOut.decimals), asset: aref(aOut) } },
        ],
      } satisfies TradeDetailResponse
    },
  },
  {
    re: /^\/explorer\/trade-event\/(\d+)\/(\d+)$/, fn: (m) => {
      const h = Number(m[1]), e = Number(m[2])
      const aIn = ASSETS[2], aOut = ASSETS[1]
      const amtIn = 1234.56
      const amtOut = amtIn * aIn.price / aOut.price
      return {
        blockHeight: h, timestamp: tsAt(h), extrinsicIndex: null, eventIndex: e, hash: null, success: true,
        who: A.fox, venue: 'Router', direction: 'Sell',
        assetIn: aref(aIn), assetOut: aref(aOut), amountIn: raw(amtIn, aIn.decimals), amountOut: raw(amtOut, aOut.decimals),
        valueUsd: amtIn * aIn.price, executionPrice: aIn.price / aOut.price,
        limit: null, extrinsicFee: null, extrinsicTip: null,
        route: [{ pool: 'Router', poolId: null, assetIn: aref(aIn), assetOut: aref(aOut), amountIn: raw(amtIn, aIn.decimals), amountOut: raw(amtOut, aOut.decimals), fee: null }],
      } satisfies TradeDetailResponse
    },
  },
  { re: /^\/explorer\/events$/, fn: (_m, qs) => recentEvents(Number(qs.get('limit') ?? 25)) },
  {
    re: /^\/explorer\/event\/(\d+)\/(\d+)$/, fn: (m) => {
      const h = Number(m[1]), i = Number(m[2])
      const x = genExtrinsic(h, Math.min(i, blockExtrinsicCount(h) - 1))
      const e = x.events[i % x.events.length]
      return {
        blockHeight: h, eventIndex: i, extrinsicIndex: x.index, timestamp: tsAt(h),
        name: e.name, args: e.args, decoded: true, phase: `ApplyExtrinsic(${x.index})`,
        extrinsic: { blockHeight: x.blockHeight, index: x.index, hash: x.hash, timestamp: x.timestamp, signer: x.signer, success: x.success, callName: x.callName, fee: x.fee },
      } satisfies EventDetail
    },
  },
  {
    re: /^\/explorer\/activity$/, fn: (_m, qs) => {
      if (qs.get('asset') != null) return assetScopedActivityRows(qs)   // unified endpoint, asset-pinned form
      const limit = Number(qs.get('limit') ?? 25); const out: ActivityRow[] = []
      const requestedType = qs.get('type') ?? 'all'
      const min = qs.get('min') ? Number(qs.get('min')) : null
      let h = TIP
      if (requestedType === 'all' || requestedType === 'trade') {
        // The newest trade rides an unfinalized block: no detail link yet, the
        // row is dimmed and non-navigable until finality.
        out.push({
          type: 'trade', blockHeight: h + 1, timestamp: tsAt(h + 1), eventIndex: 77, extrinsicIndex: null,
          who: A.fox, to: null, asset: null, assetIn: aref(ASSETS[2]), assetOut: aref(ASSETS[1]),
          amount: null, amountIn: raw(1234.56, ASSETS[2].decimals), amountOut: raw(1234.56 * ASSETS[2].price / ASSETS[1].price, ASSETS[1].decimals),
          valueUsd: 1234.56 * ASSETS[2].price, finalized: false,
        })
      }
      // The vote category has its own generator: votes are not part of the
      // per-height type cycle, so without this the tab renders empty and nothing
      // exercises how a vote row reads.
      if (requestedType === 'vote') {
        // Every fifth row is a committee vote: the feed merges the collective votes
        // into the same category, so the tab has to render both shapes.
        while (out.length < limit && h > TIP - 400) {
          out.push(h % 5 === 0 ? collectiveVoteRowAtHeight(h) : voteRowAtHeight(h))
          h -= 1 + (h % 3)
        }
        return out.slice(0, limit)
      }
      while (out.length < limit && h > TIP - 400) {
        const r = rng(h * 2654435761 + 13)
        const row = activityRowAtHeight(h)
        const skip = min != null && (row.valueUsd ?? 0) < min   // mirrors the server-side min filter
        if (!skip && (requestedType === 'all' || requestedType === row.type)) out.push(row)
        h -= 1 + Math.floor(r() * 3)
      }
      return out.slice(0, limit)
    },
  },
  {
    re: /^\/explorer\/asset\/(\d+)$/, fn: (m) => {
      const a = assetById.get(Number(m[1])) ?? ASSETS[0]
      const totalUsd = ACCS.reduce((s, _ac, i) => s + (i + 1) * 12000, 0)
      const priceSeries = series(a.assetId * 13 + 1, 180, a.price)
      const priceDates = priceSeries.map((_, i) => new Date(MOCK_NOW_MS - (priceSeries.length - 1 - i) * 86_400_000).toISOString().slice(0, 10))
      return {
        asset: { ...aref(a), price: a.price, change24h: a.ch / 100, change7d: a.ch7d / 100, type: a.type, amountUsd: totalUsd },
        holderCount: ACCS.length, totalUsd, priceSeries, priceDates,
        liquiditySourceCount: mockLiquiditySourceCount(a.assetId),
      } satisfies AssetDetail
    },
  },
  { re: /^\/explorer\/asset\/(\d+)\/liquidity$/, fn: m => buildAssetLiquidity(Number(m[1])) },
  // The /liquidity index: every pool largest first, including the long tail of
  // XYK dust the page folds away by default.
  { re: /^\/explorer\/pools$/, fn: () => buildPoolsIndex() },
  // Unknown pool ids fall through to the harness 404, like the real endpoint.
  { re: /^\/explorer\/pool\/(\d+)$/, fn: m => buildPoolDetail(Number(m[1])) },
  { re: /^\/explorer\/pool\/(\d+)\/activity$/, fn: (m, qs) => mockPoolActivity(Number(m[1]), Number(qs.get('limit') ?? 25)) },
  { re: /^\/explorer\/pool\/(\d+)\/lps$/, fn: (m, qs) => buildPoolLps(Number(m[1]), Number(qs.get('offset') ?? 0), Number(qs.get('limit') ?? 10)) },
  {
    re: /^\/explorer\/holders\/(\d+)$/, fn: (m, qs) => {
      const a = assetById.get(Number(m[1])) ?? ASSETS[0]
      const offset = Number(qs.get('offset') ?? 0), limit = Number(qs.get('limit') ?? 100)
      const all = ACCS.map((ac, i) => { const bal = (i + 1) * 12000 / a.price; return { rank: i + 1, account: ac.tag ? null : ac, tag: ac.tag ? { tagId: ac.tag.id, name: ac.tag.name, color: ac.tag.color, icon: ac.tag.icon, memberCount: 2 } : null, balance: raw(bal, a.decimals), lastBlock: TIP - i * 100, valueUsd: bal * a.price } })
      const totalUsd = all.reduce((s, h) => s + (h.valueUsd ?? 0), 0)
      const holders = all.map(h => ({ ...h, share: totalUsd > 0 ? (h.valueUsd ?? 0) / totalUsd : 0 })).slice(offset, offset + limit)
      return { asset: aref(a), holders, total: all.length, totalUsd } satisfies HoldersResponse
    },
  },
  {
    re: /^\/explorer\/address\/(.+)\/activity$/, fn: (m, qs) => {
      const rows = filteredMockActivity(accountActivityRows(m[1]), qs)
      const offset = Number(qs.get('offset') ?? 0)
      return rows.slice(offset, offset + Number(qs.get('limit') ?? 25))
    },
  },
  // The exact length of whichever list a pager is sizing itself against, under the
  // filters it is showing. Counted from the same rows the feed above returns, so the
  // fixture cannot advertise a page the mocked feed does not hold.
  { re: /^\/explorer\/address\/(.+)\/list-count$/, fn: (m, qs) => ({ total: mockListTotal(qs, () => accountActivityRows(m[1])) }) },
  { re: /^\/explorer\/address\/(.+)\/extrinsics$/, fn: (_m, qs) => recentExtrinsics(Number(qs.get('limit') ?? 25), true) },
  { re: /^\/explorer\/address\/(.+)\/events$/, fn: (_m, qs) => recentEvents(Number(qs.get('limit') ?? 25)) },
  { re: /^\/explorer\/address\/(.+)\/votes$/, fn: (m, qs) => mockVoteRows(ACCS.find(a => a.accountId === decodeURIComponent(m[1]) || a.address.toLowerCase() === decodeURIComponent(m[1]).toLowerCase()) ?? A.fox, Number(qs.get('limit') ?? 25)) },
  { re: /^\/explorer\/address\/(.+)\/value-events$/, fn: (m) => mockValueEvents(accountActivityRows(m[1])) },
  { re: /^\/explorer\/address\/(.+)\/counts$/, fn: () => ({ extrinsics: 1451, extrinsicsOnBehalf: 0, events: 26787, votes: 25 }) },
  // Per-account balance/portfolio history. Must sit before the generic address
  // route below, whose greedy `(.+)` would otherwise swallow this sub-path and
  // fall back to the default account — leaking one account's history onto another.
  // `series=1` is the Overview's shape: the value series without the per-asset
  // history the Balances treemap reads (98-99% of the real payload).
  { re: /^\/explorer\/address\/(.+)\/history$/, fn: (m, qs) => { const built = buildAddress(decodeURIComponent(m[1])); return { portfolioSeries: built.portfolioSeries ?? [], portfolioDates: built.portfolioDates ?? [], balanceHistory: qs.get('series') === '1' ? [] : built.balanceHistory ?? [] } satisfies AccountHistoryResponse } },
  {
    re: /^\/explorer\/address\/(.+)\/close-accounts$/, fn: () => ({
      accounts: [
        {
          account: A.binance,
          score: 0.91,
          confidence: 'strong',
          lastSeen: '2026-07-09 18:42:00',
          reasons: [
            { type: 'direct_transfers', count: 7, days: 4, valueUsd: 128_400, bidirectional: true },
            { type: 'near_signing', days: 9 },
          ],
        },
        {
          account: A.krakenEvm,
          score: 0.68,
          confidence: 'moderate',
          lastSeen: '2026-07-06 09:15:00',
          reasons: [{ type: 'shared_cex', name: 'Kraken' }],
        },
      ],
      lookbackDays: null,
      disclaimer: 'Behavioral signals are not proof of common ownership. System and high-volume protocol accounts are excluded.',
    } satisfies CloseAccountsResponse),
  },
  { re: /^\/explorer\/address\/(.+)$/, fn: (m) => buildAddress(decodeURIComponent(m[1])) },
  { re: /^\/explorer\/tag\/(.+)\/counts$/, fn: () => ({ extrinsics: 1451, extrinsicsOnBehalf: 0, events: 26787, votes: 25 }) },
  {
    re: /^\/explorer\/tag\/(.+)\/close-accounts$/, fn: () => ({
      accounts: [
        {
          account: A.binance,
          score: 0.87,
          confidence: 'strong',
          lastSeen: '2026-07-08 11:20:00',
          reasons: [
            { type: 'direct_transfers', count: 12, days: 6, valueUsd: 402_300, bidirectional: true },
            { type: 'near_signing', days: 5 },
          ],
        },
        {
          account: A.fox,
          score: 0.61,
          confidence: 'moderate',
          lastSeen: '2026-07-03 22:41:00',
          reasons: [{ type: 'direct_transfers', count: 3, days: 2, valueUsd: 9_800, bidirectional: false }],
        },
      ],
      lookbackDays: null,
      disclaimer: 'Behavioral signals are not proof of common ownership. System and high-volume protocol accounts are excluded.',
    } satisfies CloseAccountsResponse),
  },
  {
    re: /^\/explorer\/tag\/(.+)\/activity$/, fn: (_m, qs) => {
      const rows = filteredMockActivity(tagActivityRows(), qs)
      const offset = Number(qs.get('offset') ?? 0)
      return rows.slice(offset, offset + Number(qs.get('limit') ?? 25))
    },
  },
  { re: /^\/explorer\/tag\/(.+)\/list-count$/, fn: (_m, qs) => ({ total: mockListTotal(qs, tagActivityRows) }) },
  { re: /^\/explorer\/tag\/(.+)\/extrinsics$/, fn: (_m, qs) => recentExtrinsics(Number(qs.get('limit') ?? 25), true) },
  { re: /^\/explorer\/tag\/(.+)\/events$/, fn: (_m, qs) => recentEvents(Number(qs.get('limit') ?? 25)) },
  { re: /^\/explorer\/tag\/(.+)\/votes$/, fn: (_m, qs) => mockVoteRows(null, Number(qs.get('limit') ?? 25)) },
  // Grouped mode of the votes tab: one row per referendum, members combined.
  {
    re: /^\/explorer\/tag\/(.+)\/votes-by-referendum$/, fn: (_m, qs) => {
      const limit = Number(qs.get('limit') ?? 25)
      const hdx = ASSETS[0]
      const rows: VoteGroupRow[] = mockVoteRows(null, limit).map(v => ({
        pallet: v.pallet, referendum: v.referendum, voteRefPallet: v.voteRefPallet, voteRefTitle: v.voteRefTitle,
        side: v.side, voters: 2, weighted: v.weighted ?? null, amount: v.amount,
        blockHeight: v.blockHeight, timestamp: v.timestamp, eventIndex: v.eventIndex, extrinsicIndex: v.extrinsicIndex,
        asset: aref(hdx), valueUsd: v.valueUsd,
      }))
      return { rows, total: rows.length, complete: true } satisfies VotesByReferendumPage
    },
  },
  { re: /^\/explorer\/tag\/(.+)\/value-events$/, fn: () => mockValueEvents(tagActivityRows()) },
  // A tag's members as DIRECTORY rows: the same shape /explorer/accounts
  // returns, one row per member and never folded under the tag itself.
  { re: /^\/explorer\/tag\/(.+)\/members$/, fn: () => {
    const { rows } = buildAccounts(0, 50, 'value')
    const members = rows.filter(r => r.account).slice(0, 3).map(r => ({ ...r, tag: null }))
    return { rows: members, total: members.length } satisfies AccountsPage
  } },
  {
    re: /^\/explorer\/tag\/(.+)$/, fn: () => {
      const members = [A.krakenEvm, A.krakenSub]
      const balances = ASSETS.slice(0, 5).map((as, i) => {
        const bal = (i + 2) * 40000 / as.price
        // The tag's HDX row carries the members' summed lock breakdown so the
        // tag balances view exercises the same panel as accounts.
        if (as.assetId === 0) {
          return { asset: aref(as), total: raw(bal, as.decimals), free: raw(bal * 0.92, as.decimals), reserved: raw(bal * 0.08, as.decimals), lastBlock: TIP - i * 80, valueUsd: bal * as.price, ...hdxBreakdown(bal, as.decimals) }
        }
        return { asset: aref(as), total: raw(bal, as.decimals), free: raw(bal, as.decimals), reserved: '0', lastBlock: TIP - i * 80, valueUsd: bal * as.price }
      })
      const portfolioUsd = balances.reduce((s, b) => s + (b.valueUsd ?? 0), 0)
      const built = buildAddress(A.krakenEvm.accountId)
      return {
        tagId: 'kraken', name: 'Kraken', color: '#7b6cf6', note: 'Exchange — hot + deposit wallets', icon: '/tag-icons/kraken.jpg',
        members, balances,
        topAssets: balances.slice(0, 4).map(b => ({ asset: b.asset, valueUsd: b.valueUsd ?? 0 })),
        portfolioUsd, tradingVolumeUsd: portfolioUsd * 24,
        liquidityPositions: built.liquidityPositions ?? [],
        portfolioSeries: series(77, 52, portfolioUsd), balanceHistory: built.balanceHistory ?? [],
      } satisfies TagDetail
    },
  },
  { re: /^\/explorer\/governance$/, fn: () => buildGovernance() },
  {
    re: /^\/explorer\/governance\/referenda$/, fn: (_m, qs) => {
      const offset = Number(qs.get('offset') ?? 0), limit = Number(qs.get('limit') ?? 25)
      const all = Array.from({ length: 60 }, (_, i) => govReferendumRow(380 - i))
      return { total: all.length, rows: all.slice(offset, offset + limit) } satisfies GovernanceReferendaPage
    },
  },
  {
    re: /^\/explorer\/governance\/motions$/, fn: (_m, qs) => {
      const limit = Number(qs.get('limit') ?? 25)
      const rows = Array.from({ length: Math.min(limit, 8) }, (_, i) => {
        const h = TIP - (i + 1) * 9_000
        return {
          index: 42 - i, hash: hx(i * 7 + 5, 64), proposer: ACCS[i % ACCS.length], threshold: 3,
          ayes: 3 - (i % 2), nays: i % 2, call: 'Referenda.cancel',
          status: (i % 3 === 0 ? 'executed' : i % 3 === 1 ? 'open' : 'approved') as 'executed' | 'open' | 'approved',
          proposedAt: { blockHeight: h, extrinsicIndex: 2, timestamp: tsAt(h) },
          closedAt: i % 3 === 1 ? null : { blockHeight: h + 400, extrinsicIndex: 2, timestamp: tsAt(h + 400) },
        }
      })
      return { total: 42, rows } satisfies CollectiveMotionsPage
    },
  },
  {
    re: /^\/explorer\/governance\/tips$/, fn: (_m, qs) => {
      const limit = Number(qs.get('limit') ?? 25)
      const rows = Array.from({ length: Math.min(limit, 6) }, (_, i) => {
        const h = TIP - (i + 1) * 21_000
        return {
          hash: hx(i * 11 + 3, 64), reason: `Community contribution #${i + 1}`, beneficiary: ACCS[i % ACCS.length],
          payout: raw(12_000 * (i + 1), 12),
          status: (i === 0 ? 'open' : 'closed') as 'open' | 'closed',
          openedAt: { blockHeight: h, extrinsicIndex: 2, timestamp: tsAt(h) },
          closedAt: i === 0 ? null : { blockHeight: h + 7200, extrinsicIndex: 2, timestamp: tsAt(h + 7200) },
        }
      })
      return { total: 17, rows } satisfies TreasuryTipsPage
    },
  },
  { re: /^\/explorer\/referendum\/(opengov|democracy)\/(\d+)$/, fn: (m) => buildReferendum(m[1] as 'opengov' | 'democracy', Number(m[2])) },
  {
    re: /^\/explorer\/search$/, fn: (_m, qs) => {
      const q = (qs.get('q') ?? '').trim(); const out: SearchResult[] = []
      if (/^\d+$/.test(q)) out.push({ type: 'block', value: q })
      if (/^\d+-\d+$/.test(q)) out.push({ type: 'extrinsic', value: q })
      const sym = ASSETS.find(a => a.symbol.toLowerCase() === q.toLowerCase()); if (sym) out.push({ type: 'asset', value: String(sym.assetId), label: sym.symbol })
      if (/kraken/i.test(q)) out.push({ type: 'tag', value: 'kraken', label: 'Kraken', icon: '/tag-icons/kraken.jpg', color: '#7b6cf6' })
      const acct = ACCS.find(a => a.address.toLowerCase() === q.toLowerCase() || a.accountId.toLowerCase() === q.toLowerCase()); if (acct) out.push({ type: 'address', value: acct.accountId, label: acct.address, emoji: acct.emoji, identity: acct.identity })
      if (/^0x[0-9a-f]{40}$/i.test(q) && !acct) out.push({ type: 'address', value: q, label: q })
      // identity-name substring match
      if (/[a-z]/i.test(q)) {
        for (const a of ACCS) {
          if (a === acct || !a.identity?.display) continue
          if (a.identity.display.toLowerCase().includes(q.toLowerCase())) out.push({ type: 'address', value: a.accountId, label: a.address, emoji: a.emoji, identity: a.identity })
        }
      }
      // A pool by its name or share-token id.
      for (const p of POOLS) {
        if (String(p.lpAssetId) === q || p.name.toLowerCase().includes(q.toLowerCase())) {
          out.push({ type: 'pool', value: String(p.lpAssetId), label: p.name, poolKind: 'xyk', tvlUsd: poolTvlUsd(p), asset: aref(assetById.get(p.assetA)!) })
        }
      }
      // Referendum index or title, e.g. "263" or "treasury spend" — mirrors the
      // real search's two referendum matchers.
      if (/^\d+$/.test(q)) for (const r of MOCK_REFERENDA) if (String(r.index) === q) out.push(r)
      if (/[a-z]/i.test(q)) for (const r of MOCK_REFERENDA) if (r.label?.toLowerCase().includes(q.toLowerCase())) out.push(r)
      return out
    },
  },
  { re: /^\/explorer\/tags$/, fn: () => mockTags },
]

const mockTags: Tag[] = [
  { tagId: 'kraken', name: 'Kraken', color: '#7b6cf6', note: 'Exchange — hot + deposit wallets', icon: '/tag-icons/kraken.jpg', memberCount: 2 },
  { tagId: 'treasury', name: 'Treasury', color: '#74C742', note: '', icon: '🏦', memberCount: 1 },
]

// Same index (263), two pallets — mirrors the real Democracy/OpenGov collision
// the search dropdown and its route must keep distinct.
const MOCK_REFERENDA: SearchResult[] = [
  { type: 'referendum', value: 'opengov:263', label: 'Treasury spend for Bifrost integration', pallet: 'opengov', index: 263, status: 'deciding' },
  { type: 'referendum', value: 'democracy:263', label: 'Treasury Council election', pallet: 'democracy', index: 263, status: 'passed' },
]

export function mockSync<T>(path: string): T | undefined {
  const [p, query] = path.split('?')
  const qs = new URLSearchParams(query ?? '')
  for (const route of ROUTES) {
    const m = p.match(route.re)
    if (m) return route.fn(m, qs) as T
  }
  return undefined
}
