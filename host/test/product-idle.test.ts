import test from 'node:test';
import assert from 'node:assert/strict';
import {ProductIdleTimeout,readProductIdleTimeout} from '../src/operations/product-idle.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
function fixture(expire?:()=>Promise<void>){let now=0,key='idle',busy=false,printing=false,calls=0,error:unknown;const timers=new Map<()=>void,number>();const owner=new ProductIdleTimeout(3,{now:()=>now,schedule(fn,delay){timers.set(fn,now+delay);return ()=>{timers.delete(fn);};}},()=>({busy,printing,key}),async()=>{calls++;await expire?.();},e=>{error=e;});return {owner,timers,get calls(){return calls;},get error(){return error;},state(next:string,active=false){key=next;busy=printing=active;},async advance(to:number){now=to;for(const [fn,time] of [...timers])if(time<=now){timers.delete(fn);fn();}await new Promise(resolve=>setImmediate(resolve));}};}
test('idle timeout is one-shot, resets on activity and never expires during printing',async()=>{
 const f=fixture();await f.advance(2);assert.equal(f.calls,0);await f.advance(3);assert.equal(f.calls,1);assert.equal(f.owner.status.state,'Idle');await f.advance(20);assert.equal(f.calls,1);
 f.state('printing',true);await f.advance(21);assert.equal(f.owner.status.state,'Printing');await f.advance(100);assert.equal(f.calls,1);f.state('completed');await f.advance(101);await f.advance(103);assert.equal(f.calls,1);await f.advance(104);assert.equal(f.calls,2);f.owner.close();assert.equal(f.timers.size,0);
});
test('pending expiry is not duplicated and close fences late completion',async()=>{
 const held=Promise.withResolvers<void>(),f=fixture(()=>held.promise);await f.advance(3);await f.advance(30);assert.equal(f.calls,1);assert.equal(f.timers.size,0);f.owner.close();held.resolve();await f.advance(40);assert.equal(f.timers.size,0);assert.equal(f.owner.status.closed,true);
});
test('failed expiry faults once and removes the timer',async()=>{const f=fixture(async()=>{throw new Error('off failed');});await f.advance(3);assert.match(String(f.error),/off failed/);assert.equal(f.timers.size,0);assert.equal(f.owner.status.closed,true);});
test('idle configuration defaults to 600 seconds and rejects arbitrary macros',()=>{
 const read=(sections:Record<string,Record<string,string>>)=>readProductIdleTimeout(new ConfigurationReader(new ConfigurationSource('/idle.cfg',sections,[]),null));assert.equal(read({}),600);assert.equal(read({idle_timeout:{timeout:'120'}}),120);for(const options of [{timeout:'0'},{timeout:'nan'},{gcode:'M84'}] as Record<string,string>[])assert.throws(()=>read({idle_timeout:options}));
});
