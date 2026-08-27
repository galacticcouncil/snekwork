import { Buffer } from 'node:buffer'
import { u8aToHex } from '@polkadot/util'
import { decodeAddress } from '@polkadot/util-crypto'
import { toHex } from './json.js'

const H160_HEX_LENGTH = 42
const ACCOUNT_ID_HEX_LENGTH = 66
const ETH_PREFIX_HEX = '45544800'
const EVM_ACCOUNT_SUFFIX_HEX = '0000000000000000'

function isPlainBytesArray(value: unknown): value is number[] {
  return Array.isArray(value) &&
    value.every(item => Number.isInteger(item) && item >= 0 && item <= 255)
}

function normalizeHexLike(value: string): string | null {
  const prefixed = value.startsWith('0x') ? value : `0x${value}`
  if (!/^0x[0-9a-fA-F]+$/.test(prefixed)) return null
  if (prefixed.length % 2 !== 0) return null
  return prefixed.toLowerCase()
}

export function normalizeH160(value: unknown): string | null {
  const hex = extractHexLike(value)
  if (hex == null || hex.length !== H160_HEX_LENGTH) return null
  return hex
}

export function normalizeAccountId(value: unknown): string | null {
  const hex = extractHexLike(value)
  if (hex != null && hex.length === ACCOUNT_ID_HEX_LENGTH) return hex

  if (typeof value === 'string' && !value.startsWith('0x')) {
    try {
      const decoded = u8aToHex(decodeAddress(value)).toLowerCase()
      return decoded.length === ACCOUNT_ID_HEX_LENGTH ? decoded : null
    } catch {
      return null
    }
  }

  return null
}

export function extractHexLike(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'string') return normalizeHexLike(value)
  if (value instanceof Uint8Array || Buffer.isBuffer(value) || isPlainBytesArray(value)) {
    return toHex(value).toLowerCase()
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['id', 'value', 'address', 'account', 'key', 'AccountId32', 'AccountKey20']) {
      if (record[key] != null) {
        const nested = extractHexLike(record[key])
        if (nested != null) return nested
      }
    }
  }
  return null
}

// An AccountKey20 junction carries a 20-byte address, which XCM traffic to and
// from EVM chains uses for origins and beneficiaries. It is widened to the
// 32-byte account form the rest of the pipeline keys on: `ETH\0` + the 20 bytes
// + zero padding.
export function deriveTruncatedAccountId(evmAddress: string): string {
  const h160 = normalizeH160(evmAddress)
  if (h160 == null) {
    throw new Error(`Cannot derive truncated AccountId32 from invalid H160: ${evmAddress}`)
  }
  return `0x${ETH_PREFIX_HEX}${h160.slice(2)}${EVM_ACCOUNT_SUFFIX_HEX}`.toLowerCase()
}
