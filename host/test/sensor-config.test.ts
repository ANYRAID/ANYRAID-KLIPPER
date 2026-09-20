import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigurationReader } from '../src/moonraker/config-reader.ts';
import {
  ConfigurationSource,
  loadConfiguration,
} from '../src/moonraker/config-source.ts';
import { AnalogSensorRegistry } from '../src/thermal/sensor-config.ts';
import { Thermistor } from '../src/thermal/thermistor.ts';
import { resolve } from 'node:path';
const reader = (sections: Record<string, Record<string, string>>) =>
  new ConfigurationReader(
    new ConfigurationSource('/test.cfg', sections, []),
    null,
  );
test('actual default sensor file loads all eight thermistors alongside linear converters', async () => {
  const source = await loadConfiguration(
    resolve(import.meta.dirname, '../../klippy/extras/temperature_sensors.cfg'),
    {},
    null,
  );
  const config = new ConfigurationReader(source, null),
    registry = new AnalogSensorRegistry(config);
  assert.equal(registry.names.length, 16);
  for (const name of registry.names) {
    const heater = reader({ heater: { sensor_type: name } });
    const sensor = registry.create(heater.section('heater'));
    assert.ok(Number.isFinite(sensor.adc(100)));
  }
});
test('custom beta and shuffled three-point thermistors honor per-heater circuit settings', () => {
  const config = reader({
    'thermistor Beta': {
      temperature1: '25',
      resistance1: '100000',
      beta: '3950',
    },
    'thermistor Three': {
      temperature1: '300',
      resistance1: '80.65',
      temperature2: '20',
      resistance2: '126800',
      temperature3: '150',
      resistance3: '1360',
    },
    heater: {
      sensor_type: 'Beta',
      pullup_resistor: '10000',
      inline_resistor: '50',
    },
    other: { sensor_type: 'Three' },
  });
  const registry = new AnalogSensorRegistry(config),
    actual = registry.create(config.section('heater'));
  const expected = new Thermistor(10000, 50, {
    point: [25, 100000],
    beta: 3950,
  });
  for (let t = 0; t < 350; t++) assert.equal(actual.adc(t), expected.adc(t));
  assert.ok(
    Math.abs(
      registry
        .create(config.section('other'))
        .temperature(126800 / (126800 + 4700)) - 20,
    ) < 1e-9,
  );
  assert.deepEqual(config.validate(), []);
});
test('custom thermistors can override defaults but cannot collide with linear names or invalid coefficients', () => {
  const config = reader({
    'thermistor Generic 3950': {
      temperature1: '25',
      resistance1: '100000',
      beta: '4100',
    },
    heater: { sensor_type: 'Generic 3950' },
  });
  const sensor = new AnalogSensorRegistry(config).create(
    config.section('heater'),
  );
  assert.equal(
    sensor.adc(200),
    new Thermistor(4700, 0, { point: [25, 100000], beta: 4100 }).adc(200),
  );
  for (const section of ['thermistor AD595', 'thermistor Custom'])
    assert.throws(
      () =>
        new AnalogSensorRegistry(
          reader({
            [section]: { temperature1: '25', resistance1: '0', beta: '3950' },
          }),
        ),
    );
  assert.throws(
    () =>
      new AnalogSensorRegistry(
        reader({
          'thermistor Bad': {
            temperature1: '25',
            resistance1: '100000',
            beta: '0',
          },
        }),
      ),
  );
});
import { execFileSync, spawnSync } from 'node:child_process';
test('default registry temperature and ADC sweeps match pinned Python calibration definitions', () => {
  const source = execFileSync(
    'git',
    ['show', '2a3d4b70:klippy/extras/thermistor.py'],
    { cwd: resolve(import.meta.dirname, '../..') },
  )
    .toString()
    .replace('from . import adc_temperature', '');
  const definitions = execFileSync(
    'git',
    ['show', '2a3d4b70:klippy/extras/temperature_sensors.cfg'],
    { cwd: resolve(import.meta.dirname, '../..') },
  );
  const py = spawnSync(
    '/usr/bin/python3',
    [
      '-c',
      `import base64,configparser,json
exec(base64.b64decode('${Buffer.from(source).toString('base64')}'))
c=configparser.ConfigParser();c.read_string(base64.b64decode('${definitions.toString('base64')}').decode())
result={}
for section in c.sections():
 if not section.startswith('thermistor '):continue
 p={k:float(v) for k,v in c[section].items()};t=Thermistor(4700.,0.)
 if 'beta' in p:t.setup_coefficients_beta(p['temperature1'],p['resistance1'],p['beta'])
 else:t.setup_coefficients(*[p[k+str(i)] for i in (1,2,3) for k in ('temperature','resistance')])
 result[section[11:]]=[[t.calc_adc(i) for i in range(351)],[t.calc_temp(.01+i*.001) for i in range(980)]]
print(json.dumps(result))
`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(py.status, 0, py.stderr);
  const expected = JSON.parse(py.stdout),
    registry = new AnalogSensorRegistry(reader({}));
  for (const [name, rows] of Object.entries(expected) as [
    string,
    number[][],
  ][]) {
    const converter = registry.create(
      reader({ heater: { sensor_type: name } }).section('heater'),
    );
    const values = [
      Array.from({ length: 351 }, (_, i) => converter.adc(i)),
      Array.from({ length: 980 }, (_, i) =>
        converter.temperature(0.01 + i * 0.001),
      ),
    ];
    values.forEach((row, i) =>
      row.forEach((v, j) =>
        assert.ok(Math.abs(v - rows[i][j]) < 1e-8 + Math.abs(v) * 1e-11, name),
      ),
    );
  }
});
test('linear names cannot silently shadow default thermistors', () => {
  assert.throws(
    () =>
      new AnalogSensorRegistry(
        reader({
          'adc_temperature Generic 3950': {
            temperature1: '0',
            voltage1: '0',
            temperature2: '100',
            voltage2: '1',
          },
        }),
      ),
    /collides/,
  );
});
