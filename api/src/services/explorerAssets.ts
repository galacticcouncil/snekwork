import type { ClickHouseClient } from '../db/client.ts'

// Full asset registry, independent of the trading-filtered cache in
// assetsService.ts. The Explorer must resolve symbol/decimals for every asset_id
// that can appear in balances/transfers, including the XYK share tokens and
// unnamed foreign assets the price UI hides.
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

// The XYK share (LP) tokens, by asset id. price_data.assets carries no asset-type
// column, so PoolShare membership is not readable from the registry rows — but every
// share token is named by its own XYK.PoolCreated event, which the xyk_pool_registry
// MV keeps. Nor is it identifiable by symbol: Basilisk share tokens are registered
// unnamed (`Asset<id>`), with no marker in the name for a match to key on. Held in
// memory beside the registry and refreshed on the same timer, so the classifiers
// that ask "is this a share token" can stay synchronous.
const xykShareTokenIds = new Set<number>()

async function loadExplorerAssetsUncached(client: ClickHouseClient): Promise<void> {
  const res = await client.query({
    query: `SELECT asset_id, symbol, name, decimals, parachain_id, origin_ecosystem, origin_chain_id, origin_asset_id FROM price_data.assets FINAL`,
    format: 'JSONEachRow',
  })
  const rows = await res.json<AssetRow>()
  cache.clear()
  for (const r of rows) {
    cache.set(r.asset_id, {
      assetId: r.asset_id,
      iconAssetId: r.asset_id,
      symbol: r.symbol,
      name: r.name === r.symbol ? null : r.name,
      decimals: r.decimals,
      parachainId: r.parachain_id ?? null,
      origin: r.origin_ecosystem && r.origin_chain_id
        ? { ecosystem: r.origin_ecosystem, chainId: r.origin_chain_id, assetId: r.origin_asset_id ?? null }
        : null,
    })
  }
  await loadXykShareTokens(client)
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

// The XYK share tokens, from the pool registry the XYK.PoolCreated MV maintains.
// Best-effort: a failed lookup leaves the previous set in place rather than
// declaring every share token an ordinary asset for the next five minutes.
async function loadXykShareTokens(client: ClickHouseClient): Promise<void> {
  let rows: { lp_asset_id: number }[]
  try {
    const res = await client.query({
      query: `SELECT DISTINCT lp_asset_id FROM price_data.xyk_pool_registry FINAL WHERE lp_asset_id > 0`,
      format: 'JSONEachRow',
    })
    rows = await res.json<{ lp_asset_id: number }>()
  } catch (err) {
    console.error('[ExplorerAssets] xyk share token load failed:', err instanceof Error ? err.message : err)
    return
  }
  xykShareTokenIds.clear()
  for (const r of rows) if (Number.isInteger(Number(r.lp_asset_id))) xykShareTokenIds.add(Number(r.lp_asset_id))
}

// Is this asset a pool's LP share token? A share token is pool mechanics, not a
// tradeable asset: it is kept off the asset list, and a trade leg into or out of one
// inside an add/remove is routing rather than a trade of the user's own.
export function isXykShareToken(assetId: number): boolean {
  return xykShareTokenIds.has(assetId)
}

// NOTE: there is deliberately no price/display alias table here. Basilisk has no
// receipt or wrapper token that borrows another asset's feed — its only derived
// asset is the XYK share token, and an LP share is a claim on TWO reserves, so no
// single asset's price stands in for it (LP value comes from pool NAV, in
// poolService). Every asset therefore prices and displays as itself, and callers
// use the asset id directly.
