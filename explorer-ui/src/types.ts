export interface AssetOrigin {
  ecosystem: string
  chainId: string
  assetId: string | null
}

export interface AssetRef {
  assetId: number
  iconAssetId?: number
  symbol: string
  name: string | null
  decimals: number
  parachainId: number | null
  origin?: AssetOrigin | null
}

export interface TagRef { id: string; name: string; color: string; icon: string; memberCount?: number }

export interface AccountIdentity {
  display: string
  verified: boolean
  email: string
  web: string
  twitter: string
}

export interface AccountRef {
  accountId: string
  address: string        // Polkadot SS58 or EVM 0x (never Hydration SS58)
  emoji: string          // Omniwatch/snakewatch identity emoji
  emojiName?: string     // human-readable name for the custom emoji/icon (e.g. Discord emoji name)
  emojiUrl?: string      // custom image icon (e.g. a Discord avatar) — render in place of the emoji char
  tag: TagRef | null
  identity?: AccountIdentity | null   // on-chain Identity.IdentityOf display + judgement status
}

export interface ExplorerStats {
  headBlock: number
  finalizedBlock: number
  headTime: string
  // The chain's MEASURED pace — elastic scaling runs it a little ahead of the
  // slot time. Use it for a live block delta (a countdown to a future block).
  avgBlockSec: number
  // The runtime's NOMINAL slot time (6 today, 2 planned). Runtime block-count
  // constants — a fuse period, a lock duration — are DERIVED from it, so a
  // pallet's 14 400-block day is stated at this rate, never at the measured one.
  nominalBlockSec: number
  transfers24h: number
  extrinsics24h: number
  activeAccounts24h: number
  hdxPrice: number | null
}

export type ExplorerAssetType = 'Native' | 'Derivative' | 'Token'
export interface AssetListItem extends AssetRef {
  price: number | null
  change24h: number | null
  change7d?: number | null
  type: ExplorerAssetType
  amountUsd: number | null
  holderCount?: number
  sparkline?: number[]
}

// `/explorer/assets?fields=filter` — the same ordered directory projected down to
// what a token filter shows and searches on, plus the current price so a
// price-alert form can say what the token costs without a second request.
// `AssetListItem` widens to this, so surfaces that only build filter options
// accept either shape.
export type AssetFilterItem = Pick<AssetRef, 'assetId' | 'symbol' | 'name'> & { price?: number | null }

export interface TopAccountRow {
  account: AccountRef | null
  tag: { tagId: string; name: string; color: string; icon: string; memberCount: number } | null
  portfolioUsd: number
  lastBlock: number
  // Optional enrichments (design parity — populated where available).
  identity?: string | null
  // 1Y weekly value sparkline (fixed length, zero-padded → same range for all rows).
  sparkline?: number[]
  // The account's own activity feed total, the same number its detail page reports.
  // Absent for an account the background ranking has not counted.
  activityCount?: number
  // False when that total is a floor the feed could only be counted to in part.
  activityCountComplete?: boolean
  tradingVolumeUsd?: number
  // Up to 4 largest holdings (> $10, highest USD first) → icon cluster after value.
  topAssets?: { asset: AssetRef; valueUsd: number }[]
  // Further holdings over $10 the four icons leave out.
  otherAssets?: number
}

export type AccountSort = 'value' | 'identity' | 'activity' | 'volume'
export interface AccountsPage {
  rows: TopAccountRow[]
  total: number
}

// trade detail
export interface TradeHop {
  pool: string
  poolId: number | null
  assetIn: AssetRef
  assetOut: AssetRef
  amountIn: string | null
  amountOut: string | null
  fee: { amount: string; asset: AssetRef } | null
}
export interface TradeDetail {
  blockHeight: number
  timestamp: string
  extrinsicIndex: number | null
  eventIndex: number | null
  hash: string | null
  success: boolean
  who: AccountRef | null
  venue: string
  direction: 'Sell' | 'Buy'
  assetIn: AssetRef
  assetOut: AssetRef
  amountIn: string
  amountOut: string
  valueUsd: number | null
  executionPrice: number | null
  limit: { kind: 'minReceived' | 'maxPaid'; amount: string; asset: AssetRef; marginPct: number | null } | null
  extrinsicFee: string | null
  extrinsicTip: string | null
  // Set when the fee did not settle in HDX; shown instead of `extrinsicFee` and
  // `extrinsicTip`, whose tip slot it carries as `tipAmount`.
  feePayment?: FeePayment
  route: TradeHop[]
}

