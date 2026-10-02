import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  LinearInterpolate,
  LinearVoltage,
  LinearResistance,
} from '../src/thermal/linear.ts';
import { ADCTemperature } from '../src/thermal/adc.ts';
import { linearOracle } from './helpers/linear-oracle.ts';
test('linear voltage and resistance match pinned Python forward and inverse samples', () => {
  const cases = [];
  for (const mode of ['voltage', 'resistance'])
    for (const direction of [1, -1])
      for (const offset of [0, 0.2]) {
        const samples = Array.from({ length: 12 }, (_, i) => [
          direction * (i * 25 + 3 * i * i),
          mode === 'voltage' ? 0.3 + i * 0.35 : 100 + i * 75 + i * i * 5,
        ]);
        cases.push({
          mode,
          samples,
          config: {
            adc_voltage: 5,
            voltage_offset: offset,
            pullup_resistor: 4700,
          },
          adcs: Array.from({ length: 101 }, (_, i) => i / 100),
          temps: Array.from(
            { length: 200 },
            (_, i) => direction * (i * 3 - 20),
          ),
        });
      }
  const py = spawnSync(
    '/usr/bin/python3',
    [
      '-c',
      linearOracle() +
        `
results=[]
for c in json.load(sys.stdin):
 obj=(LinearVoltage if c['mode']=='voltage' else LinearResistance)(Config(c['config']),c['samples'])
 results.append([[obj.calc_temp(a) for a in c['adcs']],[obj.calc_adc(t) for t in c['temps']]])
print(json.dumps(results))
`,
    ],
    { input: JSON.stringify(cases), encoding: 'utf8' },
  );
  assert.equal(py.status, 0, py.stderr);
  const expected = JSON.parse(py.stdout);
  cases.forEach((c, n) => {
    const points = c.samples as [number, number][];
    const converter =
      c.mode === 'voltage'
        ? new LinearVoltage(points, 5, c.config.voltage_offset)
        : new LinearResistance(points, 4700);
    const actual = [
      c.adcs.map((a) => converter.temperature(a)),
      c.temps.map((t) => converter.adc(t)),
    ];
    actual.forEach((row, i) =>
      row.forEach((v, j) =>
        assert.ok(
          Math.abs(v - expected[n][i][j]) <= 1e-10 + Math.abs(v) * 1e-12,
          `${n}/${i}/${j}`,
        ),
      ),
    );
  });
});
test('linear boundaries, calibration rejection and existing ADC callback integration', () => {
  const curve = new LinearInterpolate([
    [2, 20],
    [0, 0],
    [1, 10],
    [3, 40],
  ]);
  assert.equal(curve.interpolate(2), 25);
  assert.equal(curve.reverse(20), 25 / 15);
  assert.equal(curve.interpolate(-1), -10);
  for (const samples of [
    [[0, 1]],
    [
      [0, 1],
      [0, 2],
    ],
    [
      [0, 1],
      [1, 1],
    ],
    [
      [0, 1],
      [1, 3],
      [2, 2],
    ],
  ])
    assert.throws(() => new LinearInterpolate(samples as [number, number][]));
  assert.throws(() => curve.interpolate(Infinity));
  assert.throws(() => curve.reverse(NaN));
  const voltage = new LinearVoltage(
    [
      [0, 0],
      [100, 1],
      [200, 2],
      [300, 8],
    ],
    5,
  );
  assert.equal(voltage.ignoredSamples, 1);
  const readings: number[] = [];
  const adc = new ADCTemperature(
    voltage,
    0,
    200,
    (_time, temp) => readings.push(temp),
    () => assert.fail('unexpected sensor fault'),
  );
  adc.receive([[1, 0.2]]);
  assert.deepEqual(readings, [100]);
  const resistance = new LinearResistance([
    [0, 100],
    [100, 200],
  ]);
  assert.ok(Number.isFinite(resistance.temperature(0)));
  assert.ok(Number.isFinite(resistance.temperature(1)));
});
import {
  createLinearSensor,
  linearSensorNames,
} from '../src/thermal/linear-sensors.ts';
test('all eight built-in linear sensor tables match Python over ADC and temperature sweeps', () => {
  const result = spawnSync(
    '/usr/bin/python3',
    [
      '-c',
      linearOracle() +
        `
result={}
for name,points in DefaultVoltageSensors+DefaultResistanceSensors:
 obj=(LinearResistance if name=='PT1000' else LinearVoltage)(Config({}),points)
 result[name]=[[obj.calc_temp(i/1000.) for i in range(1001)],[obj.calc_adc(i) for i in range(1,351)]]
print(json.dumps(result))
`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const expected = JSON.parse(result.stdout);
  assert.deepEqual([...linearSensorNames].sort(), Object.keys(expected).sort());
  for (const name of linearSensorNames) {
    const sensor = createLinearSensor(name);
    const rows = [
      Array.from({ length: 1001 }, (_, i) => sensor.temperature(i / 1000)),
      Array.from({ length: 350 }, (_, i) => sensor.adc(i + 1)),
    ];
    rows.forEach((row, i) =>
      row.forEach((v, j) =>
        assert.ok(
          Math.abs(v - expected[name][i][j]) < 1e-9 + 1e-12 * Math.abs(v),
          name + ':' + i + ':' + j,
        ),
      ),
    );
  }
});
test('coalesced segments preserve upstream knot selection', () => {
  const samples: [
    [number, number],
    [number, number],
    [number, number],
    [number, number],
  ] = [
    [0, 0],
    [1, 10],
    [2, 20],
    [3, 40],
  ];
  const py = spawnSync(
    '/usr/bin/python3',
    [
      '-c',
      linearOracle() +
        `\nli=LinearInterpolate(${JSON.stringify(samples)});print(json.dumps([li.interpolate(2),li.reverse_interpolate(20)]))`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(py.status, 0, py.stderr);
  const curve = new LinearInterpolate(samples);
  assert.deepEqual(
    [curve.interpolate(2), curve.reverse(20)],
    JSON.parse(py.stdout),
  );
});
