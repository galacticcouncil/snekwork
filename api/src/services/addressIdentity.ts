import { basiliskAddress, kusamaAddress, accountIdHex } from './omniwatchIdentity.ts'

// Basilisk has no EVM, so no address here is ever an H160 wallet and there is no
// truncated ETH-marker account form to normalise. The one 20-byte shape that still
// means something is a RESERVED substrate account ('modl'/'sibl'/'para', see below)
// seen through the runtime's 20-byte truncation — generic XCM plumbing, since an
// AccountKey20 junction can name one. Anything else 20 bytes wide is not an address
// on this chain and normalises to null rather than to an account that cannot exist.
export type AddressKind = 'substrate' | 'unknown'

export interface NormalizedAddress {
  input: string
  kind: AddressKind
  accountId: string           // canonical 0x + 64 hex AccountId32 (join key)
  ss58: string | null         // Basilisk SS58 (prefix 10041) — the canonical display form
  ss58Kusama: string | null   // Kusama SS58 (prefix 2) — secondary display form
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
  return {
    input,
    kind: 'substrate',
    accountId: acc,
    ss58: basiliskAddress(acc),
    ss58Kusama: kusamaAddress(acc),
  }
}

export function normalizeAddress(raw: string): NormalizedAddress | null {
  const input = raw.trim()
  if (!input) return null

  // A bare 20-byte input is an address here only when it is the truncation of a
  // reserved account; otherwise it names nothing on this chain.
  if (/^0x[0-9a-fA-F]{40}$/.test(input)) {
    const reserved = reservedH160AccountId(input.toLowerCase().slice(2))
    return reserved ? fromAccountId(input, reserved) : null
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