export interface DailyPoint { date: string; value: number }

export interface BlockSummary {
  // false = unfinalized (pending-head layer; may reorg away). Absent = finalized.
  finalized?: boolean
  height: number
  timestamp: string
  hash: string
  author: AccountRef | null
  specVersion: number
  extrinsicCount: number
  eventCount: number
}

export interface FailureReason { label: string; docs: string | null }

export function failureReasonText(r: FailureReason | null | undefined): string | undefined {
  if (!r) return undefined
  return r.docs ? `${r.label} — ${r.docs}` : r.label
}

export interface ExtrinsicOrigin {
  kind: 'proxy' | 'multisig'
  state?: 'pending' | 'executed' | 'cancelled'
  threshold?: number
  signatories?: number
  approvals?: number
  callHash?: string
  // The operation's initiator — the signatory who proposed/sent it (not
  // necessarily the executing signer shown on 'executed' rows).
  initiator?: AccountRef
  // Chronological approval history: who did what, and when. `extrinsicId` is
  // the "block-extrinsic" of that timeline event, for linking to it directly.
  timeline?: { account: AccountRef; action: 'initiated' | 'approved' | 'executed' | 'cancelled'; timestamp: string; extrinsicId: string }[]
}

export interface ExtrinsicSummary {
  // false = unfinalized (pending-head layer; may reorg away). Absent = finalized.
  finalized?: boolean
  blockHeight: number
  index: number
  hash: string
  timestamp: string
  signer: AccountRef | null
  success: boolean
  callName: string
  fee: string | null
  origin?: ExtrinsicOrigin
  // Optional here (list rows omit it on success); ExtrinsicDetail narrows this to
  // `FailureReason | null` always-present, hence the `| null` so the override
  // stays assignable to the base property type.
  errorReason?: FailureReason | null
}

export interface BlockEvent { eventIndex: number; extrinsicIndex: number | null; name: string; args: unknown }
export interface BlockDetail extends BlockSummary {
  parentHash: string
  stateRoot: string | null
  extrinsicsRoot: string | null
  extrinsics: ExtrinsicSummary[]
  events: BlockEvent[]
  // How many of the block's events `events` carries — below eventCount on busy
  // blocks, where the list is a prefix.
  eventsShown?: number
}

export interface ExtrinsicEvent { eventIndex: number; name: string; args: unknown; decoded?: boolean }
// What the fee actually cost, when the signer's fee currency is not HDX (or when
// there is no HDX figure at all — an EVM transaction). `fee`/`tip` still carry
// the HDX-equivalent the chain computed; a surface holding this shows it INSTEAD.
export interface FeePayment {
  asset: AssetRef
  amount: string
  tipAmount: string | null
}

export interface ExtrinsicDetail extends ExtrinsicSummary {
  version: number
  tip: string | null
  feePayment?: FeePayment
  callArgs: unknown
  error: unknown
  errorReason: FailureReason | null
  events: ExtrinsicEvent[]
}

export interface TransferRow {
  blockHeight: number
  timestamp: string
  eventIndex: number
  extrinsicIndex: number | null
  from: AccountRef
  to: AccountRef
  amount: string
  asset: AssetRef
  valueUsd: number | null
}

export interface HolderRow {
  rank: number
  account: AccountRef | null
  // `memberCount` counts members holding this asset.
  tag: { tagId: string; name: string; color: string; icon: string; memberCount: number } | null
  balance: string
  lastBlock: number
  valueUsd?: number | null
  share?: number
}
export interface HoldersResponse { asset: AssetRef; holders: HolderRow[]; total: number; totalUsd: number }

