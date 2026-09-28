import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigurationReader } from '../src/moonraker/config-reader.ts';
import { ConfigurationSource } from '../src/moonraker/config-source.ts';
import { normalizeOutputPinValue, readOutputPin } from '../src/config/output-pin.ts';
import { validateNativePrinterSections } from '../src/config/native-printer-sections.ts';
const reader = (options: Record<string, string>) => new ConfigurationReader(new ConfigurationSource('/pin.cfg', {
  'output_pin light': { pin: '!aux:PA2', ...options },
}, []), null);

test('output pin configuration preserves scaled logical startup and shutdown values', () => {
  const settings = readOutputPin(reader({ pwm: 'true', scale: '255', value: '127.5', shutdown_value: '255', hardware_pwm: 'true' }), 'output_pin light', 5);
  assert.equal(settings.initialValue, .5);
  assert.equal(settings.shutdownValue, 1);
  assert.equal(settings.cycleTime, .1);
  assert.equal(settings.pin, '!aux:PA2');
  assert.equal(settings.name, 'light');
  assert.equal(settings.hardware, true);
  assert.ok(Object.isFrozen(settings));
  assert.equal(normalizeOutputPinValue(settings, 63.75), .25);
});

test('digital defaults are binary and unused or unknown options fail before ownership', () => {
  const settings = readOutputPin(reader({}), 'output_pin light', 5);
  assert.equal(settings.initialValue, 0);
  assert.equal(settings.shutdownValue, 0);
  for (const options of [{ value: '.5' }, { shutdown_value: '.2' }, { scale: '255' }, { hardware_pwm: 'true' }, { cycle_time: '.1' }, { static_value: '1' }, { pin: ' ' }] as Record<string, string>[]) {
    assert.throws(() => readOutputPin(reader(options), 'output_pin light', 5));
  }
  for (const value of [-1, .5, 2, NaN, Infinity]) assert.throws(() => normalizeOutputPinValue(settings, value));
});

test('PWM bounds and normalization reject nonfinite, out-of-range and underflowed settings', () => {
  for (const options of [{ scale: '0' }, { scale: 'inf' }, { cycle_time: '0' }, { cycle_time: '6' }, { value: '2' }] as Record<string, string>[]) {
    assert.throws(() => readOutputPin(reader({ pwm: 'true', ...options }), 'output_pin light', 5));
  }
  assert.throws(() => readOutputPin(reader({ pwm: 'true' }), 'output_pin light', .01));
  assert.throws(() => normalizeOutputPinValue({ pwm: true, scale: Number.MAX_VALUE }, Number.MIN_VALUE), /underflows/);
  assert.equal(normalizeOutputPinValue({ pwm: true, scale: 255 }, 255), 1);
});

test('unbound output pins remain rejected by automatic native assembly', () => {
  assert.throws(() => validateNativePrinterSections(reader({})), /unsupported or unbound/);
});
