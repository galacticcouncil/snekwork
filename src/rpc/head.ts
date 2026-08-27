const RPC_TIMEOUT_MS = 15_000

interface JsonRpcResponse {
  result?: unknown
  error?: unknown
}

function isHttpUrl(url: string): boolean {
  return /^https?:/i.test(url)
}

async function requestResult(
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  })
  if (!response.ok) return null

  const payload = await response.json() as JsonRpcResponse
  return payload.error == null ? payload.result : null
}

export function parseRpcBlockNumber(value: unknown): number | null {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) return null

  try {
    const block = BigInt(value)
    return block <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(block) : null
  } catch {
    return null
  }
}

/** Resolve the current best block from an HTTP(S) Substrate RPC endpoint. */
export async function fetchChainHead(rpcUrl: string): Promise<number | null> {
  if (!isHttpUrl(rpcUrl)) return null

  try {
    const header = await requestResult(rpcUrl, 'chain_getHeader', []) as { number?: unknown } | null
    return parseRpcBlockNumber(header?.number)
  } catch {
    return null
  }
}

/**
 * The runtime `specName` this indexer decodes. Every codec in `src/types` was
 * generated from Basilisk metadata, and none of them carry the chain's identity,
 * so a Hydration (or any other) endpoint pointed at these processors would decode
 * a plausible-looking subset and silently write wrong rows. Neckwork never pinned
 * chain identity; snekwork does, at startup, before a single block is requested.
 */
export const EXPECTED_SPEC_NAME = 'basilisk'

/**
 * Abort unless `rpcUrl` serves the chain these types were generated from.
 *
 * WebSocket endpoints cannot be probed with `fetch`, so they are reported and
 * skipped; every default in this repo is HTTPS. A reachable HTTP endpoint that
 * cannot answer `state_getRuntimeVersion` is treated as a failure too — an
 * unverified pairing is exactly the state this guard exists to prevent.
 */
export async function assertChainIdentity(rpcUrl: string, label = 'indexer'): Promise<void> {
  if (!isHttpUrl(rpcUrl)) {
    console.warn(`[${label}] Cannot verify chain identity over a non-HTTP endpoint (${rpcUrl}); expected specName '${EXPECTED_SPEC_NAME}'`)
    return
  }

  let version: { specName?: unknown; specVersion?: unknown } | null
  try {
    version = await requestResult(rpcUrl, 'state_getRuntimeVersion', []) as { specName?: unknown; specVersion?: unknown } | null
  } catch (error) {
    throw new Error(`Could not read state_getRuntimeVersion from ${rpcUrl} to confirm it serves '${EXPECTED_SPEC_NAME}'`, { cause: error })
  }

  const specName = version?.specName
  if (typeof specName !== 'string') {
    throw new Error(`${rpcUrl} did not return a runtime specName; refusing to index an unidentified chain (expected '${EXPECTED_SPEC_NAME}')`)
  }

  if (specName !== EXPECTED_SPEC_NAME) {
    throw new Error(
      `${rpcUrl} serves specName '${specName}', but this indexer only decodes '${EXPECTED_SPEC_NAME}'. `
      + 'Point RPC_URL at a Basilisk archive node (default: https://rpc.basilisk.cloud).',
    )
  }

  console.log(`[${label}] Chain identity confirmed: ${specName}/${String(version?.specVersion ?? '?')} at ${rpcUrl}`)
}

/** Resolve the current finalized block from an HTTP(S) Substrate RPC endpoint. */
export async function fetchFinalizedHead(rpcUrl: string): Promise<number | null> {
  if (!isHttpUrl(rpcUrl)) return null

  try {
    const hash = await requestResult(rpcUrl, 'chain_getFinalizedHead', [])
    if (typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(hash)) return null

    const header = await requestResult(rpcUrl, 'chain_getHeader', [hash]) as { number?: unknown } | null
    return parseRpcBlockNumber(header?.number)
  } catch {
    return null
  }
}