// A lock decomposed by WHEN it can release: already releasable (an unlock or
// claim call away), scheduled for an estimated time, or open-ended while votes,
// delegations or staking stay active. Tranche amounts sum to the lock amount.
export interface BalanceLockTranche { state: 'releasable' | 'scheduled' | 'active'; amount: string; until?: string; linear?: boolean }
// One lock/reserve/hold/deposit component of an asset balance. Locks OVERLAP
// (the largest one is the binding amount); reserve-side kinds add up to the
// reserved figure.
export interface BalanceLockComponent { kind: 'lock' | 'reserve' | 'hold' | 'deposit'; source: string; amount: string; claimable?: string; tranches?: BalanceLockTranche[] }
// The binding unlock timeline across ALL of the account's locks: when how much
// of the frozen balance actually becomes transferable, and which lock causes it
// ('cause'; ties join with '+'). Act-now semantics: `conditional` marks slices
// that only free if the owner acts now (GIGAHDX staked → 28d after unstaking).
// Slice amounts sum to `frozen`.
export interface BalanceUnlockSlice { state: 'releasable' | 'scheduled' | 'active'; cause: string; amount: string; until?: string; linear?: boolean; conditional?: boolean }
// `frozen` is the non-transferable part of `free` (per-account max lock, summed
// across the account set for tags).
export interface AddressBalance { asset: AssetRef; total: string; free: string; reserved: string; frozen?: string; breakdown?: BalanceLockComponent[]; timeline?: BalanceUnlockSlice[]; lastBlock: number; valueUsd: number | null }
export interface LpPosition { positionId: string; asset: AssetRef; amount: string; hubAmount?: string; shares: string; valueUsd: number | null; venue: string }
// Proxy & multisig relations (accounts resolved to displayable refs).
export interface ProxyRelation { account: AccountRef; proxyType: string; delay: number }
export interface AccountProxyInfo {
  isPure: { creator: AccountRef; proxyType: string; blockHeight: number; extrinsicIndex: number | null; timestamp: string } | null
  delegates: ProxyRelation[]    // accounts that can act for this one
  delegatorOf: ProxyRelation[]  // accounts this one can act for
}
export interface PendingMultisigOp { callHash: string; depositor: AccountRef; approvals: AccountRef[]; sinceBlock: number }
export interface MultisigInfo { threshold: number; signatories: AccountRef[]; pending: PendingMultisigOp[] }
export interface MultisigMembership { account: AccountRef; threshold: number; signatories: number }

export interface AddressDetail {
  input: string
  kind: string
  accountId: string
  emoji: string
  emojiName?: string
  emojiUrl?: string
  evmAddress: string | null
  ss58: string
  ss58Polkadot: string
  tag: TagRef | null
  identity: AccountIdentity | null
  relatedAccountIds: string[]
  balances: AddressBalance[]
  // Up to 4 largest holdings (> $10 and ≥ 10% of held value) — shared by the
  // accounts list icons and the hover card.
  topAssets: { asset: AssetRef; valueUsd: number }[]
  portfolioUsd: number
  tradingVolumeUsd?: number
  liquidityPositions?: LpPosition[]
  proxy?: AccountProxyInfo | null
  multisig?: MultisigInfo | null
  multisigMemberships?: MultisigMembership[]
  portfolioSeries?: number[]
  portfolioDates?: string[]
  balanceHistory?: AssetBalanceHistory[]
}

export interface AssetBalancePoint { ts: string; blockHeight: number; balance: number }
export interface AssetBalanceHistory { asset: AssetRef; current: number; points: AssetBalancePoint[]; availableFrom?: string }
export interface AccountHistoryResponse { portfolioSeries: number[]; portfolioDates: string[]; balanceHistory: AssetBalanceHistory[] }

// One of the account/tag's largest value-changing events (big transfers in/out,
// swaps, liquidity moves, cross-chain flows) — the value chart's clickable
// markers. A 'price' marker annotates a big value-line jump no discrete event
// explains (its valueUsd is the SIGNED delta, asset is null).
export interface ValueEvent {
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  timestamp: string
  kind: 'transfer-in' | 'transfer-out' | 'swap' | 'liquidity' | 'cross-chain' | 'price' | 'other'
  valueUsd: number
  asset: AssetRef | null
  counterparty: AccountRef | null
  // Cross-chain flow direction (inbound credit vs outbound send).
  direction?: 'in' | 'out'
  // false when a cross-chain marker has no resolvable detail row → render unlinked.
  linkable?: boolean
  // Traded pair for swap markers; `asset` stays the value-bearing leg.
  assetIn?: AssetRef | null
  assetOut?: AssetRef | null
  // Raw token amount in `asset` decimals — only on single-event markers.
  amount?: string
}

