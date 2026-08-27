import { describe, it, expect } from 'vitest'
import { derivePalletAccount, deriveSubAccount } from '../../src/util/account.ts'
import { u8aToHex } from '@polkadot/util'

describe('derivePalletAccount', () => {
  it('returns a 32-byte Uint8Array', () => {
    const account = derivePalletAccount('py/trsry')
    expect(account).toBeInstanceOf(Uint8Array)
    expect(account.length).toBe(32)
  })

  it('produces different accounts for different pallet IDs', () => {
    expect(u8aToHex(derivePalletAccount('py/trsry'))).not.toBe(u8aToHex(derivePalletAccount('py/phrgn')))
  })

  it('is deterministic - same input produces same output', () => {
    expect(u8aToHex(derivePalletAccount('py/trsry'))).toBe(u8aToHex(derivePalletAccount('py/trsry')))
  })

  it('throws error if pallet ID is not exactly 8 bytes', () => {
    expect(() => derivePalletAccount('short')).toThrow('must be exactly 8 bytes')
    expect(() => derivePalletAccount('toolongpalletid')).toThrow('must be exactly 8 bytes')
  })

  it('produces the raw preimage structure (no hashing)', () => {
    // "modl" (4 bytes) + "py/trsry" (8 bytes) + 20 zero bytes
    expect(u8aToHex(derivePalletAccount('py/trsry')))
      .toBe('0x6d6f646c70792f74727372790000000000000000000000000000000000000000')
  })
})

describe('deriveSubAccount', () => {
  it('returns a 32-byte Uint8Array', () => {
    const subAccount = deriveSubAccount(new Uint8Array(32), 100)
    expect(subAccount).toBeInstanceOf(Uint8Array)
    expect(subAccount.length).toBe(32)
  })

  it('produces distinct accounts for distinct indexes', () => {
    const base = derivePalletAccount('py/trsry')
    const hexes = [0, 100, 101].map(index => u8aToHex(deriveSubAccount(base, index)))
    expect(new Set(hexes).size).toBe(3)
  })

  it('is deterministic - same inputs produce same output', () => {
    const base = derivePalletAccount('py/trsry')
    expect(u8aToHex(deriveSubAccount(base, 100))).toBe(u8aToHex(deriveSubAccount(base, 100)))
  })

  it('throws error if base account is not 32 bytes', () => {
    expect(() => deriveSubAccount(new Uint8Array(16), 100)).toThrow('must be 32 bytes')
  })

  it('produces the raw preimage structure (no hashing)', () => {
    const base = derivePalletAccount('py/trsry')
    // "modl" (4) + "py/trsry" (8) + 100 as u32 LE (64000000) + 16 zero bytes
    expect(u8aToHex(deriveSubAccount(base, 100)))
      .toBe('0x6d6f646c70792f74727372796400000000000000000000000000000000000000')
  })
})
