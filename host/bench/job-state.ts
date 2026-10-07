import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { JobState } from '../src/moonraker/job-state.ts';
import { stateReference, stateReferenceIdentity } from '../test/helpers/moonraker-state-reference.ts';
const count = 100000,
  samples = [];
for (let run = 0; run < 13; run++) {
  const job = new JobState();
  job.initialize({ state: 'standby', filename: 'a', total_duration: 0 });
  let events = 0;
  const begin = performance.now();
  for (let i = 0; i < count; i++)
    events += job.update({
      state: i % 2 ? 'paused' : 'printing',
      total_duration: i + 1,
    }).length;
  const ms = performance.now() - begin;
  assert.equal(events, count);
  assert.equal(job.lastEvent, 'paused');
  if (run >= 2) samples.push(ms);
}
const python = stateReference<number[]>('job-bench-0', '', count, samples.length);
const rawSamples = [...samples];
samples.sort((a, b) => a - b);
console.log(
  JSON.stringify(
    {
      rawSamples,
      reference: stateReferenceIdentity,
      node: process.version,
      updates: count,
      warmups: 2,
      samples: 11,
      nodeTiming: { medianMs: samples[5], p95Ms: samples[10] },
      historicalPythonTiming: { medianMs: python[5], p95Ms: python[10] },
      scope:
        'State transition kernel including validation/immutable snapshots in Node; Python original async callback with count-only event sink. No network, hardware or print-throughput claim.',
    },
    null,
    2,
  ),
);