export type CloseAccountReason =
  | { type: 'direct_transfers'; count: number; days: number; valueUsd: number | null; bidirectional: boolean }
  | { type: 'near_signing'; days: number }
  | { type: 'shared_cex'; name: string }

export interface CloseAccountMatch {
  account: AccountRef
  score: number
  confidence: 'strong' | 'moderate'
  lastSeen: string
  reasons: CloseAccountReason[]
}

export interface CloseAccountsResponse {
  accounts: CloseAccountMatch[]
  lookbackDays: number | null   // null: unlimited — the full indexed history
  disclaimer: string
}

export interface SearchResult {
  type: 'block' | 'extrinsic' | 'address' | 'asset' | 'tag' | 'referendum' | 'pool'
  value: string
  label?: string
  desc?: string   // asset-type: the descriptive name (e.g. DOT → "Polkadot")
  asset?: AssetRef
  // Address-type results carry the account's emoji + on-chain identity so the
  // dropdown can render the account pill directly.
  emoji?: string
  emojiName?: string
  emojiUrl?: string
  identity?: AccountIdentity | null
  // Tag-type results carry the tag's icon (URL/emoji glyph) and color so the
  // dropdown can render the tag's icon in front of the entry.
  icon?: string
  color?: string
  // Referendum-type results carry pallet+index (its real identity — Democracy and
  // OpenGov both index from 0) and its lifecycle status, so the dropdown links
  // straight to `/referendum/:pallet/:index` with no follow-up fetch.
  pallet?: 'opengov' | 'democracy'
  index?: number
  status?: string
  // Pool-type results: the venue and current TVL for the caption; `value` is
  // the pool id, `asset` the icon.
  poolKind?: 'xyk'
  tvlUsd?: number | null
}

// Directory row for /explorer/tags. Members themselves come from the tag detail
// endpoint; the list only ever shows how many there are.
export interface Tag {
  tagId: string
  name: string
  color: string
  note: string
  icon: string
  memberCount: number
}

export interface IndexerStatus {
  blockHeight: number
  blockTimestamp: string
  lagSeconds: number
  chainBlockHeight: number
  blocksBehindHead: number
  // false when the API could not sample the chain head — blocksBehindHead is then
  // measured against raw ingestion's own head, so 0 does not mean "in sync".
  chainHeadSampled?: boolean
}

export interface EventRow {
  // false = unfinalized (pending-head layer; may reorg away). Absent = finalized.
  finalized?: boolean
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  timestamp: string
  name: string
  args: unknown
  decoded: boolean
}

export interface EventDetail {
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  timestamp: string
  name: string
  args: unknown
  decoded: boolean
  phase: string
  extrinsic: ExtrinsicSummary | null
}

export interface TradeRow {
  blockHeight: number
  timestamp: string
  eventIndex: number
  extrinsicIndex: number | null
  who: AccountRef | null
  assetIn: AssetRef
  assetOut: AssetRef
  amountIn: string
  amountOut: string
  valueUsd: number | null
  venue: string
  linkBlock?: number | null
  linkIndex?: number | null
}

