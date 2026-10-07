import test from 'node:test';
import assert from 'node:assert/strict';
import {ClockSync} from '../src/timing/clock-sync.ts';
import {captureClockSamples} from './helpers/clock-sample-diagnostic.ts';

test('raw estimator observation preserves unknown timestamps, outliers and exact replay',t=>{
 const samples=captureClockSamples(t.mock),sync=new ClockSync(1e6,1000000n,10);
 const input=[{clock32:1051000,sentTime:10.05,receiveTime:10.052},{clock32:1101000,sentTime:10.1,receiveTime:10.102},{clock32:1110000,sentTime:0,receiveTime:10.11},{clock32:1250000,sentTime:10.15,receiveTime:10.251}];
 const result=input.map((sample,i)=>sync.accept(sample,i<2));
 assert.equal(result[2],null);assert.equal(result[3],null);
 const capture=samples.snapshot([{id:'aux',sync}])[0];assert.equal(capture.count,4);assert.equal(capture.warmup!.length,2);assert.equal(capture.recent!.length,2);
 assert.equal(capture.recent![0].sample.sentTime,0);assert.equal(capture.recent![1].sample.sentTime,10.15);
 assert.deepEqual(capture.recent![1].before,capture.recent![1].after);
 t.mock.restoreAll();
 const replay=new ClockSync(capture.initial!.frequency,capture.initial!.uptimeClock,capture.initial!.sentTime);
 for(const row of [...capture.warmup!,...capture.recent!]){assert.deepEqual(replay.accept(row.sample,row.warmup),row.release);assert.deepEqual(replay.estimate,row.after);assert.equal(replay.revision,row.revision);}
 assert.deepEqual(replay.estimate,sync.estimate);assert.equal(replay.lastClock,sync.lastClock);
 capture.recent![0].sample.clock32=0;assert.equal(samples.snapshot([{id:'aux',sync}])[0].recent![0].sample.clock32,1110000);
});

test('warmup retention and recent ring stay bounded independently for physical clocks',t=>{
 const samples=captureClockSamples(t.mock),bindings=['mcu','aux'].map(id=>({id,sync:new ClockSync(1e6,0n,10)}));
 for(let i=1;i<=80;i++)for(const {sync} of bindings)sync.accept({clock32:i*1000000,sentTime:10+i,receiveTime:10+i+.002},i<=8);
 const captured=samples.snapshot(bindings);for(const row of captured){assert.equal(row.count,80);assert.equal(row.warmup!.length,8);assert.equal(row.recent!.length,32);assert.equal(row.recent![0].revision,49);assert.equal(row.recent!.at(-1)!.revision,80);}
 assert.deepEqual(captured.map(row=>row.id),['mcu','aux']);
});
