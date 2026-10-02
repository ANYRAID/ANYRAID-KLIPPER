import assert from 'node:assert/strict';
import { ConfigurationReader } from '../src/moonraker/config-reader.ts';
import { ConfigurationSource } from '../src/moonraker/config-source.ts';
import { readOutputPin, normalizeOutputPinValue } from '../src/config/output-pin.ts';
const reader = new ConfigurationReader(new ConfigurationSource('/pin.cfg', {
  'output_pin light': { pin: '!PA2', pwm: 'true', scale: '255', value: '127.5' },
}, []), null);
const settings = readOutputPin(reader, 'output_pin light', 5);
const samples: { configMs: number; valuesMs: number }[] = [];
for (let run = 0; run < 10; run++) {
  let sum = 0;
  const start = performance.now();
  for (let i = 0; i < 10000; i++) sum += readOutputPin(reader, 'output_pin light', 5).initialValue;
  const configMs = performance.now() - start;
  assert.equal(sum, 5000);
  sum = 0;
  const valueStart = performance.now();
  for (let i = 0; i < 1000000; i++) sum += normalizeOutputPinValue(settings, (i & 1) ? 255 : 0);
  const valuesMs = performance.now() - valueStart;
  assert.equal(sum, 500000);
  if (run >= 3) samples.push({ configMs, valuesMs });
}
console.log(JSON.stringify({ node: process.version, warmups: 3, configIterations: 10000,
  valueIterations: 1000000, samples,
  medianConfigMs: samples.map((s) => s.configMs).sort((a, b) => a - b)[3],
  medianValuesMs: samples.map((s) => s.valuesMs).sort((a, b) => a - b)[3],
  scope: 'Settings and logical value normalization only, no MCU IO or print scheduling' }, null, 2));
