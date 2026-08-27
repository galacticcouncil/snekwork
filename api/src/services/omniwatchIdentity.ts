import { createHash } from 'node:crypto'

const EMOJIS = [
  '🐵', '🐒', '🦍', '🦧', '🐶', '🐕', '🦮', '🐕‍🦺', '🐩', '🐺', '🦊', '🦝',
  '🐱', '🐈', '🐈‍⬛', '🦁', '🐯', '🐅', '🐆', '🐴', '🐎', '🦄', '🦓', '🦌',
  '🐮', '🐂', '🐃', '🐄', '🐷', '🐖', '🐗', '🐽', '🐏', '🐑', '🐐', '🐪',
  '🐫', '🦙', '🦒', '🐘', '🦏', '🦛', '🐭', '🐁', '🐀', '🐹', '🐰', '🐇',
  '🐿', '🦔', '🦇', '🐻', '🐻‍❄️', '🐨', '🐼', '🦥', '🦦', '🦨', '🦘', '🦡',
  '🐾', '🦃', '🐔', '🐓', '🐣', '🐤', '🐥', '🐦', '🐧', '🕊', '🦅', '🦆',
  '🦢', '🦉', '🦩', '🦚', '🦜', '🐸', '🐊', '🐢', '🦎', '🐍', '🐲', '🐉',
  '🦕', '🦖', '🐬', '🐟', '🐠', '🐡', '🦈', '🐙', '🐚', '🐌', '🦋', '🐛',
  '🐜', '🐝', '🐞', '🦗', '🕷', '🦂', '🦟', '🦠', '💐', '🌸', '💮', '🏵',
  '🌹', '🥀', '🌺', '🌻', '🌼', '🌷', '🌱', '🌲', '🌳', '🌴', '🌵', '🌾',
  '🌿', '☘', '🍀', '🍁', '🍂', '🍃', '🍄',
] as const

// Spelled-out names for the deterministic emoji set (plus a couple of glyphs
// used as tag icons), so an account can be found by the name the UI shows —
// e.g. 🍄 → "Mushroom", 🦈 → "Shark". Mirrors explorer-ui's EMOJI_NAMES.
const EMOJI_NAMES: Record<string, string> = {
  '🐵': 'Monkey', '🐒': 'Monkey', '🦍': 'Gorilla', '🦧': 'Orangutan', '🐶': 'Dog', '🐕': 'Dog', '🦮': 'Guide Dog', '🐕‍🦺': 'Service Dog', '🐩': 'Poodle', '🐺': 'Wolf', '🦊': 'Fox', '🦝': 'Raccoon',
  '🐱': 'Cat', '🐈': 'Cat', '🐈‍⬛': 'Black Cat', '🦁': 'Lion', '🐯': 'Tiger', '🐅': 'Tiger', '🐆': 'Leopard', '🐴': 'Horse', '🐎': 'Horse', '🦄': 'Unicorn', '🦓': 'Zebra', '🦌': 'Deer',
  '🐮': 'Cow', '🐂': 'Ox', '🐃': 'Buffalo', '🐄': 'Cow', '🐷': 'Pig', '🐖': 'Pig', '🐗': 'Boar', '🐽': 'Pig', '🐏': 'Ram', '🐑': 'Sheep', '🐐': 'Goat', '🐪': 'Camel',
  '🐫': 'Camel', '🦙': 'Llama', '🦒': 'Giraffe', '🐘': 'Elephant', '🦏': 'Rhino', '🦛': 'Hippo', '🐭': 'Mouse', '🐁': 'Mouse', '🐀': 'Rat', '🐹': 'Hamster', '🐰': 'Rabbit', '🐇': 'Rabbit',
  '🐿': 'Chipmunk', '🦔': 'Hedgehog', '🦇': 'Bat', '🐻': 'Bear', '🐻‍❄️': 'Polar Bear', '🐨': 'Koala', '🐼': 'Panda', '🦥': 'Sloth', '🦦': 'Otter', '🦨': 'Skunk', '🦘': 'Kangaroo', '🦡': 'Badger',
  '🐾': 'Paws', '🦃': 'Turkey', '🐔': 'Chicken', '🐓': 'Rooster', '🐣': 'Chick', '🐤': 'Chick', '🐥': 'Chick', '🐦': 'Bird', '🐧': 'Penguin', '🕊': 'Dove', '🦅': 'Eagle', '🦆': 'Duck',
  '🦢': 'Swan', '🦉': 'Owl', '🦩': 'Flamingo', '🦚': 'Peacock', '🦜': 'Parrot', '🐸': 'Frog', '🐊': 'Crocodile', '🐢': 'Turtle', '🦎': 'Lizard', '🐍': 'Snake', '🐲': 'Dragon', '🐉': 'Dragon',
  '🦕': 'Sauropod', '🦖': 'T-Rex', '🐬': 'Dolphin', '🐟': 'Fish', '🐠': 'Fish', '🐡': 'Pufferfish', '🦈': 'Shark', '🐙': 'Octopus', '🐚': 'Shell', '🐌': 'Snail', '🦋': 'Butterfly', '🐛': 'Bug',
  '🐜': 'Ant', '🐝': 'Bee', '🐞': 'Ladybug', '🦗': 'Cricket', '🕷': 'Spider', '🦂': 'Scorpion', '🦟': 'Mosquito', '🦠': 'Microbe', '💐': 'Bouquet', '🌸': 'Blossom', '💮': 'Flower', '🏵': 'Rosette',
  '🌹': 'Rose', '🥀': 'Wilted Rose', '🌺': 'Hibiscus', '🌻': 'Sunflower', '🌼': 'Daisy', '🌷': 'Tulip', '🌱': 'Seedling', '🌲': 'Evergreen', '🌳': 'Tree', '🌴': 'Palm Tree', '🌵': 'Cactus', '🌾': 'Rice',
  '🌿': 'Herb', '☘': 'Shamrock', '🍀': 'Clover', '🍁': 'Maple Leaf', '🍂': 'Fallen Leaf', '🍃': 'Leaf', '🍄': 'Mushroom', '🍺': 'Beer', '🏦': 'Bank',
}

