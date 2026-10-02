import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigurationReader } from '../src/moonraker/config-reader.ts';
import { loadConfiguration } from '../src/moonraker/config-source.ts';
import {
  loadLinearSensors,
  LinearSensorRegistry,
} from '../src/thermal/linear-config.ts';
async function config(
  text: string,
  run: (reader: ConfigurationReader) => void | Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), 'linear-config-'));
  try {
    const path = join(dir, 'printer.cfg');
    await writeFile(path, text);
    await run(
      new ConfigurationReader(await loadConfiguration(path, {}, null), null),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test('file configuration creates reusable custom voltage and resistance converters with heater-specific scaling', () =>
  config(
    `
[adc_temperature Voltage Test]
temperature1: 0
voltage1: 0.5
temperature2: 100
voltage2: 1.5
[adc_temperature Resistance Test]
temperature1: 0
resistance1: 100
temperature2: 100
resistance2: 200
[heater_a]
sensor_type: Voltage Test
adc_voltage: 5
voltage_offset: 0.5
[heater_b]
sensor_type: Voltage Test
adc_voltage: 2.5
voltage_offset: 0.5
[heater_c]
sensor_type: Resistance Test
pullup_resistor: 1000
`,
    (reader) => {
      const registry = loadLinearSensors(reader);
      assert.equal(registry.names.length, 10);
      const a = registry.create(reader.section('heater_a')),
        b = registry.create(reader.section('heater_b')),
        c = registry.create(reader.section('heater_c'));
      assert.equal(a.adc(100), 0.2);
      assert.equal(b.adc(100), 0.4);
      assert.equal(c.adc(100), 1 / 6);
      assert.ok(Math.abs(c.temperature(1 / 6) - 100) < 1e-10);
      assert.deepEqual(reader.validate(), []);
      assert.throws(
        () => registry.register(reader.section('adc_temperature Voltage Test')),
        /duplicate/,
      );
    },
  ));
test('incomplete or duplicate definitions and invalid electrical parameters fail without replacing valid factories', () =>
  config(
    `
[adc_temperature Broken]
temperature1: 0
voltage1: 1
temperature2: 100
[adc_temperature AD595]
temperature1: 0
voltage1: 1
temperature2: 100
voltage2: 2
[bad]
sensor_type: PT1000
pullup_resistor: 0
[unknown]
sensor_type: not-a-sensor
`,
    (reader) => {
      const registry = new LinearSensorRegistry();
      assert.throws(() =>
        registry.register(reader.section('adc_temperature Broken')),
      );
      assert.throws(
        () => registry.register(reader.section('adc_temperature AD595')),
        /duplicate/,
      );
      assert.equal(registry.names.length, 8);
      assert.throws(() => registry.create(reader.section('bad')));
      assert.throws(
        () => registry.create(reader.section('unknown')),
        /Unknown/,
      );
    },
  ));
test('sample gaps stop at first missing temperature and later fields remain visible as unused', () =>
  config(
    `
[adc_temperature Gap]
temperature1: 0
voltage1: 0
temperature2: 100
voltage2: 1
temperature4: 400
voltage4: 2
[heater]
sensor_type: Gap
`,
    (reader) => {
      const sensor = loadLinearSensors(reader).create(reader.section('heater'));
      assert.equal(sensor.adc(100), 0.2);
      assert.ok(reader.validate().some((w) => w.includes('temperature4')));
    },
  ));
test('Moonraker loader still requires server by default and generic mode is explicit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'linear-loader-'));
  try {
    const path = join(dir, 'printer.cfg');
    await writeFile(path, '[heater]\nsensor_type: PT1000\n');
    await assert.rejects(loadConfiguration(path), /No section \[server\]/);
    await assert.rejects(
      loadConfiguration(path, {}, 'extruder'),
      /No section \[extruder\]/,
    );
    const reader = new ConfigurationReader(
      await loadConfiguration(path, {}, 'heater'),
      null,
    );
    assert.equal(
      loadLinearSensors(reader).create(reader.section('heater')).adc(0),
      1000 / 5700,
    );
    assert.equal(Object.hasOwn(reader.parsed(), 'server'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
