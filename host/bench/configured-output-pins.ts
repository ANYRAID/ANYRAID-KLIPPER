import assert from 'node:assert/strict';
import { ConfigurationReader } from '../src/moonraker/config-reader.ts';
import { ConfigurationSource } from '../src/moonraker/config-source.ts';
import { compileConfiguredOutputPins } from '../src/config/configured-output-pins.ts';
import { stepperBatchFixture } from '../test/helpers/configured-steppers.ts';
const reader = new ConfigurationReader(new ConfigurationSource('/pins.cfg', {
  'output_pin light': { pin: '!PA2', value: '1' },
  'output_pin duty': { pin: 'aux:PA3', pwm: 'true', hardware_pwm: 'true', value: '.5' },
}, []), null);
const clocks = new Map(['mcu', 'aux'].map((name) => [name, { currentPrintTime: 1, calibration: { offset: 0, frequency: 1e6 } }]));
const samples: number[] = [];
for (let run = 0; run < 10; run++) {
  // Create independent resource owners outside the measured compilation interval.
  const fixtures = Array.from({ length: 1000 }, () => stepperBatchFixture());
  const start = performance.now();
  for (const f of fixtures) {
    const plans = compileConfiguredOutputPins(reader, f.pins, f.mcus, clocks,
      [{ section: 'output_pin light' }, { section: 'output_pin duty' }]);
    assert.equal(plans.length, 2);
    assert.equal(f.pins.claimedPins.length, 2);
  }
  if (run >= 3) samples.push(performance.now() - start);
}
console.log(JSON.stringify({ node: process.version, warmups: 3, batchesPerSample: 1000,
  pinsPerBatch: 2, samplesMs: samples, medianMs: [...samples].sort((a, b) => a - b)[3],
  scope: 'Cold configuration compilation and ownership checks; excludes MCU IO and print scheduling' }, null, 2));
