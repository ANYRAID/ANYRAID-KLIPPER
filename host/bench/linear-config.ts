import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { ConfigurationReader } from '../src/moonraker/config-reader.ts';
import { ConfigurationSource } from '../src/moonraker/config-source.ts';
import { loadLinearSensors } from '../src/thermal/linear-config.ts';
import { LinearVoltage } from '../src/thermal/linear.ts';
const reader = new ConfigurationReader(
    new ConfigurationSource(
      '/benchmark.cfg',
      {
        'adc_temperature Custom': {
          temperature1: '0',
          voltage1: '.5',
          temperature2: '100',
          voltage2: '1.5',
        },
        heater: {
          sensor_type: 'Custom',
          adc_voltage: '5',
          voltage_offset: '.5',
        },
      },
      [],
    ),
    null,
  ),
  registry = loadLinearSensors(reader),
  section = reader.section('heater');
const results = [];
for (const mode of ['direct', 'configuration']) {
  const samples = [];
  for (let run = 0; run < 13; run++) {
    let sum = 0;
    const start = performance.now();
    for (let i = 0; i < 10000; i++) {
      const sensor =
        mode === 'direct'
          ? new LinearVoltage(
              [
                [0, 0.5],
                [100, 1.5],
              ],
              5,
              0.5,
            )
          : registry.create(section);
      sum += sensor.temperature(0.2);
    }
    const elapsed = performance.now() - start;
    assert.equal(sum, 1000000);
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
        'Configuration-time creation versus direct converter creation. Existing parsed INI source; no file IO, MCU or sampling-loop work.',
    },
    null,
    2,
  ),
);
