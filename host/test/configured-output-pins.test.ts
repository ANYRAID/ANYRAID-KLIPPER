import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigurationReader } from '../src/moonraker/config-reader.ts';
import { ConfigurationSource } from '../src/moonraker/config-source.ts';
import { compileConfiguredOutputPins } from '../src/config/configured-output-pins.ts';
import { mcuOids } from '../src/protocol/mcu-oids.ts';
import { stepperBatchFixture } from './helpers/configured-steppers.ts';
const reader = (sections: Record<string, Record<string, string>>) => new ConfigurationReader(new ConfigurationSource('/pins.cfg', sections, []), null);
const clocks = () => new Map([['mcu', { currentPrintTime: 1, calibration: { offset: 0, frequency: 1000000.5 } }], ['aux', { currentPrintTime: 3, calibration: { offset: 2, frequency: 1e6 } }]]);

test('digital and hardware PWM compile independent MCU ownership and inverted defaults', () => {
  const f = stepperBatchFixture();
  const result = compileConfiguredOutputPins(reader({ 'output_pin light': { pin: '!PA2', value: '1' },
    'output_pin duty': { pin: 'aux:PA3', pwm: 'true', hardware_pwm: 'true', scale: '255', value: '127.5', shutdown_value: '63.75' },
  }), f.pins, f.mcus, clocks(), [{ section: 'output_pin light' }, { section: 'output_pin duty' }]);
  assert.equal(result[0].output.kind, 'digital');
  if (result[0].output.kind === 'digital') assert.match(result[0].output.config.config, /value=0 default_value=1 max_duration=0$/);
  assert.equal(result[1].output.kind, 'pwm');
  if (result[1].output.kind === 'pwm') {
    assert.equal(result[1].output.config.cycleTicks, 100000);
    assert.match(result[1].output.config.commands[0], /value=127 default_value=63 max_duration=0$/);
  }
  assert.equal(mcuOids(f.pins).snapshot('mcu').oidCount, 1);
  assert.equal(mcuOids(f.pins).snapshot('aux').oidCount, 1);
  assert.equal(f.pins.claimedPins.length, 2);
});

test('physical alias conflict rolls back the entire batch and permits correction', () => {
  const f = stepperBatchFixture();
  const compile = (second: string) => compileConfiguredOutputPins(reader({ 'output_pin a': { pin: 'PA3' }, 'output_pin b': { pin: second } }),
    f.pins, f.mcus, clocks(), [{ section: 'output_pin a' }, { section: 'output_pin b' }]);
  assert.throws(() => compile('PA3_ALIAS'), /used multiple times/);
  assert.equal(f.pins.claimedPins.length, 0);
  assert.equal(mcuOids(f.pins).snapshot('mcu').oidCount, 0);
  assert.equal(compile('PA2')[1].output.config.oid, 1);
});

test('software PWM fraction shutdown and reserved pins fail without consuming resources', () => {
  for (const options of [{ pin: 'PA2', pwm: 'true', shutdown_value: '.5' }, { pin: 'PA3_ALIAS' }, { pin: 'PA2', pwm: 'true', cycle_time: '3.1' }] as Record<string, string>[]) {
    const f = stepperBatchFixture(true);
    assert.throws(() => compileConfiguredOutputPins(reader({ 'output_pin a': options }), f.pins, f.mcus, clocks(), [{ section: 'output_pin a' }]));
    assert.equal(f.pins.claimedPins.length, 0);
    assert.equal(mcuOids(f.pins).snapshot('mcu').oidCount, 0);
  }
});