export interface ActivityRow {
  type: 'transfer' | 'trade' | 'xcm' | 'liquidity' | 'vote'
  // false = unfinalized (pending-head layer; may reorg away). Absent = finalized.
  finalized?: boolean
  blockHeight: number
  timestamp: string
  eventIndex?: number | null
  extrinsicIndex: number | null
  who: AccountRef | null
  to: AccountRef | null
  asset: AssetRef | null
  assetIn: AssetRef | null
  assetOut: AssetRef | null
  amount: string | null
  amountIn: string | null
  amountOut: string | null
  valueUsd: number | null
  destChain?: string
  destParachainId?: number | null
  // Destination account of a cross-chain transfer. `address` is always the
  // Polkadot-format SS58 (one identity per pubkey across chains); emoji fields,
  // tag, and identity are derived server-side exactly like local accounts'.
  destAccount?: {
    // The same canonical id local accountRefs carry — for a bound-EVM
    // AccountKey20 this differs from `raw` (the bare H160), so viewer-side
    // lookups must key on this, not on `raw`/`address`.
    // Optional only for old cached responses/fixtures that predate this field.
    kind: 'AccountId32' | 'AccountKey20'; accountId?: string; address: string; raw: string; subscanUrl: string | null
    emoji?: string; emojiName?: string; emojiUrl?: string
    tag?: TagRef | null
    identity?: { display: string; verified: boolean } | null
  }
  xcmDir?: 'in' | 'out'      // xcm: transfer direction relative to the chain
  fromChain?: string         // xcm inbound: origin chain name
  fromParachainId?: number | null
  votePallet?: string
  voteRefPallet?: 'opengov' | 'democracy' | null
  voteRefTitle?: string | null
  voteAction?: string
  voteRef?: string | null
  voteSide?: string
  voteConviction?: string | null
  liqAction?: 'Add' | 'Remove' | 'Create' | 'Claim' | 'Destroy'   // Create = pool creation; Destroy = pool closure; Claim = LM rewards
  linkBlock?: number | null
  linkIndex?: number | null
}

export interface VoteRow {
  weighted?: string | null
  voteRefPallet?: 'opengov' | 'democracy' | null
  voteRefTitle?: string | null
  blockHeight: number
  timestamp: string
  eventIndex: number
  extrinsicIndex: number | null
  account: AccountRef | null
  pallet: string
  action: string
  referendum: string | null
  side: string
  conviction: string | null
  amount: string | null
  asset: AssetRef
  valueUsd: number | null
}

// One referendum's combined vote across a tag's members (the votes tab's
// grouped mode): each member's latest vote summed as integers. The average
// conviction is derived client-side from weighted/amount (avgConvictionLabel).
export interface VoteGroupRow {
  pallet: string
  referendum: string | null
  voteRefPallet?: 'opengov' | 'democracy' | null
  voteRefTitle?: string | null
  side: string
  voters: number
  weighted: string | null
  amount: string | null
  blockHeight: number
  timestamp: string
  eventIndex: number
  extrinsicIndex: number | null
  asset: AssetRef
  valueUsd: number | null
}
// `complete: false` = the members' vote history ran past the aggregation's scan
// ceiling, so rows cover only the newest part of it.
export interface VotesByReferendumPage { rows: VoteGroupRow[]; total: number; complete: boolean }

export interface AssetDetail {
  asset: AssetListItem
  holderCount: number
  totalUsd: number
  priceSeries: number[]
  priceDates?: string[]
  // Number of pools currently holding this asset (the Liquidity tab badge).
  liquiditySourceCount?: number
}

// liquidity pools (asset Liquidity tab, pool detail)

export type PoolKind = 'xyk'
export interface PoolCompositionEntry { asset: AssetRef; amount: string; usd: number | null; sharePct: number | null }
// Every pool on the chain, largest first (the /liquidity index). A pool is a
// mixture, so each entry carries its own composition and the page draws it.
export interface PoolListEntry {
  kind: PoolKind
  poolId: number | null
  name: string
  tvlUsd: number | null
  sharePct: number | null
  composition: PoolCompositionEntry[]
}
export interface PoolsIndexResponse {
  totalTvlUsd: number | null
  pools: PoolListEntry[]
}

export interface AssetLiquiditySource {
  kind: PoolKind
  poolId: number | null            // share/LP asset id
  name: string
  tvlUsd: number | null
  assetAmount: string              // raw units of the page's asset in this pool
  assetUsd: number | null
  assetSharePct: number | null     // the asset's share of the pool's TVL
  // Full per-asset breakdown for the card grid; compact rows below the card
  // limit arrive with an empty composition (the pool page has the full one).
  composition: PoolCompositionEntry[]
}
export interface FormerLiquiditySource {
  kind: PoolKind
  poolId: number | null
  name: string
  lastActiveBlock: number | null   // null: pool predates sampled pool history
  lastActiveAt: string | null
}
export interface AssetLiquiditySeries { key: string; label: string; amounts: (number | null)[]; usd: (number | null)[] }
export interface AssetLiquidity {
  asset: AssetRef
  totalAmount: string
  totalUsd: number | null
  sources: AssetLiquiditySource[]  // ordered by the asset's value, largest first
  former: FormerLiquiditySource[]
  history: { buckets: string[]; series: AssetLiquiditySeries[] }
}

