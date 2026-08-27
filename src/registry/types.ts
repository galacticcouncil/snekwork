export interface AssetMetadata {
  assetId: number
  symbol: string
  name: string
  decimals: number
  assetType?: string  // 'Token', 'PoolShare', etc.
  parachainId?: number  // XCM origin parachain ID, undefined for local assets
  originEcosystem?: string // metadata CDN ecosystem, e.g. polkadot or ethereum
  originChainId?: string   // parachain id or EVM chain id
  originAssetId?: string   // origin-chain asset key (EVM contract, GeneralIndex, …)
}
