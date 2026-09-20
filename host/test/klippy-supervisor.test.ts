import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {KlippySupervisor} from '../src/moonraker/klippy-supervisor.ts';
async function until(fn:()=>boolean){for(let i=0;i<500;i++){if(fn())return;await delay(2);}throw new Error('Condition timed out');}
test('supervisor retries failures serially, waits for disconnect and stops retry timers',async()=>{
 let calls=0,active=0,maxActive=0;const connections:AbortController[]=[],supervisor=new KlippySupervisor(async()=>{calls++;maxActive=Math.max(maxActive,++active);try{await delay(2);if(calls<3)throw new Error('Unavailable');const c=new AbortController();connections.push(c);return c.signal;}finally{active--;}},async()=>{for(const c of connections)c.abort();},5);
 supervisor.start();assert.equal(calls,0);await until(()=>supervisor.status.phase==='connected');assert.equal(calls,3);assert.equal(maxActive,1);assert.equal(supervisor.status.failures,2);assert.equal(supervisor.status.lastError,undefined);await delay(15);assert.equal(calls,3);connections[0].abort();await until(()=>supervisor.status.connections===2);await supervisor.stop();const stopped=calls;await delay(15);assert.equal(calls,stopped);assert.equal(supervisor.status.phase,'stopped');assert.throws(()=>supervisor.start());
});
test('supervisor stop interrupts and waits for the in-flight adapter',async()=>{
 let finish!:(signal:AbortSignal)=>void,closed=0;const gate=new Promise<AbortSignal>(resolve=>finish=resolve),supervisor=new KlippySupervisor(()=>gate,async()=>{closed++;const c=new AbortController();c.abort();finish(c.signal);},1);supervisor.start();await until(()=>supervisor.status.phase==='connecting');await supervisor.stop();assert.equal(closed,1);assert.equal(supervisor.status.connections,0);assert.equal(supervisor.status.failures,0);assert.equal(supervisor.status.phase,'stopped');await supervisor.stop();assert.equal(closed,1);
});
test('failed generation drain remains observable and stop can retry',async()=>{
 let closes=0;const supervisor=new KlippySupervisor(async()=>new AbortController().signal,async()=>{if(++closes===1)throw new Error('Drain failed');},1);supervisor.start();await until(()=>supervisor.status.phase==='connected');await assert.rejects(supervisor.stop(),/Drain failed/);assert.equal(supervisor.status.phase,'stopping');await supervisor.stop();assert.equal(supervisor.status.phase,'stopped');for(const interval of [0,-1,0.5,60001,NaN])assert.throws(()=>new KlippySupervisor(async()=>new AbortController().signal,async()=>{},interval));
});
