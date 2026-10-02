import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { ConfigurationReader } from '../src/moonraker/config-reader.ts';
import { ConfigurationSource } from '../src/moonraker/config-source.ts';
import { AnalogSensorRegistry } from '../src/thermal/sensor-config.ts';
import { Thermistor } from '../src/thermal/thermistor.ts';
const reader = new ConfigurationReader(
  new ConfigurationSource(
    '/bench.cfg',
    { heater: { sensor_type: 'Generic 3950' } },
    [],
  ),
  null,
);
const registry = new AnalogSensorRegistry(reader),
  section = reader.section('heater'),
  results = [];
const direct = () =>
  new Thermistor(4700, 0, {
    points: [
      [25, 100000],
      [150, 1770],
      [250, 230],
    ],
  });
const expected = direct().adc(200);
for (const mode of ['direct', 'registry']) {
  const samples = [];
  for (let run = 0; run < 13; run++) {
    const start = performance.now();
    let total = 0;
    for (let i = 0; i < 10000; i++) {
      const sensor = mode === 'direct' ? direct() : registry.create(section);
      total += sensor.adc(200);
    }
    const elapsed = performance.now() - start;
    assert.ok(Math.abs(total - 10000 * expected) < 1e-8);
    if (run >= 2) samples.push(elapsed);
  }
  samples.sort((a, b) => a - b);
  results.push({ mode, medianMs: samples[5], p95Ms: samples[10] });
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      constructors: 10000,
      warmups: 2,
      samples: 11,
      results,
      scope:
        'Generic 3950 creation plus one conversion; config already parsed, calibration coefficients rebuilt each time. Not sampling-loop overhead or physical sensor accuracy.',
    },
    null,
    2,
  ),
);
