import type { AssetMetadata } from '../registry/types.ts'

export interface RawBlockRow {
  block_height: number
  block_hash: string
  parent_hash: string
  state_root: string | null
  extrinsics_root: string | null
  block_timestamp: string
  spec_version: number
  author: string | null
  ingest_source: string
}

export interface RawExtrinsicRow {
  block_height: number
  block_timestamp: string
  extrinsic_index: number
  extrinsic_hash: string
  version: number
  signer: string | null
  effective_signer: string | null
  fee: string | null
  tip: string | null
  success: number
  signature_json: string | null
  call_name: string
  call_args_json: string
  error_json: string | null
  ingest_source: string
}

export interface RawCallRow {
  block_height: number
  block_timestamp: string
  extrinsic_index: number | null
  call_address: string
  parent_call_address: string | null
  call_name: string
  origin_json: string | null
  args_json: string
  success: number | null
  error_json: string | null
  ingest_source: string
}

export interface RawEventRow {
  block_height: number
  block_timestamp: string
  event_index: number
  extrinsic_index: number | null
  call_address: string | null
  phase: string
  event_name: string
  args_json: string
  ingest_source: string
}

export interface RawBlockSnapshotRow {
  block_height: number
  block_hash: string
  block_timestamp: string
  spec_version: number
  snapshot_version: number
  families: string[]
  payload_format: string
  payload_json: string
  payload_sha256: string
  ingest_source: string
}

export interface RawBalanceObservationRow {
  block_height: number
  block_timestamp: string
  observation_id: string
  account_id: string
  asset_kind: string
  asset_id: string
  free: string | null
  reserved: string | null
  frozen: string | null
  total: string | null
  nonce: number | null
  flags: string | null
  source_kind: string
  source_name: string
  source_event_index: number | null
  source_call_address: string | null
  evidence_json: string
  ingest_source: string
}

export interface RawXcmActivityRow {
  block_height: number
  block_timestamp: string
  source_kind: string
  source_index: string
  event_index: number | null
  extrinsic_index: number | null
  call_address: string | null
  name: string
  direction: string
  sender: string | null
  recipient: string | null
  message_hash: string | null
  assets_json: string
  location_json: string
  external_link_hints: string[]
  args_json: string
  ingest_source: string
}

export interface RawBridgeEvidenceRow {
  block_height: number
  block_timestamp: string
  source_kind: string
  source_index: string
  event_index: number | null
  extrinsic_index: number | null
  call_address: string | null
  name: string
  bridge_kind: string
  direction: string
  account_id: string | null
  external_account: string | null
  asset_id: string | null
  amount: string | null
  evidence_json: string
  ingest_source: string
}

export interface RawOperationTraceRow {
  block_height: number
  block_timestamp: string
  trace_id: string
  event_index: number | null
  extrinsic_index: number | null
  call_address: string | null
  operation_name: string
  account_id: string | null
  operation_stack_json: string
  assets_json: string
  amounts_json: string
  evidence_json: string
  ingest_source: string
}

export interface RawParserWarningRow {
  block_height: number
  block_timestamp: string
  parser: string
  source_kind: string
  source_name: string
  source_index: string
  warning_code: string
  warning: string
  evidence_json: string
  ingest_source: string
}

export interface RawIngestionStateRow {
  pipeline_id: string
  last_block: number
  last_hash: string
  mode: string
  state_json?: string
  updated_at?: string
}

export interface SnapshotXykPoolState {
  pool_account: string
  asset_a: number
  asset_b: number
  reserve_a: string
  reserve_b: string
}

export interface SnapshotState {
  assets: AssetMetadata[]
  xyk_pools: SnapshotXykPoolState[]
}

export interface SnapshotPayload {
  schema_version: number
  block: {
    height: number
    hash: string
    timestamp: string
    spec_version: number
  }
  assets: {
    items: AssetMetadata[]
  }
  xyk: {
    pools: SnapshotXykPoolState[]
  }
}
