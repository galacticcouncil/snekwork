import React from 'react'
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { EvmCallCard, EvmLogView } from '../src/components/EvmDecoded'
import { decodedParamsRecord, evmTransactionEnvelope } from '../src/utils/evmDecoded'
import { EventDetail } from '../src/pages/EventDetail'
import { ExtrinsicDetail as ExtrinsicDetailPage } from '../src/pages/ExtrinsicDetail'
import { mockSync, MOCK_EVM_TX, MOCK_EVM_TX_HASH } from './fixtures/mockApi'
import type {
  DecodedEvmCall, EvmLogDecode,
  EventDetail as EventDetailData, ExtrinsicDetail,
} from '../src/types'

const ADDR = '0x531a654d1696ed52e7275a8cede955e82620f99a'
const CALLER = '0x4b0540d29f19b2da4cce2b1ba6b6325dd9d86622'

const decodedCall: DecodedEvmCall = {
  target: ADDR,
  contractName: 'GhoToken',
  call: {
    decoded: true,
    name: 'transfer',
    signature: 'transfer(address,uint256)',
    selector: '0xa9059cbb',
    params: [
      { name: 'to', type: 'address', value: CALLER },
      { name: 'value', type: 'uint256', value: '1000000' },
    ],
  },
}

const decodedLog: EvmLogDecode = {
  decoded: true,
  name: 'Transfer',
  signature: 'Transfer(address,address,uint256)',
  decodedBy: 'verified-abi',
  params: [
    { name: 'from', type: 'address', value: CALLER, indexed: true },
    { name: 'to', type: 'address', value: ADDR, indexed: true },
    { name: 'value', type: 'uint256', value: '1000000' },
  ],
}

function render(node: React.ReactNode, seed?: (qc: QueryClient) => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } })
  seed?.(queryClient)
  return renderToStaticMarkup(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>)
}

describe('decodedParamsRecord', () => {
  it('keys params by name, suffixing duplicates and empties positionally', () => {
    expect(decodedParamsRecord([
      { name: 'to', type: 'address', value: CALLER },
      { name: 'to', type: 'address', value: ADDR },
      { name: '', type: 'uint256', value: '5' },
    ])).toEqual({ to: CALLER, 'to#1': ADDR, arg2: '5' })
  })

  it('labels hashed indexed params instead of pretending the preimage is known', () => {
    const rec = decodedParamsRecord([{ name: 'key', type: 'string', value: '0x' + 'ab'.repeat(32), indexed: true, hashed: true }])
    expect(rec.key).toContain('indexed hash')
  })
})

describe('EvmCallCard / EvmLogView', () => {
  it('renders the signature chip, target link and typed args', () => {
    const out = render(<EvmCallCard decoded={decodedCall} />)
    expect(out).toContain('transfer(address,uint256)')
    expect(out).toContain('GhoToken')
    expect(out).toContain(`/account/${ADDR}`)
    expect(out).toContain('verified ABI')
    // Address values auto-link through ParamsTable.
    expect(out).toContain(`/account/${CALLER}`)
    expect(out).toContain('1000000')
  })

  it('falls back to the bare selector when args cannot be decoded', () => {
    const out = render(<EvmCallCard decoded={{ target: ADDR, contractName: null, call: { decoded: false, selector: '0xdeadbeef' } }} />)
    expect(out).toContain('0xdeadbeef')
    expect(out).not.toContain('kv-row')
  })

  it('renders decoded log params with names', () => {
    const out = render(<EvmLogView decoded={decodedLog} />)
    expect(out).toContain('Transfer(address,address,uint256)')
    expect(out).toContain('from')
    expect(out).toContain(`/account/${CALLER}`)
  })
})

// The extrinsic page's Parameters/Events tabs are component-local state, so
// static markup can only show the default Activity tab — the decoded-call and
// decoded-event wiring on that page is exercised end-to-end in
// e2e/contract-tab.spec.ts, which clicks the tabs against the mock API.

describe('EventDetail decoding', () => {
  const detail: EventDetailData = {
    blockHeight: 100, eventIndex: 0, extrinsicIndex: 2, timestamp: '2026-08-04 10:00:00',
    name: 'EVM.Log', args: { log: { address: ADDR, topics: [], data: '0x' } }, decoded: true,
    evmDecoded: decodedLog, phase: 'ApplyExtrinsic(2)', extrinsic: null,
  }

  it('renders named attributes with the verified-abi signature', () => {
    const out = render(<EventDetail id="100-0" />, qc => qc.setQueryData(['event', '100-0'], detail))
    expect(out).toContain('Transfer(address,address,uint256)')
    expect(out).toContain(`/account/${CALLER}`)
  })
})

