import { getOldTypesBundle } from '@subsquid/substrate-runtime/lib/metadata/index.js'
import type { OldTypesBundle } from '@subsquid/substrate-runtime/lib/metadata/index.js'

/**
 * Hand-written type definitions for Basilisk's pre-V14 metadata.
 *
 * Specs 16 and 19 (blocks 0-395,663) ship V13 metadata, which names types
 * instead of describing them, so those runtimes can only be decoded with a
 * type bundle. `@subsquid/substrate-runtime` ships one for Basilisk, and it is
 * the base here — but it is missing the orml-tokens alias that the same
 * package's `hydradx` bundle carries, and without that alias the genesis era
 * decodes Tokens balances with the wrong codec.
 *
 * V13 metadata declares BOTH `Balances.Account` and `Tokens.Accounts` as
 * `AccountData<T::Balance>`, yet they are different structs: pallet-balances
 * stores {free, reserved, miscFrozen, feeFrozen} (64 bytes) and orml-tokens
 * stores {free, reserved, frozen} (48 bytes) — confirmed against the storage
 * fallbacks in specs 16 and 19, which are 64 and 48 bytes respectively. Without
 * the alias every Tokens.Accounts read in the first 395,663 blocks — including
 * the default-value decode the raw balance indexer performs on every block —
 * fails with "Unexpected EOF" while trying to read a fourth u128 that is not
 * there.
 *
 * Chain-wide type names cannot express that difference; `typesAlias` scopes the
 * name to one pallet, which is exactly what it is for.
 */
const shippedBundle = getOldTypesBundle('basilisk')
if (shippedBundle == null) {
  throw new Error("@subsquid/substrate-runtime no longer ships a 'basilisk' old-types bundle")
}

export const basiliskTypesBundle: OldTypesBundle = {
  ...shippedBundle,
  typesAlias: {
    ...shippedBundle.typesAlias,
    tokens: {
      ...shippedBundle.typesAlias?.tokens,
      AccountData: 'OrmlAccountData',
    },
  },
}
