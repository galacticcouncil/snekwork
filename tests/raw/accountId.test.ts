import { describe, expect, it } from 'vitest'
import { deriveTruncatedAccountId, normalizeAccountId, normalizeH160 } from '../../src/raw/accountId.ts'

const EVM_ADDRESS = '0xf34e845538cc8a498edd97d7cde16fdfef3d4d99'
const SUBSTRATE_ADDRESS = '12ZuLmV5gJsqomPABtWHGMgrwoWx4sEYeEEM3tDGdRXNqKys'
const TRUNCATED_ACCOUNT = '0x45544800f34e845538cc8a498edd97d7cde16fdfef3d4d990000000000000000'

describe('raw account id decoding', () => {
  it('widens an AccountKey20 address to its truncated AccountId32 form', () => {
    expect(deriveTruncatedAccountId(EVM_ADDRESS)).toBe(TRUNCATED_ACCOUNT)
  })

  it('decodes an SS58 address to its public key', () => {
    expect(normalizeAccountId(SUBSTRATE_ADDRESS)).toBe(TRUNCATED_ACCOUNT)
  })

  it('reads an address out of a junction wrapper object', () => {
    expect(normalizeH160({ AccountKey20: { key: EVM_ADDRESS } })).toBe(EVM_ADDRESS)
  })

  it('rejects a value that is not an account of either width', () => {
    expect(normalizeAccountId('0xdeadbeef')).toBeNull()
    expect(normalizeH160('0xdeadbeef')).toBeNull()
  })
})
