import assert from 'node:assert/strict';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { mkdtemp, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as immediate } from 'node:timers/promises';
import { NativeJobQueue } from '../src/moonraker/native-job-queue.ts';
import { DatabaseStore } from '../src/moonraker/database.ts';
import { PrintJournal } from '../src/operations/print-journal.ts';
import type { RpcContext } from '../src/moonraker/rpc.ts';

const root = await mkdtemp(join(tmpdir(), 'bench-native-job-queue-'));
const database = await DatabaseStore.open({ path: join(root, 'moonraker.db') });
const journal = await PrintJournal.open({ path: join(root, 'prints.db'), deviceId: 'queue-benchmark' });
const options = {
  database, journal,
  async resolveFile(filename: string) { return filename.replace('.gcode', ''); },
  canStart: () => false,
  async start() { throw new Error('Benchmark must not start a print'); },
};
let queue = await NativeJobQueue.open(options);
const context: RpcContext = { transport: 'http', signal: new AbortController().signal, authorize() { return { username: 'operator' }; }, user: { username: 'operator' } };
const names = Array.from({ length: 128 }, (_, i) => 'file-' + i + '.gcode');
const distribution = (samples: number[]) => {
  const ordered = [...samples].sort((a, b) => a - b);
  const quantile = (q: number) => ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * q))];
  return { count: samples.length, median: quantile(.5), p95: quantile(.95), p99: quantile(.99), max: ordered.at(-1)! };
};
const delay = monitorEventLoopDelay({ resolution: 1 });
const reads: number[] = [], writes: number[] = [];
let polling = true, reader: Promise<void> | undefined;
try {
  await queue.add(names, false, context);
  for (let i = 0; i < 2000; i++) queue.status;
  const full: number[] = [];
  for (let i = 0; i < 10000; i++) { const start = performance.now(); assert.equal(queue.status.queued_jobs.length, 128); full.push(performance.now() - start); }
  delay.enable();
  reader = (async () => {
    while (polling) {
      for (let i = 0; i < 128; i++) {
        const start = performance.now(), value = queue.status;
        assert(value.queued_jobs.length === 0 || value.queued_jobs.length === 128);
        reads.push(performance.now() - start);
      }
      await immediate();
    }
  })();
  for (let round = 0; round < 32; round++) {
    let start = performance.now(); await queue.remove([], true, context); writes.push(performance.now() - start);
    start = performance.now(); await queue.add(names, false, context, 'bench-round-' + round); writes.push(performance.now() - start);
  }
  polling = false; await reader; delay.disable();
  const result = {
    runtime: process.version,
    scope: 'Durable queue catalogue and concurrent status reads on this desktop filesystem; no target-board, compiled-product or motion-performance claim',
    filesystem: (await statfs(root)).type,
    jobs: 128, durableMutations: writes.length,
    fullCatalogueReadMs: distribution(full), concurrentReadMs: distribution(reads), mutationMs: distribution(writes),
    eventLoopMs: { p99: delay.percentile(99) / 1e6, max: delay.max / 1e6 },
    budgetsMs: { queryP99: 50, eventLoopP99: 50, eventLoopMax: 100 },
  };
  assert(result.concurrentReadMs.p99 < result.budgetsMs.queryP99);
  assert(result.eventLoopMs.p99 < result.budgetsMs.eventLoopP99);
  assert(result.eventLoopMs.max < result.budgetsMs.eventLoopMax);
  const ids = queue.status.queued_jobs.map(job => job.job_id);
  await queue.close(); queue = await NativeJobQueue.open(options);
  assert.deepEqual(queue.status.queued_jobs.map(job => job.job_id), ids);
  assert.equal(queue.status.queue_state, 'paused'); assert.equal(queue.diagnostics.claim, null);
  console.log(JSON.stringify({ ...result, reopenCatalogueVerified: true }, null, 2));
} finally {
  polling = false; await reader; delay.disable();
  await queue.close(); await journal.close(); await database.close(); await rm(root, { recursive: true, force: true });
}