// The extrinsic page IS the EVM transaction's page (there is no /tx/<hash> route),
// so these rows are the only place the explorer states an Ethereum transaction's own
// facts. The fixture's one Ethereum.transact extrinsic is the subject, reached by
// both of its addresses.
describe('EVM transaction rows on the extrinsic page', () => {
  const evmTxId = `${MOCK_EVM_TX.height}-${MOCK_EVM_TX.index}`
  const detail = mockSync<ExtrinsicDetail>(`/explorer/extrinsic-at/${MOCK_EVM_TX.height}/${MOCK_EVM_TX.index}`)!

  it('answers the transaction hash and the extrinsic id with the same extrinsic', () => {
    expect(mockSync<ExtrinsicDetail>(`/explorer/extrinsic/${MOCK_EVM_TX_HASH}`)).toEqual(detail)
    // The two hashes are different values naming the same action — which is the
    // whole reason the transaction hash has to be resolved.
    expect(detail.hash).not.toBe(MOCK_EVM_TX_HASH)
    expect(detail.evmTx?.txHash).toBe(MOCK_EVM_TX_HASH)
  })

  // Gas is not indexed and there is no receipt to read: the page states
  // everything else and simply leaves the gas rows out — never a zero or a
  // placeholder standing in for a number nobody has.
  it('renders the transaction facts, and shows no gas at all', () => {
    const out = render(<ExtrinsicDetailPage id={evmTxId} />, qc => qc.setQueryData(['extrinsic', evmTxId], detail))
    expect(out).toContain('EVM tx hash')
    expect(out).toContain(MOCK_EVM_TX_HASH)
    expect(out).toContain('EIP1559')
    expect(out).toContain('141')
    expect(out).toContain('Succeed')
    expect(out).toContain('Stopped')
    expect(out).not.toContain('Gas')
    // The substrate extrinsic hash keeps its own row: both hashes are real.
    expect(out).toContain(detail.hash)
    // And no substrate fee is invented — Ethereum.transact carries no
    // TransactionPayment.TransactionFeePaid event.
    expect(out).toContain('Fee')
  })

  // 35,627 reverted EVM transactions expose no reason anywhere else in the explorer;
  // extraData is the selector the contract returned.
  it('states a revert with the data it returned', () => {
    const reverted: ExtrinsicDetail = {
      ...detail,
      evmTx: { txHash: MOCK_EVM_TX_HASH, exitKind: 'Revert', exitDetail: 'Reverted', extraData: '0x303b682f' },
    }
    const out = render(<ExtrinsicDetailPage id={evmTxId} />, qc => qc.setQueryData(['extrinsic', evmTxId], reverted))
    expect(out).toContain('Revert')
    expect(out).toContain('Reverted')
    expect(out).toContain('0x303b682f')
  })

  // The EVM's native currency here is WETH (asset 20, 18 decimals), not HDX: every
  // non-zero-value transaction in the chain's history moves currency 20 in exactly the
  // transaction's own raw units. Unlabelled, the figure reads as 12-decimal HDX and is
  // misread by six orders of magnitude, so the unit is part of the answer.
  it('names the value in WETH rather than leaving the figure bare', () => {
    const args = detail.callArgs as { transaction: { value: Record<string, unknown> } }
    const withValue: ExtrinsicDetail = {
      ...detail,
      callArgs: { transaction: { ...args.transaction, value: { ...args.transaction.value, value: '52182158448156' } } },
    }
    const out = render(<ExtrinsicDetailPage id={evmTxId} />, qc => qc.setQueryData(['extrinsic', evmTxId], withValue))
    // 52182158448156 at 18 decimals, on the shared rough scale's subscript-zero notation.
    expect(out).toContain('0.0₃5218 WETH')
    expect(out).not.toContain('0.0₃5218 HDX')
  })

  it('adds no EVM rows to an extrinsic that submitted no EVM transaction', () => {
    const plain = mockSync<ExtrinsicDetail>('/explorer/extrinsic-at/12848613/4')!
    expect(plain.callName).not.toBe('Ethereum.transact')
    const out = render(<ExtrinsicDetailPage id="12848613-4" />, qc => qc.setQueryData(['extrinsic', '12848613-4'], plain))
    expect(out).not.toContain('EVM tx hash')
    expect(out).not.toContain('Nonce')
  })
})

// Legacy and EIP1559 transactions state their price in different fields, and one is
// a ceiling while the other is the price paid — a surface may not present them alike.
describe('evmTransactionEnvelope', () => {
  it('reads an EIP1559 envelope and names maxFeePerGas as the source', () => {
    expect(evmTransactionEnvelope({
      transaction: { __kind: 'EIP1559', value: { nonce: '141', gasLimit: '565795', value: '0', maxFeePerGas: '7000447', maxPriorityFeePerGas: '7000447' } },
    })).toEqual({ kind: 'EIP1559', nonce: '141', value: '0', gasLimit: '565795', gasPrice: { field: 'maxFeePerGas', value: '7000447' } })
  })

  it('reads a Legacy envelope and names gasPrice as the source', () => {
    expect(evmTransactionEnvelope({
      transaction: { __kind: 'Legacy', value: { nonce: 7, gasLimit: '210000', value: '1000000000000000000', gasPrice: '7000000' } },
    })).toEqual({ kind: 'Legacy', nonce: '7', value: '1000000000000000000', gasLimit: '210000', gasPrice: { field: 'gasPrice', value: '7000000' } })
  })

  it('has nothing to read on a call that carries no transaction', () => {
    expect(evmTransactionEnvelope({ source: '0x1', target: '0x2' })).toBeNull()
    expect(evmTransactionEnvelope(null)).toBeNull()
    // A malformed field is absent, never zero.
    expect(evmTransactionEnvelope({ transaction: { __kind: 'Legacy', value: { nonce: 'abc' } } }))
      .toEqual({ kind: 'Legacy', nonce: null, value: null, gasLimit: null, gasPrice: null })
  })
})
