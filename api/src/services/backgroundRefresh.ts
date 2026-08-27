import { refreshProxyMultisig } from './proxyMultisigService.ts'
import { refreshLockBreakdowns } from './lockBreakdownService.ts'

// Coordinated scheduler for the background refreshers that read node-full
// (chain-state enumeration). Previously each ran on its own independent
// setInterval, so their phases could align and stack concurrent RPC bursts on
// the one archive node. Here they share a single timer and run SEQUENTIALLY, so
// node-full only ever sees one refresh lane, and the cadence is fast enough that
// a just-changed balance (a claimed vesting tranche, a vote lock removed) shows
// within a minute.
//
// ClickHouse-only refreshers (the account-directory prewarm, tag syncs,
// asset/identity caches) are intentionally NOT routed through here: they never
// touch node-full, are already well spaced, and share no scarce resource —
// coordinating them would add coupling with no contention to resolve.

export interface RefreshTask {
  name: string
  // Run every Nth base tick: 1 = every 60s, 3 = every 180s.
  everyTicks: number
  run: () => Promise<void>
}

const BASE_TICK_MS = 60_000

const TASKS: RefreshTask[] = [
  { name: 'proxy-multisig', everyTicks: 1, run: refreshProxyMultisig },
  { name: 'lock-breakdown', everyTicks: 1, run: refreshLockBreakdowns },
]

// Tasks due on a given 1-based tick number (exported for testing the cadence).
export function dueTasks(tickNumber: number, tasks: RefreshTask[] = TASKS): RefreshTask[] {
  return tasks.filter(t => tickNumber % t.everyTicks === 0)
}

let timer: ReturnType<typeof setInterval> | null = null
let tickInFlight = false
let tick = 0

// Run the given tasks one after another (never concurrently), each isolated so
// one failure or slow RPC cannot abort the batch, holding `tickInFlight` for the
// whole batch so no other batch (including a tick overlapping the cold initial
// pass) can start alongside it. Per-service single-flight guards make each run
// idempotent even so.
function runGuardedBatch(tasks: RefreshTask[]): Promise<void> {
  tickInFlight = true
  return (async () => {
    for (const task of tasks) {
      try {
        await task.run()
      } catch (err) {
        console.error(`[refresh] ${task.name} failed`, err)
      }
    }
  })().finally(() => { tickInFlight = false })
}

export function startBackgroundRefresh(): void {
  if (timer) return
  // Initial pass: every task once at startup, sequentially, off the boot path.
  void runGuardedBatch(TASKS)
  timer = setInterval(() => {
    // Skip this tick entirely if a batch is still running (a stalled RPC must
    // not let ticks pile up); the counter only advances when a batch starts, so
    // "every Nth tick" counts run-ticks and the cadence just slips, never stacks.
    if (tickInFlight) return
    tick += 1
    const due = dueTasks(tick)
    if (due.length) void runGuardedBatch(due)
  }, BASE_TICK_MS)
  timer.unref?.()
}

export function stopBackgroundRefresh(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
  tick = 0
  tickInFlight = false
}
