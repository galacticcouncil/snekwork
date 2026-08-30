import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const supervisorPath = fileURLToPath(new URL('../../scripts/ingestion-supervisor.sh', import.meta.url))

interface Scenario {
  /** last_block, last_hash, age-in-seconds returned for the raw-live checkpoint */
  checkpoint: [number, string, number] | null
  /** block_height -> hash stored in raw_blocks */
  stored: Record<number, string>
  /** block_height -> hash the chain reports; missing means the RPC answers nothing */
  chain: Record<number, string>
  env?: Record<string, string>
}

/**
 * Runs heal_live_raw_reorg against stubbed `docker` and `curl` binaries, so the
 * real ch_query and rpc_block_hash code paths execute. Returns the supervisor's
 * log output plus every SQL statement and docker subcommand it issued.
 */
function runHeal(scenario: Scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'reorg-heal-'))
  const bin = join(dir, 'bin')
  const sqlLog = join(dir, 'sql.log')
  const dockerLog = join(dir, 'docker.log')

  spawnSync('mkdir', ['-p', bin])
  writeFileSync(join(dir, 'stored.json'), JSON.stringify(scenario.stored))
  writeFileSync(join(dir, 'chain.json'), JSON.stringify(scenario.chain))
  writeFileSync(
    join(dir, 'checkpoint.tsv'),
    scenario.checkpoint ? scenario.checkpoint.join('\t') : ''
  )

  // stub docker: records every invocation, answers clickhouse-client queries
  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${dockerLog}
query=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--query" ]]; then query="$2"; fi
  shift
done
[[ -z "$query" ]] && exit 0
printf '%s\\n---\\n' "$query" >> ${sqlLog}
if [[ "$query" == *raw_ingestion_state*SELECT* || "$query" == *"FROM raw_ingestion_state"* ]]; then
  if [[ "$query" == INSERT* || "$query" == *INSERT\\ INTO* ]]; then exit 0; fi
  cat ${join(dir, 'checkpoint.tsv')}
  exit 0
fi
if [[ "$query" == *"FROM raw_blocks"* ]]; then
  height=$(printf '%s' "$query" | grep -oE 'block_height = [0-9]+' | grep -oE '[0-9]+')
  node -e "const m=require('${join(dir, 'stored.json')}');const v=m[process.argv[1]];if(v)console.log(v)" "$height"
  exit 0
fi
exit 0
`,
    { mode: 0o755 }
  )
  chmodSync(join(bin, 'docker'), 0o755)

  // stub curl: answers chain_getBlockHash from the chain fixture
  writeFileSync(
    join(bin, 'curl'),
    `#!/usr/bin/env bash
payload=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-d" ]]; then payload="$2"; fi
  shift
done
height=$(printf '%s' "$payload" | grep -oE 'params":\\[[0-9]+' | grep -oE '[0-9]+')
node -e "const m=require('${join(dir, 'chain.json')}');const v=m[process.argv[1]];if(v)console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:v}))" "$height"
`,
    { mode: 0o755 }
  )
  chmodSync(join(bin, 'curl'), 0o755)

  const result = spawnSync(
    'bash',
    ['-c', `source "${supervisorPath}"; heal_live_raw_reorg`],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        SUPERVISOR_NO_MAIN: '1',
        ROOT_DIR: dir,
        ...scenario.env,
      },
    }
  )

  const sql = existsSync(sqlLog) ? readFileSync(sqlLog, 'utf8') : ''
  const dockerCalls = existsSync(dockerLog) ? readFileSync(dockerLog, 'utf8') : ''
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status, sql, dockerCalls }
}

const FORK = '0x4c7e825b50dec3a5786ee4a39e647ebc24f79b406e5b8b01117a3d5a6158eac0'
const CANON = '0xb963694f06991107c0190a322015be7d925f7fc57c682dacf263916b39943915'
const ANCESTOR = '0x8eac13bf2780b557a126d95d1779e93e9d79a2084bce23ab635ab414803a5cd4'

describe('raw-live reorg healing', () => {
  it('does nothing while the checkpoint is fresh', () => {
    const r = runHeal({
      checkpoint: [16867800, FORK, 30],
      stored: {},
      chain: { 16867800: CANON },
    })
    expect(r.status).toBe(0)
    expect(r.sql).not.toContain('INSERT INTO raw_ingestion_state')
    expect(r.dockerCalls).not.toContain('restart')
  })

  it('does nothing when a stalled checkpoint is still canonical', () => {
    const r = runHeal({
      checkpoint: [16867800, CANON, 3600],
      stored: {},
      chain: { 16867800: CANON },
    })
    expect(r.stdout).toContain('still canonical')
    expect(r.sql).not.toContain('INSERT INTO raw_ingestion_state')
    expect(r.dockerCalls).not.toContain('restart')
  })

  it('does not roll back when the RPC does not answer', () => {
    const r = runHeal({
      checkpoint: [16867800, FORK, 3600],
      stored: { 16867798: ANCESTOR },
      chain: {},
    })
    expect(r.stdout).toContain('no RPC answer')
    expect(r.sql).not.toContain('INSERT INTO raw_ingestion_state')
  })

  it('rolls the checkpoint back to the common ancestor and restarts raw-live', () => {
    const r = runHeal({
      checkpoint: [16867800, FORK, 3600],
      stored: {
        16867799: '0x18c167f89a000000000000000000000000000000000000000000000000000000',
        16867798: ANCESTOR,
      },
      chain: {
        16867800: CANON,
        16867799: '0xdcff316273000000000000000000000000000000000000000000000000000000',
        16867798: ANCESTOR,
      },
    })
    expect(r.stdout).toContain('is off-chain')
    expect(r.stdout).toContain('common ancestor at 16867798')
    expect(r.stdout).toContain('rolling raw-live back 2 block(s)')
    expect(r.sql).toContain('INSERT INTO raw_ingestion_state')
    expect(r.sql).toContain('16867798')
    expect(r.sql).toContain(ANCESTOR)
    expect(r.dockerCalls).toContain('compose restart raw-live')
  })

  it('gives up loudly instead of rolling back past the depth limit', () => {
    const r = runHeal({
      checkpoint: [16867800, FORK, 3600],
      stored: { 16867799: FORK, 16867798: FORK },
      chain: { 16867800: CANON, 16867799: CANON, 16867798: CANON },
      env: { REORG_MAX_DEPTH: '2' },
    })
    expect(r.stdout).toContain('needs a human')
    expect(r.sql).not.toContain('INSERT INTO raw_ingestion_state')
    expect(r.dockerCalls).not.toContain('restart')
  })

  it('can be switched off', () => {
    const r = runHeal({
      checkpoint: [16867800, FORK, 3600],
      stored: { 16867798: ANCESTOR },
      chain: { 16867800: CANON, 16867798: ANCESTOR },
      env: { REORG_HEAL_ENABLED: 'false' },
    })
    expect(r.sql).not.toContain('INSERT INTO raw_ingestion_state')
    expect(r.dockerCalls).not.toContain('restart')
  })
})