// The spelled-out name for an emoji glyph (variation selectors ignored), or null.
export function emojiNameFor(emoji: string): string | null {
  return EMOJI_NAMES[emoji] ?? EMOJI_NAMES[emoji.replace(/️/g, '')] ?? null
}

// Reverse lookup for search: every emoji glyph whose spelled-out name matches the
// query (case-insensitive), ranked exact → prefix → substring — so "Mushroom"
// and "mush" both resolve to 🍄, and "dog" surfaces Dog before Guide/Service Dog.
// Substring matching needs ≥3 chars to avoid noise (e.g. "at" → Cat/Rat/Bat).
export function emojisMatchingName(query: string): string[] {
  const ql = query.trim().toLowerCase()
  if (ql.length < 2) return []
  const exact: string[] = [], prefix: string[] = [], sub: string[] = []
  for (const [emoji, name] of Object.entries(EMOJI_NAMES)) {
    const nl = name.toLowerCase()
    if (nl === ql) exact.push(emoji)
    else if (nl.startsWith(ql)) prefix.push(emoji)
    else if (ql.length >= 3 && nl.includes(ql)) sub.push(emoji)
  }
  return [...new Set([...exact, ...prefix, ...sub])]
}

// Two-token account queries combining the pill's colored 3-letter code with the
// avatar's spelled-out emoji name, in either order ("pmo pig" / "pig pmo").
// Returns every plausible (suffix, glyphs) reading — both when both tokens are
// emoji names ("cat dog") — so the search can try each against its indexes.
export function parseSuffixEmojiQuery(query: string): { suffix: string; glyphs: string[] }[] {
  const tokens = query.trim().split(/\s+/)
  if (tokens.length !== 2) return []
  const out: { suffix: string; glyphs: string[] }[] = []
  for (const [suffix, name] of [[tokens[0], tokens[1]], [tokens[1], tokens[0]]] as const) {
    if (!/^[0-9A-Za-z]{2,6}$/.test(suffix)) continue
    const glyphs = emojisMatchingName(name)
    if (glyphs.length) out.push({ suffix, glyphs })
  }
  return out
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
// Kusama's own prefix. Basilisk's neutral cross-chain display form: the relay it
// sits on, so a counterparty account reads the same way on every chain of it.
export const KUSAMA_SS58_PREFIX = 2
const BASILISK_SS58_PREFIX = 10041
const SS58_CHECKSUM_PREFIX = Buffer.from('SS58PRE')

export interface AccountIcon {
  emoji: string
  emojiName?: string
  emojiUrl?: string
}

export function shortAccount(account: string): string {
  return account.slice(-3)
}

function accountIdBytes(account: string): Uint8Array | null {
  const hex = account.startsWith('0x') ? account.slice(2) : account
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null
  return Uint8Array.from(Buffer.from(hex, 'hex'))
}

export function accountIdHex(account: string): string | null {
  const bytes = accountIdBytes(account) ?? ss58AccountIdBytes(account)
  return bytes ? `0x${Buffer.from(bytes).toString('hex')}` : null
}

function base58Encode(bytes: Uint8Array): string {
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++

  const hex = Buffer.from(bytes).toString('hex')
  let value = hex.length > 0 ? BigInt(`0x${hex}`) : 0n
  let encoded = ''

  while (value > 0n) {
    const remainder = Number(value % 58n)
    encoded = BASE58_ALPHABET[remainder] + encoded
    value /= 58n
  }

  return '1'.repeat(zeros) + encoded
}

function base58Decode(value: string): Uint8Array | null {
  let decoded = 0n

  for (const char of value) {
    const index = BASE58_ALPHABET.indexOf(char)
    if (index === -1) return null
    decoded = decoded * 58n + BigInt(index)
  }

  const bytes: number[] = []
  while (decoded > 0n) {
    bytes.unshift(Number(decoded & 0xffn))
    decoded >>= 8n
  }

  let zeros = 0
  while (zeros < value.length && value[zeros] === '1') zeros++

  return Uint8Array.from([...new Array(zeros).fill(0), ...bytes])
}

function ss58AccountIdBytes(account: string): Uint8Array | null {
  const decoded = base58Decode(account)
  if (!decoded || decoded.length < 35) return null

  const prefixLength = decoded[0] < 64 ? 1 : 2
  if (decoded.length !== prefixLength + 32 + 2) return null

  const payload = decoded.subarray(0, prefixLength + 32)
  const expectedChecksum = createHash('blake2b512')
    .update(Buffer.concat([SS58_CHECKSUM_PREFIX, Buffer.from(payload)]))
    .digest()
    .subarray(0, 2)
  const checksum = decoded.subarray(prefixLength + 32)
  if (checksum[0] !== expectedChecksum[0] || checksum[1] !== expectedChecksum[1]) return null

  return decoded.subarray(prefixLength, prefixLength + 32)
}

// SS58 network-prefix encoding. Prefixes below 64 occupy a single byte; 64…16383
// use the two-byte form, which spreads the 14-bit prefix over two bytes with the
// top two bits of the first set to 0b01 (the reserved-prefix marker that tells a
// decoder the prefix is two bytes long). Basilisk's 10041 needs the two-byte form.
function ss58PrefixBytes(prefix: number): Buffer {
  if (prefix < 64) return Buffer.from([prefix])
  return Buffer.from([
    ((prefix & 0xfc) >> 2) | 0x40,
    (prefix >> 8) | ((prefix & 0x03) << 6),
  ])
}

function ss58Address(account: string, prefix: number): string {
  const publicKey = accountIdBytes(account) ?? ss58AccountIdBytes(account)
  if (!publicKey) return account

  const payload = Buffer.concat([
    ss58PrefixBytes(prefix),
    Buffer.from(publicKey),
  ])
  const checksum = createHash('blake2b512')
    .update(Buffer.concat([SS58_CHECKSUM_PREFIX, payload]))
    .digest()
    .subarray(0, 2)

  return base58Encode(Buffer.concat([payload, checksum]))
}

export function basiliskAddress(account: string): string {
  return ss58Address(account, BASILISK_SS58_PREFIX)
}

export function kusamaAddress(account: string): string {
  return ss58Address(account, KUSAMA_SS58_PREFIX)
}

function defaultAccountEmoji(account: string, emojis: readonly string[] = EMOJIS): string {
  const hex = accountIdHex(account)?.slice(2) ?? ''
  if (/^[0-9a-fA-F]+$/.test(hex) && hex.length > 0) {
    const index = (Number(`0x${hex}`) / 2) % emojis.length
    return emojis[index] ?? emojis[0] ?? EMOJIS[0]
  }

  let hash = 0
  for (let i = 0; i < account.length; i++) {
    hash = (hash * 31 + account.charCodeAt(i)) >>> 0
  }
  return emojis[hash % emojis.length] ?? EMOJIS[0]
}

// The account avatar. Basilisk has no curated override set: every account gets
// the deterministic glyph derived from its public key. The optional
// emojiName/emojiUrl fields on AccountIcon stay in the shape for callers that
// render a named or image icon.
export function accountIcon(account: string): AccountIcon {
  return { emoji: defaultAccountEmoji(account) }
}
