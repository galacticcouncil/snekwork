import type { ClickHouseClient } from '../db/client.ts'

// Full asset registry (all 113 assets), independent of the trading-filtered
// cache in assetsService.ts. The Explorer must resolve symbol/decimals for every
// asset_id that can appear in balances/transfers, including foreign and aToken
// assets that the price UI hides.
interface AssetOrigin {
  ecosystem: string
  chainId: string
  assetId: string | null
}

export interface ExplorerAsset {
  assetId: number
  iconAssetId: number
  symbol: string
  name: string | null
  decimals: number
  parachainId: number | null
  origin: AssetOrigin | null
}

interface AssetRow {
  asset_id: number
  symbol: string
  name: string
  decimals: number
  parachain_id: number | null
  origin_ecosystem: string | null
  origin_chain_id: string | null
  origin_asset_id: string | null
}

const cache = new Map<number, ExplorerAsset>()
let refreshTimer: ReturnType<typeof setInterval> | null = null
let loadInflight: Promise<void> | null = null
const H2O_ASSET_ID = 1

async function loadExplorerAssetsUncached(client: ClickHouseClient): Promise<void> {
  const res = await client.query({
    query: `SELECT asset_id, symbol, name, decimals, parachain_id, origin_ecosystem, origin_chain_id, origin_asset_id FROM price_data.assets FINAL`,
    format: 'JSONEachRow',
  })
  const rows = await res.json<AssetRow>()
  cache.clear()
  for (const r of rows) {
    const symbol = r.asset_id === H2O_ASSET_ID ? 'H2O' : r.symbol
    const name = NAME_OVERRIDES[r.asset_id] ?? (r.asset_id === H2O_ASSET_ID ? 'H2O' : r.name)
    cache.set(r.asset_id, {
      assetId: r.asset_id,
      iconAssetId: r.asset_id,
      symbol,
      name: name === symbol ? null : name,
      decimals: r.decimals,
      parachainId: r.parachain_id ?? null,
      origin: r.origin_ecosystem && r.origin_chain_id
        ? { ecosystem: r.origin_ecosystem, chainId: r.origin_chain_id, assetId: r.origin_asset_id ?? null }
        : null,
    })
  }
  await injectBonds(client)
  if (!refreshTimer) {
    refreshTimer = setInterval(() => {
      loadExplorerAssets(client).catch(err => console.error('[ExplorerAssets] refresh failed:', err))
    }, 300_000)
    refreshTimer.unref()
  }
}

export function loadExplorerAssets(client: ClickHouseClient): Promise<void> {
  if (loadInflight) return loadInflight
  const request = loadExplorerAssetsUncached(client).finally(() => {
    if (loadInflight === request) loadInflight = null
  })
  loadInflight = request
  return request
}

export function stopExplorerAssetsRefresh(): void {
  if (!refreshTimer) return
  clearInterval(refreshTimer)
  refreshTimer = null
}

export function allExplorerAssets(): ExplorerAsset[] {
  return [...cache.values()]
}

// Resolve an asset id to a lightweight descriptor, falling back to a synthetic
// entry for ids not in the registry so the UI always has a symbol + decimals.
export function assetDescriptor(assetId: number): ExplorerAsset {
  return cache.get(assetId) ?? {
    assetId,
    iconAssetId: assetId,
    symbol: `#${assetId}`,
    name: null,
    decimals: 12,
    parachainId: null,
    origin: null,
  }
}

// Curated display names for registry entries whose on-chain name is empty or
// unhelpful. Applied at registry load; extend as new unnamed assets surface.
export const NAME_OVERRIDES: Record<number, string> = {}

