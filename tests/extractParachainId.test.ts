import { describe, it, expect } from 'vitest'
import { extractAssetOrigin, extractParachainId, isPlaceholderAssetMetadata } from '../src/registry/tracker'

describe('extractParachainId', () => {
  it('returns null for null/undefined location', () => {
    expect(extractParachainId(null)).toBeNull()
    expect(extractParachainId(undefined)).toBeNull()
  })

  it('returns null for native Basilisk assets (parents: 0)', () => {
    expect(extractParachainId({ parents: 0, interior: { __kind: 'Here' } })).toBeNull()
  })

  it('returns null for native parachain token — X1(Parachain(id)) only', () => {
    const location = {
      parents: 1,
      interior: {
        __kind: 'X1',
        value: { __kind: 'Parachain', value: 1000 }
      }
    }
    expect(extractParachainId(location)).toBeNull()
  })

  it('returns null for native parachain token — X1 array format (V5)', () => {
    const location = {
      parents: 1,
      interior: {
        __kind: 'X1',
        value: [{ __kind: 'Parachain', value: 2004 }]
      }
    }
    expect(extractParachainId(location)).toBeNull()
  })

  it('extracts parachainId from X2(Parachain(id), GeneralKey(...))', () => {
    const location = {
      parents: 1,
      interior: {
        __kind: 'X2',
        value: [
          { __kind: 'Parachain', value: 1000 },
          { __kind: 'GeneralKey', value: { length: 2, data: '0x0001' } }
        ]
      }
    }
    expect(extractParachainId(location)).toBe(1000)
  })

  it('returns null when interior is Here', () => {
    expect(extractParachainId({ parents: 1, interior: { __kind: 'Here' } })).toBeNull()
  })

  // XCM V0 — the genesis shape, specs 16..18 — has no `parents` field at all: the
  // location IS the junction enum and "one level up" is a leading `Parent`
  // junction. Basilisk registered no location while V0 was live (AssetLocations is
  // still empty at block 1,000,000), so these have no historic rows behind them;
  // they exist so a genesis-era read resolves an origin instead of returning null
  // for every shape, which is what a bare `parents !== 1` check did.
  it('extracts parachainId from a V0 X3(Parent, Parachain(id), GeneralKey)', () => {
    expect(extractParachainId({
      __kind: 'X3',
      value: [
        { __kind: 'Parent' },
        { __kind: 'Parachain', value: 2000 },
        { __kind: 'GeneralKey', value: '0x0001' },
      ],
    })).toBe(2000)
  })

  it('returns null for a V0 native parachain token — X2(Parent, Parachain(id))', () => {
    expect(extractParachainId({
      __kind: 'X2',
      value: [{ __kind: 'Parent' }, { __kind: 'Parachain', value: 2000 }],
    })).toBeNull()
  })

  it('returns null for a V0 location that never goes up — X2(Parachain(id), GeneralKey)', () => {
    expect(extractParachainId({
      __kind: 'X2',
      value: [{ __kind: 'Parachain', value: 2000 }, { __kind: 'GeneralKey', value: '0x0001' }],
    })).toBeNull()
  })

  it('returns null for a V0 relay-level location — X2(Parent, Parent, ...)', () => {
    expect(extractParachainId({
      __kind: 'X3',
      value: [
        { __kind: 'Parent' },
        { __kind: 'Parent' },
        { __kind: 'Parachain', value: 2000 },
      ],
    })).toBeNull()
  })

  it('returns null for the V0 Here location', () => {
    expect(extractParachainId({ __kind: 'Here' })).toBeNull()
  })

  it('returns null when no Parachain junction exists', () => {
    const location = {
      parents: 1,
      interior: {
        __kind: 'X1',
        value: [{ __kind: 'AccountKey20', value: '0xabc' }]
      }
    }
    expect(extractParachainId(location)).toBeNull()
  })
})

describe('extractAssetOrigin', () => {
  it('extracts an Ethereum chain and canonical ERC-20 contract', () => {
    expect(extractAssetOrigin({
      parents: 2,
      interior: {
        __kind: 'X2',
        value: [
          { __kind: 'GlobalConsensus', value: { __kind: 'Ethereum', value: { chainId: 1n } } },
          { __kind: 'AccountKey20', key: '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
        ],
      },
    })).toEqual({
      ecosystem: 'ethereum',
      chainId: '1',
      assetId: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    })
  })

  it('extracts a Polkadot parachain origin and GeneralIndex', () => {
    expect(extractAssetOrigin({
      parents: 1,
      interior: {
        __kind: 'X2',
        value: [
          { __kind: 'Parachain', value: 1000 },
          { __kind: 'GeneralIndex', value: 1337n },
        ],
      },
    })).toEqual({ ecosystem: 'polkadot', chainId: '1000', assetId: '1337' })
  })

  it('reads a V0 origin through its leading Parent junction', () => {
    expect(extractAssetOrigin({
      __kind: 'X3',
      value: [
        { __kind: 'Parent' },
        { __kind: 'Parachain', value: 1000 },
        { __kind: 'GeneralIndex', value: 1337n },
      ],
    })).toEqual({ ecosystem: 'polkadot', chainId: '1000', assetId: '1337' })
  })

  it('trims a GeneralKey to its declared length instead of its zero padding', () => {
    expect(extractAssetOrigin({
      parents: 1,
      interior: {
        __kind: 'X2',
        value: [
          { __kind: 'Parachain', value: 2030 },
          { __kind: 'GeneralKey', length: 2, data: `0x0900${'00'.repeat(30)}` },
        ],
      },
    })).toEqual({ ecosystem: 'polkadot', chainId: '2030', assetId: '0x0900' })
  })
})

describe('isPlaceholderAssetMetadata', () => {
  it('identifies generated external placeholder metadata', () => {
    expect(isPlaceholderAssetMetadata({
      assetId: 1000085,
      symbol: 'Asset1000085',
      name: 'Asset 1000085',
      assetType: 'External',
    })).toBe(true)
  })

  it('identifies generated placeholder metadata without an asset type', () => {
    expect(isPlaceholderAssetMetadata({
      assetId: 1000085,
      symbol: 'Asset1000085',
      name: 'Asset 1000085',
    })).toBe(true)
  })

  it('keeps resolved metadata even for external assets', () => {
    expect(isPlaceholderAssetMetadata({
      assetId: 1000085,
      symbol: 'WUD',
      name: 'Gavun Wud',
      assetType: 'External',
    })).toBe(false)
  })
})
