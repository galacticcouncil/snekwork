/**
 * Asset metadata from price_data.assets table.
 */
export interface Asset {
  assetId: number
  symbol: string
  name: string | null  // null when name matches symbol
  decimals: number
  isStablecoin: boolean
  // Whether the asset stands in for USD when it quotes a pair. EURC/HEURC are
  // stablecoins but not dollar-pegged, so they need a computed ratio.
  isUsdPegged: boolean
  parachainId: number | null  // XCM origin parachain ID, null for native assets
  origin?: { ecosystem: string; chainId: string; assetId: string | null } | null
}
