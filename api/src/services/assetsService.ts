import type { ClickHouseClient } from '../db/client.ts'
import type { Asset } from '../types.ts'

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

// Stablecoin symbols — all variants of these symbols are treated as stablecoins.
const STABLECOIN_SYMBOLS = new Set(['USDT', 'USDC', 'USDCet', 'DAI', 'aUSD', 'kUSD'])
// Being a stablecoin is not the same as being worth a dollar. Only these can stand
// in for USD when a pair is denominated, since indexed prices are USD — anything
// pegged to another unit has to be computed as a ratio of the two.
//
// An interest-BEARING stable belongs in the set above and NOT here: it is a
// stablecoin, but its price leaves par and keeps going, so publishing the base
// asset's raw USD price for a pair quoted in it understates the rate by exactly the
// accrued interest, and the error worsens daily. Such a quote takes the cross path,
// where the quote's own price divides the base's — a real market rate, since it
// trades against everything it quotes.
const USD_PEGGED_SYMBOLS = new Set(['USDT', 'USDC', 'USDCet', 'DAI', 'aUSD', 'kUSD'])

const assetCache = new Map<number, Asset>()
let refreshTimer: ReturnType<typeof setInterval> | null = null
let loadInflight: Promise<void> | null = null

// The asset directory is the on-chain registry, whole. It is metadata — symbol,
// name, decimals, peg class, XCM origin — keyed by asset id, and every id that can
// appear in a balance, transfer or trade has to resolve through it.
//
// It is deliberately NOT filtered by pricing or by trading activity. Snekwork
// publishes USD prices for exactly two assets (BSX and KSM — see REMOVED.md), so a
// directory sourced from the priced/traded set would collapse to those two and
// every other asset would lose its symbol and decimals. Price lives in the price
// map, not here; an unpriced asset is a registry row like any other.
async function loadAssetsUncached(client: ClickHouseClient): Promise<void> {
  const result = await client.query({
    query: `
      SELECT asset_id, symbol, name, decimals, parachain_id, origin_ecosystem, origin_chain_id, origin_asset_id
      FROM price_data.assets FINAL
    `,
    format: 'JSONEachRow',
  })
  const rows = await result.json<AssetRow>()

  assetCache.clear()
  for (const row of rows) {
    assetCache.set(row.asset_id, {
      assetId: row.asset_id,
      symbol: row.symbol,
      name: row.name === row.symbol ? null : row.name,
      decimals: row.decimals,
      isStablecoin: STABLECOIN_SYMBOLS.has(row.symbol),
      isUsdPegged: USD_PEGGED_SYMBOLS.has(row.symbol),
      parachainId: row.parachain_id ?? null,
      origin: row.origin_ecosystem && row.origin_chain_id
        ? { ecosystem: row.origin_ecosystem, chainId: row.origin_chain_id, assetId: row.origin_asset_id ?? null }
        : null,
    })
  }
  console.log(`[Assets] Loaded ${assetCache.size} assets into cache`)

  if (!refreshTimer) {
    refreshTimer = setInterval(() => {
      loadAssets(client).catch(err =>
        console.error('[Assets] Cache refresh failed:', err)
      )
    }, 60_000)
    refreshTimer.unref()
  }
}

export function loadAssets(client: ClickHouseClient): Promise<void> {
  if (loadInflight) return loadInflight
  const request = loadAssetsUncached(client).finally(() => {
    if (loadInflight === request) loadInflight = null
  })
  loadInflight = request
  return request
}

export function stopAssetsRefresh(): void {
  if (!refreshTimer) return
  clearInterval(refreshTimer)
  refreshTimer = null
}

export function getAssetById(assetId: number): Asset | undefined {
  return assetCache.get(assetId)
}

export function getAllAssets(): Asset[] {
  return Array.from(assetCache.values())
}
