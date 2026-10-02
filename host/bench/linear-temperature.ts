import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createLinearSensor } from '../src/thermal/linear-sensors.ts';
import { linearOracle } from '../test/helpers/linear-oracle.ts';
const count = 100000,
  results = [];
for (const name of ['AD595', 'PT1000']) {
  const sensor = createLinearSensor(name),
    samples: number[] = [];
  let checksum = 0;
  for (let run = 0; run < 13; run++) {
    let sum = 0;
    const begin = performance.now();
    for (let i = 0; i < count; i++)
      sum +=
        sensor.temperature(0.01 + (i % 980) / 1000) + sensor.adc(1 + (i % 350));
    const elapsed = performance.now() - begin;
    checksum = sum;
    if (run >= 2) samples.push(elapsed);
  }
  const py = spawnSync(
    '/usr/bin/python3',
    [
      '-c',
      linearOracle() +
        `
name='${name}'
points=dict(DefaultVoltageSensors+DefaultResistanceSensors)[name]
obj=(LinearResistance if name=='PT1000' else LinearVoltage)(Config({}),points)
values=[]
for run in range(13):
 total=0.;begin=time.perf_counter()
 for i in range(100000): total+=obj.calc_temp(.01+(i%980)/1000.)+obj.calc_adc(1+i%350)
 elapsed=(time.perf_counter()-begin)*1000
 if run>=2: values.append(elapsed)
print(json.dumps(dict(samples=sorted(values),checksum=total)))
`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(py.status, 0, JSON.stringify({signal:py.signal,error:py.error?.message,stderr:py.stderr}));
  const reference = JSON.parse(py.stdout);
  assert.ok(
    Math.abs(checksum - reference.checksum) <= 1e-10 * Math.abs(checksum),
  );
  samples.sort((a, b) => a - b);
  results.push({
    name,
    node: { medianMs: samples[5], p95Ms: samples[10] },
    python: { medianMs: reference.samples[5], p95Ms: reference.samples[10] },
    checksum,
  });
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      iterations: count,
      conversionsPerIteration: 2,
      warmups: 2,
      samples: 11,
      results,
      scope:
        'Conversion kernels only; original Python reverse lookup allocates breakpoint values, Node precomputes them. Not heater accuracy or hardware throughput.',
    },
    null,
    2,
  ),
);