// Bond tokens (Bonds pallet) aren't published to the asset registry the way ordinary
// assets are, so they otherwise reach the explorer as a bare `#id` with no name,
// icon or price. Each bond maps 1:1 to an underlying asset + a maturity via
// Bonds.TokenCreated, so we synthesise a registry entry that borrows the underlying's
// icon / decimals / origin and prices through it (a bond redeems 1:1 for the
// underlying at maturity). Runs on every registry refresh, so new bonds appear
// automatically. Best-effort: a failed lookup leaves bonds as bare ids, never the
// rest of the registry.
async function injectBonds(client: ClickHouseClient): Promise<void> {
  let rows: { bond_id: number; underlying: number; maturity: string }[]
  try {
    const res = await client.query({
      query: `SELECT JSONExtractInt(args_json,'bondId') AS bond_id,
                     JSONExtractInt(args_json,'assetId') AS underlying,
                     toString(JSONExtractUInt(args_json,'maturity')) AS maturity
              FROM price_data.raw_events
              WHERE event_name = 'Bonds.TokenCreated'`,
      format: 'JSONEachRow',
    })
    rows = await res.json<{ bond_id: number; underlying: number; maturity: string }>()
  } catch (err) {
    console.error('[ExplorerAssets] bond registry load failed:', err instanceof Error ? err.message : err)
    return
  }
  for (const r of rows) {
    const bondId = Number(r.bond_id)
    if (!Number.isInteger(bondId) || bondId <= 0) continue
    const base = cache.get(Number(r.underlying)) ?? assetDescriptor(Number(r.underlying))
    const maturityMs = Number(r.maturity)
    const matures = Number.isFinite(maturityMs) && maturityMs > 0 ? new Date(maturityMs).toISOString().slice(0, 10) : null
    cache.set(bondId, {
      assetId: bondId,
      iconAssetId: base.iconAssetId,
      symbol: `${base.symbol}b`,
      name: `${base.name ?? base.symbol} Bond${matures ? ` · matures ${matures}` : ''}`,
      decimals: base.decimals,
      parachainId: base.parachainId,
      origin: base.origin,
    })
    // Price/value through the underlying (feeds priceAssetId + the SQL alias).
    PRICE_ALIAS_ID[bondId] = Number(r.underlying)
  }
}

// Stableswap/pool SHARE tokens (2-Pool-GDOT, 2-Pool-HUSDC, …) carry no price feed
// of their own, so they inherit their main underlying's display price. Per-share value
// is approximately the underlying value for these near-peg two-asset pools; this is a
// unit-price proxy, not exact NAV.
export const SHARE_TOKEN_UNDERLYING_ID: Record<number, number> = {
  104: 34,     // 2-Pool-WETH   → ETH
  110: 1110,   // 2-Pool-HUSDC  → HUSDC
  111: 1111,   // 2-Pool-HUSDT  → HUSDT
  112: 1112,   // 2-Pool-HUSDS  → HUSDS
  113: 1113,   // 2-Pool-HUSDe  → HUSDe
  143: 43,     // 2-Pool-PRIME  → PRIME
  146: 46,     // 2-Pool-apyUSD → apyUSD
  690: 69,     // 2-Pool-GDOT   → GDOT
  4200: 420,   // 2-Pool-GETH   → GETH
  10044: 4444, // 2-Pool-HEURC  → HEURC
  90001: 9001, // 2-Pool-GSOL   → GSOL
}
// Duplicate/wrapped registry entries whose economic price should follow the
// canonical listed asset. They keep their own balances/holders; only price and
// price history are aliased.
const DUPLICATE_PRICE_ALIAS_ID: Record<number, number> = {}
// Every asset that should be priced via another asset (pool shares, bonds).
export const PRICE_ALIAS_ID: Record<number, number> = { ...SHARE_TOKEN_UNDERLYING_ID, ...DUPLICATE_PRICE_ALIAS_ID }

// The asset id whose price/value should be used for `assetId`: itself, unless it
// is a pool-share token, in which case its priced underlying.
export function priceAssetId(assetId: number): number {
  // Aliases can chain, so resolve transitively with a small bound so a
  // (mis)configured cycle can't loop forever.
  let id = assetId
  for (let hop = 0; hop < 4; hop++) {
    const next = PRICE_ALIAS_ID[id]
    if (next == null || next === id) return id
    id = next
  }
  return id
}

// The asset id under which `assetId` should be DISPLAYED in per-account holdings:
// a held pool-share token is shown as its underlying main asset, mirroring the
// wallet UIs that hide "-Pool" tokens. Aggregate holder/supply views may fold
// these only when the hidden share id is removed from presentation, never added
// alongside it; otherwise the pool would be double-counted.
export function displayAssetId(assetId: number): number {
  return SHARE_TOKEN_UNDERLYING_ID[assetId] ?? assetId
}

// Reverse of SHARE_TOKEN_UNDERLYING_ID: main asset id → the pool-share token ids
// that display as it. The share token can be what a protocol actually holds while
// the page a reader visits is the main asset — the money market's GDOT reserve is
// 2-Pool-GDOT (690), not GDOT (69) — so a reserve lookup has to be able to reach the
// share token from the main id. A list, since nothing stops two pools folding into
// one main asset. Decimals are NOT shared across the pair (2-Pool-PRIME carries 18
// where PRIME carries 6), so callers must read each id's own descriptor.
export const UNDERLYING_TO_SHARE_IDS: Record<number, number[]> = (() => {
  const out: Record<number, number[]> = {}
  for (const [share, underlying] of Object.entries(SHARE_TOKEN_UNDERLYING_ID)) {
    (out[underlying] ??= []).push(Number(share))
  }
  return out
})()
