import { describe, expect, it } from 'vitest'
import {
  accountIcon,
  accountIdHex,
  basiliskAddress,
  kusamaAddress,
  parseSuffixEmojiQuery,
  shortAccount,
} from '../src/services/omniwatchIdentity.ts'

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

// Decode base58 back to bytes so a test can inspect the network-prefix bytes the
// encoder emitted, independently of the module's own decode path.
function base58Bytes(value: string): number[] {
  let n = 0n
  for (const ch of value) n = n * 58n + BigInt(BASE58_ALPHABET.indexOf(ch))
  const out: number[] = []
  while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n }
  let zeros = 0
  while (zeros < value.length && value[zeros] === '1') zeros++
  return [...new Array(zeros).fill(0), ...out]
}

// The two-byte SS58 header, read back: the 14-bit network prefix is split across
// both bytes, with 0b01 in the top bits of the first marking the form.
function decodeTwoByteSs58Prefix(b0: number, b1: number): number {
  return ((b0 & 0x3f) << 2) | (b1 >> 6) | ((b1 & 0x3f) << 8)
}

describe('SS58 encoding — Basilisk (prefix 10041) and Kusama (prefix 2)', () => {
  // Pinned against @polkadot/util-crypto's encodeAddress(id, 10041 | 2).
  const VECTORS = [
    {
      accountId: '0x0000000000000000000000000000000000000000000000000000000000000000',
      basilisk: 'bXgbR3K8BpV7Dn9imvyriviptpwAsaQyq1W6GLa77FJVqdyja',
      kusama: 'CaKWz5omakTK7ovp4m3koXrHyHb7NG3Nt7GENHbviByZpKp',
    },
    {
      // modl py/trsry — the treasury pallet account.
      accountId: '0x6d6f646c70792f74727372790000000000000000000000000000000000000000',
      basilisk: 'bXj4uMHTyQyvNCLHKBv6ztwkPSx8tgsrxuFtAFfWDYntXtohw',
      kusama: 'F3opxRbN5ZbjJNU511Kj2TLuzFcDq9BGduA9TgiECafpg29',
    },
    {
      accountId: '0xbcf96ceba85fb928b544872bec7e62d3490a439a16b7879578708bb711791f0e',
      basilisk: 'bXksC8wzTBDeR8dCjPXBBMh6bXUNaHKiaVrrowUGvVeZ4zvvu',
      kusama: 'Gr6ccx58KHefbHtGc5WBmoYzWVHpGznsEsoqGTRB4FCvik8',
    },
  ]

  it('encodes 32-byte account ids at both network prefixes', () => {
    for (const v of VECTORS) {
      expect(basiliskAddress(v.accountId)).toBe(v.basilisk)
      expect(kusamaAddress(v.accountId)).toBe(v.kusama)
    }
  })

  it('emits the two-byte header for Basilisk and a single byte for Kusama', () => {
    for (const v of VECTORS) {
      const b = base58Bytes(v.basilisk)
      // two prefix bytes + 32-byte public key + 2-byte checksum
      expect(b).toHaveLength(36)
      expect(b[0] & 0xc0).toBe(0x40)
      expect(decodeTwoByteSs58Prefix(b[0], b[1])).toBe(10041)

      const k = base58Bytes(v.kusama)
      expect(k).toHaveLength(35)
      expect(k[0]).toBe(2)
    }
  })

  it('round-trips through the decode path at both prefixes', () => {
    for (const v of VECTORS) {
      expect(accountIdHex(v.basilisk)).toBe(v.accountId)
      expect(accountIdHex(v.kusama)).toBe(v.accountId)
      // Re-encoding a decoded address is stable.
      expect(basiliskAddress(v.basilisk)).toBe(v.basilisk)
      expect(basiliskAddress(v.kusama)).toBe(v.basilisk)
      expect(kusamaAddress(v.basilisk)).toBe(v.kusama)
    }
  })

  it('rejects a corrupted checksum rather than decoding it', () => {
    const bad = VECTORS[2].basilisk.slice(0, -1) + (VECTORS[2].basilisk.endsWith('u') ? 'v' : 'u')
    expect(accountIdHex(bad)).toBeNull()
  })
})

describe('omniwatch identity helpers', () => {
  it('uses the SS58 address for short labels', () => {
    expect(shortAccount('bXksC8wzTBDeR8dCjPXBBMh6bXUNaHKiaVrrowUGvVeZ4zvvu')).toBe('vvu')
  })

  it('derives every account emoji deterministically from the public key', () => {
    expect(accountIcon('16VM29LrX9SFma5e3aTVTdTPvnbEQjEp8xBXUVC73J8xpDAe')).toEqual({ emoji: '🐮' })
    // Same account, any SS58 prefix — the glyph is keyed by the public key.
    const id = '0xbcf96ceba85fb928b544872bec7e62d3490a439a16b7879578708bb711791f0e'
    expect(accountIcon(basiliskAddress(id))).toEqual(accountIcon(id))
    expect(accountIcon(kusamaAddress(id))).toEqual(accountIcon(id))
    // No curated overrides remain: nothing carries a custom name or image icon.
    expect(accountIcon(id).emojiName).toBeUndefined()
    expect(accountIcon(id).emojiUrl).toBeUndefined()
  })
})

describe('parseSuffixEmojiQuery — combined "3-letter code + emoji name" queries', () => {
  it('parses "pmo pig" as suffix pmo + the pig glyphs', () => {
    const combos = parseSuffixEmojiQuery('pmo pig')
    expect(combos).toHaveLength(1)
    expect(combos[0].suffix).toBe('pmo')
    expect(combos[0].glyphs).toContain('🐷')
    expect(combos[0].glyphs).toContain('🐽')
  })

  it('accepts either token order', () => {
    const combos = parseSuffixEmojiQuery('pig pmo')
    expect(combos).toHaveLength(1)
    expect(combos[0].suffix).toBe('pmo')
    expect(combos[0].glyphs).toContain('🐷')
  })

  it('keeps both readings when both tokens are emoji names', () => {
    const combos = parseSuffixEmojiQuery('cat dog')
    expect(combos.map(c => c.suffix).sort()).toEqual(['cat', 'dog'])
  })

  it('rejects single tokens, 3+ tokens, and non-matching pairs', () => {
    expect(parseSuffixEmojiQuery('pig')).toEqual([])
    expect(parseSuffixEmojiQuery('a b c')).toEqual([])
    expect(parseSuffixEmojiQuery('x7K zzzzz')).toEqual([])
    expect(parseSuffixEmojiQuery('toolongcode pig')).toEqual([])
  })
})
