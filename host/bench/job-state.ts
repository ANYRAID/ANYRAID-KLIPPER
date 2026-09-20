import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { JobState } from '../src/moonraker/job-state.ts';
import { jobStateOracle } from '../test/helpers/job-state-oracle.ts';
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
const program = jobStateOracle();
const bench =
  program.slice(0, program.indexOf('async def main():')) +
  `
async def bench():
 global server
 values=[]
 for run in range(13):
  server=Server();server.events=[];job=JobState(Config());job.last_print_stats=dict(state='standby',filename='a',total_duration=0)
  count=0
  def send(name,*args):
   nonlocal count
   if name=='job_state:state_changed': count+=1
  server.send_event=send
  begin=time.perf_counter()
  for i in range(100000): await job._status_update({'print_stats':dict(state='paused' if i%2 else 'printing',total_duration=i+1)},0.)
  elapsed=(time.perf_counter()-begin)*1000
  assert count==100000 and str(job.last_event)=='paused'
  if run>=2: values.append(elapsed)
 print(json.dumps(sorted(values)))
asyncio.run(bench())
`;
const result = spawnSync('/usr/bin/python3', ['-c', bench], {
  encoding: 'utf8',
});
assert.equal(result.status, 0, result.stderr);
const python = JSON.parse(result.stdout) as number[];
samples.sort((a, b) => a - b);
console.log(
  JSON.stringify(
    {
      node: process.version,
      updates: count,
      warmups: 2,
      samples: 11,
      nodeTiming: { medianMs: samples[5], p95Ms: samples[10] },
      pythonTiming: { medianMs: python[5], p95Ms: python[10] },
      scope:
        'State transition kernel including validation/immutable snapshots in Node; Python original async callback with count-only event sink. No network, hardware or print-throughput claim.',
    },
    null,
    2,
  ),
);