export interface PoolDetailAsset {
  asset: AssetRef
  amount: string
  usd: number | null
  sharePct: number | null
}
export interface PoolDetail {
  kind: PoolKind
  poolId: number
  name: string
  account: AccountRef
  shareToken: AssetRef
  createdBlock: number | null
  createdAt: string | null
  destroyed: boolean
  tvlUsd: number | null
  totalIssuance: string
  feePermill: number | null
  assets: PoolDetailAsset[]
  history: {
    buckets: string[]
    tvlUsd: (number | null)[]
    composition: { asset: AssetRef; amounts: (number | null)[]; usd: (number | null)[] }[]
  }
}

// An XYK pool's liquidity providers: holders of its share token, largest first,
// with farm-deposited principal attributed to its owners.
export interface PoolLpRow {
  rank: number
  account: AccountRef
  shares: string
  farmedShares: string | null   // included in `shares`
  sharePct: number | null
  valueUsd: number | null
}
export interface PoolLpsResponse {
  poolId: number
  shareToken: AssetRef
  totalShares: string
  tvlUsd: number | null
  total: number
  lps: PoolLpRow[]
}

export interface TagDetail {
  tagId: string
  name: string
  color: string
  note: string
  icon: string
  members: AccountRef[]
  balances: AddressBalance[]
  // Up to 4 largest combined holdings (see AddressDetail.topAssets).
  topAssets: { asset: AssetRef; valueUsd: number }[]
  portfolioUsd: number
  tradingVolumeUsd?: number
  liquidityPositions?: LpPosition[]
  portfolioSeries: number[]
  portfolioDates?: string[]
  balanceHistory: AssetBalanceHistory[]
}

export interface ReferendumVoter {
  account: AccountRef | null
  kind: 'Standard' | 'Split' | 'SplitAbstain'
  side: 'Aye' | 'Nay' | 'Split' | 'SplitAbstain'
  conviction: string | null
  convictionIndex: number | null
  balance: string
  ayeBalance: string
  nayBalance: string
  abstainBalance: string
  weightedAye: string
  weightedNay: string
  weighted: string
  valueUsd: number | null
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  timestamp: string
  removed: boolean
}

export interface ReferendumTally { ayes: string; nays: string; support: string | null }

// The chain's own tally with the provenance that says whether it still holds. `final`
// marks a concluding event's tally — the referendum's last word. A running referendum
// only ever published a Referenda.DecisionStarted snapshot, taken as the decision
// period opened and left behind by every vote since; the live tally sits in chain
// storage, which is not indexed. See selectTally.
export interface OnChainTally extends ReferendumTally {
  final: boolean
  blockHeight: number
  timestamp: string
}

export interface ReferendumDetail {
  pallet: 'opengov' | 'democracy'
  index: number
  title: string | null
  proposer: AccountRef | null
  subsquareUrl: string
  track: number | null
  proposalHash: string | null
  proposalCall: { pallet: string; callName: string; args: unknown; encoded: string | null; byteLength: number; decodeError: string | null } | null
  status: string
  // How the approved call's enactment went (OpenGov only, null until it runs).
  enactment: 'ok' | 'failed' | 'unavailable' | null
  submittedAt: { blockHeight: number; extrinsicIndex: number | null; timestamp: string } | null
  concludedAt: { blockHeight: number; extrinsicIndex: number | null; timestamp: string } | null
  asset: AssetRef
  onChainTally: OnChainTally | null
  directTally: {
    ayes: string; nays: string; rawAyes: string; rawNays: string; support: string
    ayeVoters: number; nayVoters: number; splitVoters: number; voters: number
  }
  indirectTally: ReferendumTally | null
  voters: ReferendumVoter[]
  votesShown: number
  votesTotal: number
  timeline: ReferendumTimelineEntry[]
  trackInfo: ReferendumTrackRef | null
  liveTally: LiveReferendumTally | null
  progress: ReferendumProgress | null
}

export interface ReferendumTimelineEntry {
  event: string
  blockHeight: number
  extrinsicIndex: number | null
  timestamp: string
  // Enactment entries only, and only when the event said which it was. Absent on an
  // enactment whose result could not be read, which reads as neither success nor failure.
  outcome?: 'ok' | 'failed' | 'unavailable'
}

