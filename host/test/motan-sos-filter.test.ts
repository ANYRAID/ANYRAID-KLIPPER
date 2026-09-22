import test from 'node:test';
import assert from 'node:assert/strict';
import {motanSOSFilter} from '../src/motan/sos-filter.ts';
import {sosOracle} from './helpers/motan-sos-oracle.ts';
import type {SOSCase} from './helpers/motan-sos-oracle.ts';

test('SOS forward and backward kernels match SciPy across all Motan filter families', () => {
  const source = Array.from({length: 2048}, (_, i) =>
    Math.sin(i * .017) + .25 * Math.cos(i * .731) + (i < 600 ? .7 : -.2));
  const cases: SOSCase[] = [];
  for (const mode of ['filt', 'filtfilt'] as const)
    for (const order of [1, 2, 5, 12])
      for (const kind of ['lowpass', 'highpass', 'bandpass', 'notch'] as const)
        cases.push({kind, mode, order, source, cutoff: kind === 'bandpass' ? [10, 200] : 50});
  for (const cutoff of [.01, .1, 499.9])
    for (const kind of ['lowpass', 'highpass'] as const)
      cases.push({kind, cutoff, mode: 'filtfilt', order: 5, source});
  const references = sosOracle(cases);
  for (let i = 0; i < cases.length; i++) {
    const actual = motanSOSFilter(references[i].sos, source, cases[i].mode);
    let error = 0, magnitude = 1;
    for (let j = 0; j < actual.length; j++) {
      error = Math.max(error, Math.abs(actual[j] - references[i].values[j]));
      magnitude = Math.max(magnitude, Math.abs(references[i].values[j]));
    }
    assert.ok(error <= 2e-10 * magnitude,
      `${cases[i].kind}/${cases[i].order}/${cases[i].cutoff}/${cases[i].mode}: ${error}`);
  }
});

test('SOS steady state, odd-order padding and impulse edges preserve input ownership', () => {
  const cases: SOSCase[] = [];
  for (const source of [Array(80).fill(3), Array.from({length:80}, (_,i) => i === 0 || i === 79 ? 1 : 0)])
    for (const mode of ['filt', 'filtfilt'] as const)
      cases.push({source, mode, kind:'lowpass', order:3, cutoff:40});
  const refs = sosOracle(cases);
  for (let i = 0; i < cases.length; i++) {
    const input = Float64Array.from(cases[i].source), copy = input.slice();
    const output = motanSOSFilter(refs[i].sos, input, cases[i].mode);
    assert.deepEqual(input, copy);
    refs[i].values.forEach((value,j) => assert.ok(Math.abs(value-output[j]) < 1e-12));
    assert.throws(() => motanSOSFilter(refs[i].sos, Array(12).fill(1), 'filtfilt'), /padlen 12/);
    assert.equal(motanSOSFilter(refs[i].sos, Array(13).fill(1), 'filtfilt').length,13);
  }
});

test('SOS rejects malformed, nonfinite, singular and excessive work before filtering', () => {
  const identity = [[1,0,0,1,0,0]];
  assert.deepEqual(motanSOSFilter(identity,[2],'filt'),new Float64Array([2]));
  for (const sos of [[], [[1,0,0,2,0,0]], [[1,0,0,1,NaN,0]], [[1,0,0,1]]])
    assert.throws(() => motanSOSFilter(sos,[1],'filt'), /sections|coefficients/);
  assert.throws(() => motanSOSFilter(identity,[],'filt'), /samples/);
  assert.throws(() => motanSOSFilter(identity,[Infinity],'filt'), /finite/);
  assert.throws(() => motanSOSFilter([[1,0,0,1,-1,0]],[1],'filt'), /Singular/);
  assert.throws(() => motanSOSFilter([[2,0,0,1,0,0]],[Number.MAX_VALUE],'filt'), /finite range/);
  assert.throws(() => motanSOSFilter(Array(64).fill(identity[0]), new Float64Array(1000000), 'filt'), /work limit/);
  assert.throws(() => motanSOSFilter(identity,[Number.MAX_VALUE,0,0,0,0,0,0],'filtfilt'), /finite range/);
});
