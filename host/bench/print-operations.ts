import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { PrintController, type PrintDevice } from '../src/operations/print.ts';
const root = resolve(import.meta.dirname, '../..'),
  dir = mkdtempSync(join(tmpdir(), 'print-operation-bench-'));
try {
  const path = join(dir, 'baseline.mts');
  writeFileSync(
    path,
    execFileSync('git', ['show', 'aab05679:host/src/operations/print.ts'], {
      cwd: root,
    }),
  );
  const baseline = (await import(pathToFileURL(path).href))
    .PrintController as typeof PrintController;
  const results = [];
  const jobs = 2000;
  for (const [name, Controller] of [
    ['baseline', baseline],
    ['deadlines', PrintController],
  ] as const) {
    const samples: number[] = [];
    for (let run = 0; run < 13; run++) {
      let calls = 0;
      const effect = async () => {
        calls++;
      };
      const device: PrintDevice = {
        prepare: effect,
        start: effect,
        pause: effect,
        resume: effect,
        stop: effect,
      };
      const start = performance.now();
      for (let i = 0; i < jobs; i++) {
        const controller = new Controller(device, {
          maxNozzle: 280,
          maxBed: 110,
        });
        await controller.start({
          version: 1,
          requestId: 'job',
          fileId: 'file',
          nozzle: 210,
          bed: 60,
        });
        await controller.pause();
        await controller.resume();
        await controller.cancel();
        assert.equal(controller.state, 'cancelled');
      }
      const elapsed = performance.now() - start;
      assert.equal(calls, jobs * 5);
      if (run >= 2) samples.push(elapsed);
    }
    samples.sort((a, b) => a - b);
    results.push({
      name,
      medianMs: samples[5],
      p95Ms: samples[10],
      microsecondsPerOperation: (samples[5] * 1000) / (jobs * 4),
    });
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        baseline: 'aab05679',
        jobsPerSample: jobs,
        operationsPerJob: 4,
        samples: 11,
        warmups: 2,
        scope:
          'Resolved simulated device ACKs; complete start/pause/resume/cancel lifecycle with equal call counts. Measures controller overhead, not heater, motion, serial latency or hardware safety.',
        results,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
