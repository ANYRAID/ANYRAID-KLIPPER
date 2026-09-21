import test from 'node:test';
import assert from 'node:assert/strict';
import {MCUGroup} from '../src/runtime/mcu-group.ts';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {settle} from './helpers/clock-scheduler.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
async function fixture(run:(g:MCUGroup,s:SerialSession[],stops:number[])=>Promise<void>){const fw=await Promise.all([serialFirmware(),serialFirmware()]),s:SerialSession[]=[],stops=[0,0];const g=new MCUGroup(fw.map((f,i)=>({id:'m'+i,async connect(signal,stopDevice){const v=new SerialSession(f.fd,{stopDevice});s[i]=v;await v.initialize(signal);return v;},async stopDevice(){stops[i]++;}})));try{await g.start(new AbortController().signal);await run(g,s,stops);}finally{await g.stop();await Promise.all(fw.map(f=>f.close()));}}
const signal=()=>new AbortController().signal;
test('real native sessions wait for future sampled clocks on both MCUs after ACK snapshots',async()=>fixture(async(g,s,stops)=>{const targets={m0:s[0].clock.sync.lastClock+100000n,m1:s[1].clock.sync.lastClock+200000n};await g.waitForMotionClocks(targets,signal(),3000);assert.ok(s[0].clock.sync.lastClock>targets.m0);assert.ok(s[1].clock.sync.lastClock>targets.m1);assert.equal(g.status.state,'ready');assert.deepEqual(stops,[0,0]);}));
test('invalid partial boundaries and pre-cancellation do not stop a healthy group',async()=>fixture(async(g,s,stops)=>{await assert.rejects(g.waitForMotionClocks({m0:1n},signal()),/every MCU/);await assert.rejects(g.waitForMotionClocks({m0:1n,m1:-1n},signal()),/valid ticks/);await assert.rejects(g.waitForMotionClocks({m0:1n,m1:1n},AbortSignal.abort(new Error('cancel'))),/cancel/);assert.equal(g.status.state,'ready');assert.deepEqual(stops,[0,0]);}));
test('in-progress cancellation and timeout stop every MCU exactly once',async()=>{for(const mode of ['cancel','timeout'])await fixture(async(g,s,stops)=>{const c=new AbortController(),targets={m0:s[0].clock.sync.lastClock+100000000n,m1:s[1].clock.sync.lastClock+100000000n};const result=assert.rejects(g.waitForMotionClocks(targets,c.signal,mode==='timeout'?20:3000),/cancel|timed out/);if(mode==='cancel')c.abort(new Error('cancel boundary'));await result;assert.deepEqual(stops,[1,1]);assert.equal(g.status.state,'stopped');assert.ok(s.every(v=>v.status.state==='closed'));});});
test('an already-passed clock never bypasses a native scheduled command ACK',async()=>fixture(async(g,s,stops)=>{
 await s[0].configure({oidCount:4,commands:[]},signal());const queue=g.commandQueue('m0'),release=s[0].clock.sync.getClock(serialClock.now()+.2),payload=s[0].dictionary.encode('update_digital_out',{oid:3,value:0});
 const sending=queue.send(payload,release,release,signal());assert.ok(s[0].status.pendingAcks>0);let complete=false;
 const boundary=g.waitForMotionClocks({m0:1n,m1:1n},signal(),3000).then(()=>{complete=true;});await settle();assert.equal(complete,false);await Promise.all([sending,boundary]);assert.equal(complete,true);assert.equal(s[0].status.pendingAcks,0);assert.deepEqual(stops,[0,0]);
}));
test('the shared deadline expires while waiting for ACKs and rejects the outstanding native send',async()=>fixture(async(g,s,stops)=>{
 await s[0].configure({oidCount:4,commands:[]},signal());const queue=g.commandQueue('m0'),release=s[0].clock.sync.getClock(serialClock.now()+10),payload=s[0].dictionary.encode('update_digital_out',{oid:3,value:0});
 const sending=assert.rejects(queue.send(payload,release,release,signal()),/timed out|closed|ready/);assert.ok(s[0].status.pendingAcks>0);await assert.rejects(g.waitForMotionClocks({m0:1n,m1:1n},signal(),20),/timed out/);await sending;assert.equal(g.status.state,'stopped');assert.deepEqual(stops,[1,1]);assert.ok(s.every(v=>v.status.pendingAcks===0&&v.status.state==='closed'));
}));
