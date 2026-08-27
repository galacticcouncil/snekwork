import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAllAssets, getAssetById, loadAssets, stopAssetsRefresh } from '../src/services/assetsService.ts'

// Snekwork prices exactly two assets (BSX and KSM). The directory must therefore be
// sourced from the registry projection and NOT from the priced/traded set, or every
// other asset would lose its symbol/name/decimals across the whole UI.
const registryRows = [
  { asset_id: 0, symbol: 'BSX', name: 'Basilisk', decimals: 12, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 1, symbol: 'KSM', name: 'Kusama', decimals: 12, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  // Registered, never priced — the case the old ohlc_1h-scoped query dropped.
  { asset_id: 2, symbol: 'aUSD', name: 'Acala Dollar', decimals: 12, parachain_id: 2000, origin_ecosystem: 'polkadot', origin_chain_id: '2000', origin_asset_id: '0' },
  { asset_id: 5, symbol: 'USDT', name: 'USDT', decimals: 6, parachain_id: 1000, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  // Unnamed foreign asset and an XYK share token: still registry rows, still need decimals.
  { asset_id: 12, symbol: 'Asset12', name: 'Asset12', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
]

function stubClient() {
  const seen: { query: string }[] = []
  const query = vi.fn(async (args: { query: string }) => { seen.push(args); return { json: async () => registryRows } })
  return { client: { query } as never, seen }
}

describe('asset directory source', () => {
  afterEach(() => {
    stopAssetsRefresh()
    vi.restoreAllMocks()
  })

  it('reads the registry projection with no pricing or trading restriction', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { client, seen } = stubClient()
    await loadAssets(client)

    const sql = seen[0].query
    expect(sql).toContain('price_data.assets FINAL')
    // The directory must not be scoped by any price/volume relation.
    expect(sql).not.toContain('ohlc_1h')
    expect(sql).not.toContain('price_data.prices')
    expect(sql).not.toContain('native_volume')
  })

  it('carries every registered asset, priced or not', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { client } = stubClient()
    await loadAssets(client)

    expect(getAllAssets().map(a => a.assetId).sort((x, y) => x - y)).toEqual([0, 1, 2, 5, 12])
    const ausd = getAssetById(2)
    expect(ausd).toMatchObject({ symbol: 'aUSD', name: 'Acala Dollar', decimals: 12, parachainId: 2000 })
    expect(ausd?.origin).toEqual({ ecosystem: 'polkadot', chainId: '2000', assetId: '0' })
    // An unnamed foreign asset still resolves its decimals.
    expect(getAssetById(12)).toMatchObject({ symbol: 'Asset12', name: null, decimals: 18 })
  })

  it('keeps the peg classification the response shape promises', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { client } = stubClient()
    await loadAssets(client)

    expect(getAssetById(5)).toMatchObject({ isStablecoin: true, isUsdPegged: true })
    expect(getAssetById(0)).toMatchObject({ isStablecoin: false, isUsdPegged: false })
    // No price fields are published here — price lives in the price map.
    expect(Object.keys(getAssetById(0) ?? {})).not.toContain('price')
  })
})
