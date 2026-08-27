import type { Block } from '../types/support.ts'
import { NATIVE_ASSET_ID } from '../nativeAsset.js'
import { systemAccountCodec, tokensAccountsCodec } from '../chainEras.js'

export interface XykPoolKey {
  poolAccount: string
  assetA: number
  assetB: number
}

export interface XykPoolReserves {
  /** null when the pool account has no entry for that asset at this block. */
  reserveA: bigint | null
  reserveB: bigint | null
}

/**
 * Read both reserves of every XYK pool at a block.
 *
 * The XYK pallet holds a pool's reserves as the pool account's free balance of
 * each asset, read through `Currencies`. That routes asset 0 (BSX) to
 * `Balances`/`System.Account` and every other asset to `Tokens.Accounts`, so a
 * Tokens-only read returns nothing for the native leg — and on Basilisk the
 * native leg is most of the book: BSX/KSM, BSX/USDT, BSX/aUSD and BSX/XRT would
 * all silently drop out with no reserves and therefore no price.
 *
 * `batched` lets each caller keep its own chunking/concurrency policy; the
 * default issues one `getMany` per storage item.
 */
type BatchedRead = <K, V>(keys: K[], read: (keys: K[]) => Promise<V[]>) => Promise<V[]>

const readInOneCall: BatchedRead = (keys, read) => (keys.length === 0 ? Promise.resolve([]) : read(keys))

export async function readXykPoolReserves(
  block: Block,
  pools: XykPoolKey[],
  batched: BatchedRead = readInOneCall,
): Promise<XykPoolReserves[]> {
  if (pools.length === 0) return []

  const tokensAccounts = tokensAccountsCodec(block)
  if (tokensAccounts == null) {
    throw new Error(`Unsupported Tokens.Accounts storage for XYK pools at block ${block.height}`)
  }

  const tokenKeys: [string, number][] = []
  // Index into `tokenKeys` for each pool leg, or -1 when the leg is native.
  const tokenSlots: number[] = []
  const nativeAccounts: string[] = []
  const nativeSlotByAccount = new Map<string, number>()

  for (const pool of pools) {
    for (const assetId of [pool.assetA, pool.assetB]) {
      if (assetId === NATIVE_ASSET_ID) {
        if (!nativeSlotByAccount.has(pool.poolAccount)) {
          nativeSlotByAccount.set(pool.poolAccount, nativeAccounts.length)
          nativeAccounts.push(pool.poolAccount)
        }
        tokenSlots.push(-1)
      } else {
        tokenSlots.push(tokenKeys.length)
        tokenKeys.push([pool.poolAccount, assetId])
      }
    }
  }

  const systemAccount = nativeAccounts.length > 0 ? systemAccountCodec(block) : null
  if (nativeAccounts.length > 0 && systemAccount == null) {
    throw new Error(`Unsupported System.Account storage for native XYK reserves at block ${block.height}`)
  }

  const [tokenBalances, nativeBalances] = await Promise.all([
    batched(tokenKeys, keys => tokensAccounts.getMany(block, keys)),
    systemAccount == null
      ? Promise.resolve([])
      : batched(nativeAccounts, keys => systemAccount.getMany(block, keys)),
  ])

  // System.Account is a `Default` map: an account with no entry holds nothing,
  // which is a zero reserve rather than an unreadable one.
  const nativeFallback = systemAccount?.getDefault(block)

  const reserveAt = (slot: number, poolAccount: string): bigint | null => {
    const tokenIndex = tokenSlots[slot]
    if (tokenIndex >= 0) {
      const balance = tokenBalances[tokenIndex]
      return balance == null ? null : balance.free
    }
    const nativeIndex = nativeSlotByAccount.get(poolAccount)!
    return (nativeBalances[nativeIndex] ?? nativeFallback!).data.free
  }

  return pools.map((pool, index) => ({
    reserveA: reserveAt(index * 2, pool.poolAccount),
    reserveB: reserveAt(index * 2 + 1, pool.poolAccount),
  }))
}
