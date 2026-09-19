import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateSpectrum,welchPsd } from '../src/calibration/spectrum.ts';
import { SpectrumExecutor } from '../src/calibration/background.ts';
function samples(n=4096):Float64Array {
  return Float64Array.from({length:n*4},(_,i) => i%4===0 ? Math.floor(i/4)/1024 : Math.sin(2*Math.PI*64*Math.floor(i/4)/1024));
}
test('Welch PSD finds tone and preserves integrated signal power',() => {
  const data=Float64Array.from({length:4096},(_,i) => Math.sin(2*Math.PI*64*i/1024));
  const {frequencies,psd}=welchPsd(data,1024,512);
  const peak=psd.indexOf(Math.max(...psd));
  assert.equal(frequencies[peak],64);
  assert.ok(Math.abs(psd.reduce((a,b) => a+b,0)*2-.5)<1e-5);
  assert.ok(welchPsd(new Float64Array(512).fill(17),1024,512).psd.every(v => v===0));
});
test('invalid timestamps and samples fail before returning calibration results',() => {
  const data=samples(); data[4]=data[0];
  assert.throws(() => calculateSpectrum('x',data),/timestamps/);
  assert.throws(() => welchPsd(new Float64Array(10),1024,512),/samples/);
  assert.throws(() => welchPsd(new Float64Array(512),1024,511),/size/);
  assert.equal(calculateSpectrum('empty',new Float64Array()),null);
});
test('worker agrees with local calculation and transfers ownership',async() => {
  const executor=new SpectrumExecutor(), input=samples(), expected=calculateSpectrum('test',input);
  const pending=executor.calculate('test',input);
  assert.equal(input.byteLength,0);
  await assert.rejects(executor.calculate('busy',samples()),/busy/);
  assert.deepEqual(await pending,expected);
  assert.equal(executor.busy,false);
});
test('worker abort, timeout and failure release the slot for subsequent jobs',async() => {
  const executor=new SpectrumExecutor(), controller=new AbortController();
  const work=executor.calculate('cancel',samples(100000),{signal:controller.signal});
  controller.abort(new Error('User cancelled'));
  await assert.rejects(work,/User cancelled/);
  await assert.rejects(executor.calculate('timeout',samples(100000),{timeoutMs:1}),/timed out/);
  const invalid=samples(); invalid[10]=NaN;
  await assert.rejects(executor.calculate('invalid',invalid),/Invalid accelerometer/);
  assert.ok(await executor.calculate('recovered',samples()));
  assert.equal(executor.busy,false);
});