export interface ReferendumTrackRef {
  id: number
  name: string
  // Parachain block counts from the runtime constant; turn into durations with
  // the nominal slot time (blockSeconds), never a hardcoded pace.
  preparePeriod: number
  decisionPeriod: number
  confirmPeriod: number
  minEnactmentPeriod: number
  decisionDeposit: string
}

// The pallet's CURRENT tally from chain storage — the running-referendum figure
// the lifecycle events cannot carry. Conviction-weighted, delegation included.
export interface LiveReferendumTally {
  ayes: string
  nays: string
  support: string
  electorate: string | null
}

export interface ReferendumGauge {
  currentPerbill: number | null
  thresholdPerbill: number
  passing: boolean | null
  source: 'chain' | 'attributed' | null
}

export interface ReferendumProgress {
  phase: 'preparing' | 'deciding' | 'confirming'
  decisionDepositPlaced: boolean
  submittedBlock: number
  decisionStartBlock: number | null
  decisionEndBlock: number | null
  confirmStartBlock: number | null
  confirmEndBlock: number | null
  earliestDecisionBlock: number | null
  timeoutBlock: number | null
  approval: ReferendumGauge | null
  support: ReferendumGauge | null
  // OpenGov's bars decay, so trailing them today is normal: 'on-track' clears
  // them by confirmableAtBlock if the tally holds; 'short' cannot clear them by
  // the period end without new votes.
  projection: { state: 'passing' | 'on-track' | 'short'; confirmableAtBlock: number | null } | null
}

// `/explorer/filter-names` — the pallet.call and pallet.Event names present in the
// indexed data, so a name field can offer them instead of asking to be told one.
// Suggestions only: a name not in the list is still a valid filter and a valid
// alert (the server matches names case-insensitively and partially).
export interface FilterNames { calls: string[]; events: string[] }
// ---- /governance ----

export interface GovernanceTrackRef { id: number; name: string }

export interface GovernanceReferendumRow {
  pallet: 'opengov' | 'democracy'
  index: number
  title: string | null
  status: string
  voters: number | null
  blockHeight: number
  timestamp: string
  track: GovernanceTrackRef | null
  // The submit extrinsic's signer (OpenGov only; Democracy proposals were
  // tabled from a queue and name no single submitter).
  proposer: AccountRef | null
  // How the approved call's enactment went (OpenGov only, null until it runs).
  enactment: 'ok' | 'failed' | 'unavailable' | null
}
export interface GovernanceReferendaPage { total: number; rows: GovernanceReferendumRow[] }

export interface ActiveReferendumCard {
  index: number
  title: string | null
  status: string
  track: GovernanceTrackRef | null
  proposer: AccountRef | null
  submittedAt: { blockHeight: number; extrinsicIndex: number | null; timestamp: string } | null
  progress: ReferendumProgress | null
  tally: { ayes: string; nays: string; support: string | null; source: 'live' | 'snapshot' } | null
}
export interface GovernanceOverview {
  active: ActiveReferendumCard[]
  counts: { opengov: number; democracy: number; tcMotions: number; councilMotions: number; tips: number }
}

export interface CollectiveMotionRow {
  index: number
  hash: string
  proposer: AccountRef | null
  threshold: number
  ayes: number
  nays: number
  call: string | null
  status: 'open' | 'approved' | 'disapproved' | 'executed' | 'failed'
  proposedAt: { blockHeight: number; extrinsicIndex: number | null; timestamp: string }
  closedAt: { blockHeight: number; extrinsicIndex: number | null; timestamp: string } | null
}
export interface CollectiveMotionsPage { total: number; rows: CollectiveMotionRow[] }

export interface TreasuryTipRow {
  hash: string
  reason: string | null
  beneficiary: AccountRef | null
  payout: string | null
  status: 'open' | 'closing' | 'closed' | 'retracted'
  openedAt: { blockHeight: number; extrinsicIndex: number | null; timestamp: string }
  closedAt: { blockHeight: number; extrinsicIndex: number | null; timestamp: string } | null
}
export interface TreasuryTipsPage { total: number; rows: TreasuryTipRow[] }
