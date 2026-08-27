import { basiliskAddress, kusamaAddress, accountIdHex } from './omniwatchIdentity.ts'

// Basilisk has no EVM accounts, so no address here is ever a real H160 wallet.
// The "truncated" AccountId32 form — marker bytes "ETH\0" (0x45544800), a
// 20-byte H160, then 8 zero bytes — is kept only as an INPUT shape: an H160
// carrying a reserved substrate prefix ('modl'/'sibl'/'para', see below) is the
// runtime's truncation of a pallet or sovereign account, and recovering the real
// AccountId32 from it is generic XCM plumbing. Nothing derived here is exposed
// in an API response.
const EVM_MARKER = '45544800'
const ZERO16 = '0000000000000000'

export type AddressKind = 'substrate' | 'evm' | 'unknown'

export interface NormalizedAddress {
  input: string
  kind: AddressKind
  accountId: string           // canonical 0x + 64 hex AccountId32 (join key)
  // INTERNAL ONLY — never returned in an API response. 0x + 40 hex H160 when the
  // input/accountId is in the ETH-marker truncated form; used to re-anchor a
  // truncated pallet/sovereign account and to scope reads, not to display.
  evmAddress: string | null
  ss58: string | null         // Basilisk SS58 (prefix 10041) — the canonical display form
  ss58Kusama: string | null   // Kusama SS58 (prefix 2) — secondary display form
  isEvmTruncated: boolean      // accountId is the ETH-marker truncated form
}

function evmTruncatedAccountId(h160NoPrefix: string): string {
  return '0x' + EVM_MARKER + h160NoPrefix.toLowerCase() + ZERO16
}

// Reserved substrate account prefixes: pallet ('modl'), sibling parachain
// ('sibl') and parachain ('para') accounts are 20 meaningful bytes + 12 zero
// bytes. An H160 carrying one of these is the runtime's TRUNCATION of that
// module/sovereign account — not a real EVM account — and the full AccountId32
// is recovered exactly by padding the H160 with 12 zero bytes.
const RESERVED_H160_PREFIXES = ['6d6f646c', '7369626c', '70617261']
export function reservedH160AccountId(h160NoPrefix: string): string | null {
  const h = h160NoPrefix.toLowerCase()
  return RESERVED_H160_PREFIXES.some(p => h.startsWith(p)) ? '0x' + h + '000000000000000000000000' : null
}

function fromAccountId(input: string, acc: string): NormalizedAddress {
  const isTrunc = acc.slice(2, 10) === EVM_MARKER && acc.slice(50) === ZERO16
  // ETH-prefixed form of a module/sovereign account → resolve to the real one.
  if (isTrunc) {
    const reserved = reservedH160AccountId(acc.slice(10, 50))
    if (reserved) return fromAccountId(input, reserved)
  }
  const evm = isTrunc ? '0x' + acc.slice(10, 50) : null
  return {
    input,
    kind: isTrunc ? 'evm' : 'substrate',
    accountId: acc,
    evmAddress: evm,
    ss58: basiliskAddress(acc),
    ss58Kusama: kusamaAddress(acc),
    isEvmTruncated: isTrunc,
  }
}

export function normalizeAddress(raw: string): NormalizedAddress | null {
  const input = raw.trim()
  if (!input) return null

  // Bare EVM H160 -> truncated AccountId32 form (module/sovereign truncations
  // resolve to their real substrate account instead).
  if (/^0x[0-9a-fA-F]{40}$/.test(input)) {
    const evm = input.toLowerCase()
    const reserved = reservedH160AccountId(evm.slice(2))
    if (reserved) return fromAccountId(input, reserved)
    const accountId = evmTruncatedAccountId(evm.slice(2))
    return {
      input,
      kind: 'evm',
      accountId,
      evmAddress: evm,
      ss58: basiliskAddress(accountId),
      ss58Kusama: kusamaAddress(accountId),
      isEvmTruncated: true,
    }
  }

  // Raw 0x AccountId32.
  if (/^0x[0-9a-fA-F]{64}$/.test(input)) {
    return fromAccountId(input, input.toLowerCase())
  }

  // SS58 (any prefix) -> public key hex.
  const hex = accountIdHex(input)
  if (hex && /^0x[0-9a-fA-F]{64}$/.test(hex)) {
    return fromAccountId(input, hex.toLowerCase())
  }

  return null
}

export { basiliskAddress, kusamaAddress }
