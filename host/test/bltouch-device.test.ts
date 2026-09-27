import test from 'node:test';
import assert from 'node:assert/strict';
import {BLTouchDevice,type BLTouchSettings,type BLTouchDevicePort,type BLTouchSample} from '../src/homing/bltouch-device.ts';
import {BLTOUCH_COMMANDS} from '../src/homing/bltouch-command.ts';
import {collectProbeSamples} from '../src/homing/probe-samples.ts';
const settings:BLTouchSettings={pinMoveTime:.68,stowOnEachSample:true,touchMode:false,pinUpNotTriggered:true,pinUpTouchTriggered:true,outputMode:null};
const signal=()=>new AbortController().signal;
function fixture(options:Partial<BLTouchSettings>={}){
 let time=1,stops=0;const commands:string[]=[],verification:Parameters<BLTouchDevicePort['verifyState']>[0][]=[],results:boolean[]=[];
 const port:BLTouchDevicePort={clockAt:t=>BigInt(Math.trunc(t*1e6)),secondsToClock:t=>BigInt(Math.trunc(t*1e6)),printAt:c=>Number(c)/1e6,estimatedPrintTime:()=>time,motionPrintTime:()=>time,async waitUntil(t,s){s.throwIfAborted();assert(t>=time);time=t;},async setPWM(_t,d,s){s.throwIfAborted();if(d)commands.push(Object.entries(BLTOUCH_COMMANDS).find(([,v])=>v/.02===d)![0]);},async verifyState(o,s){s.throwIfAborted();verification.push(o);time=o.until;return results.shift()??true;},async stop(){stops++;}};
 const device=new BLTouchDevice(port,{...settings,...options});return {device,port,commands,verification,results,get stops(){return stops;},advance(t:number){time+=t;}};
}
test('startup verification gates ready; each sample deploys, waits, seeks and stows',async()=>{
 const f=fixture();await f.device.initialize(signal());assert.equal(f.device.status.phase,'idle');assert.deepEqual(f.commands,['pin_up']);
 const result=await f.device.session(async sample=>{await sample(async()=>{assert(f.device.status.deployed);return 1;});return sample(async()=>2);},signal());assert.equal(result,2);
 assert.deepEqual(f.commands,['pin_up','pin_up','touch_mode','pin_down','pin_up','pin_down','pin_up']);assert.equal(f.device.status.phase,'idle');assert.equal(f.device.status.deployed,false);assert.equal(f.stops,0);
 assert.deepEqual(f.verification.map(o=>o.triggered),[false,true,false,false]);for(const o of f.verification){assert.equal(o.sampleTime,.000015);assert.equal(o.sampleCount,4);assert.equal(o.restTime,.001);assert.equal(o.until,o.time+.1);}
});
test('multi-sample session lowers once, uses touch mode and stows only after all samples',async()=>{
 const f=fixture({stowOnEachSample:false,touchMode:true,outputMode:'OD'});await f.device.initialize(signal());
 await f.device.session(async sample=>{await sample(async()=>1);assert(f.device.status.deployed);await sample(async()=>2);},signal());assert.deepEqual(f.commands,['set_OD_output_mode','pin_up','pin_up','touch_mode','pin_down','touch_mode','pin_up']);assert(!f.device.status.deployed);
});
test('failed raise verification retries reset twice and never publishes ready',async()=>{
 const f=fixture();f.results.push(false,false,false);await assert.rejects(f.device.initialize(signal()),/failed to raise/);assert.deepEqual(f.commands,['pin_up','reset','pin_up','reset','pin_up']);assert.equal(f.device.status.phase,'failed');assert.equal(f.stops,1);await assert.rejects(f.device.session(async()=>{},signal()),/idle initialized/);
});
test('failed sensor test retries but never invokes descent',async()=>{
 const f=fixture();await f.device.initialize(signal());f.results.push(false,false,false);let descended=false;
 await assert.rejects(f.device.session(sample=>sample(async()=>{descended=true;}),signal()),/failed to verify sensor/);assert(!descended);assert.equal(f.stops,1);assert.equal(f.commands.filter(c=>c==='touch_mode').length,3);assert(!f.commands.includes('pin_down'));
});
test('successful retry and original rolling five-minute sensor-test timeout',async()=>{
 const f=fixture();await f.device.initialize(signal());f.results.push(false,true,true);
 await f.device.session(sample=>sample(async()=>{}),signal());assert.equal(f.commands.filter(c=>c==='touch_mode').length,2);
 f.advance(250);await f.device.session(sample=>sample(async()=>{}),signal());assert.equal(f.commands.filter(c=>c==='touch_mode').length,2);
 f.advance(250);await f.device.session(sample=>sample(async()=>{}),signal());assert.equal(f.commands.filter(c=>c==='touch_mode').length,2);
 f.advance(301);await f.device.session(sample=>sample(async()=>{}),signal());assert.equal(f.commands.filter(c=>c==='touch_mode').length,3);
});
test('clone flags skip unsupported checks and reset before raising',async()=>{
 const f=fixture({pinUpNotTriggered:false,pinUpTouchTriggered:false});await f.device.initialize(signal());await f.device.session(sample=>sample(async()=>{}),signal());assert.deepEqual(f.commands,['reset','pin_up','pin_down','reset','pin_up']);assert.equal(f.verification.length,0);
});
test('cancelled sensor verification stops hardware without late deployment',async()=>{
 const f=fixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<boolean>(),abort=new AbortController();await f.device.initialize(signal());
 f.port.verifyState=async()=>{entered.resolve();return release.promise;};let descended=false;
 const pending=f.device.session(sample=>sample(async()=>{descended=true;}),abort.signal),rejected=assert.rejects(pending,/cancel sensor/);await entered.promise;abort.abort(Error('cancel sensor'));await rejected;release.resolve(true);await new Promise(r=>setImmediate(r));assert(!descended);assert(!f.commands.includes('pin_down'));assert.equal(f.stops,1);assert.equal(f.device.status.phase,'failed');
});
test('seek failure stops motion and PWM instead of claiming a verified stow',async()=>{
 const f=fixture();await f.device.initialize(signal());await assert.rejects(f.device.session(sample=>sample(async()=>{throw Error('missing trigger');}),signal()),/missing trigger/);assert.equal(f.device.status.phase,'failed');assert(f.device.status.deployed);assert.equal(f.stops,1);
});
test('retained sample capability cannot issue device commands after its session',async()=>{
 const f=fixture();await f.device.initialize(signal());let retained!:BLTouchSample;await f.device.session(async sample=>{retained=sample;},signal());const before=f.commands.length;await assert.rejects(retained(async()=>{}),/ownership/);assert.equal(f.commands.length,before);assert.equal(f.device.status.phase,'idle');
});
test('transport verification errors stop immediately instead of being treated as a retryable no-hit',async()=>{
 const f=fixture();f.port.verifyState=async()=>{throw Error('MCU disconnected');};await assert.rejects(f.device.initialize(signal()),/MCU disconnected/);assert.deepEqual(f.commands,['pin_up']);assert.equal(f.stops,1);
});
test('a session cannot publish idle while a detached sample is still active',async()=>{
 const f=fixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();await f.device.initialize(signal());let sampleResult:Promise<unknown>|undefined;
 await assert.rejects(f.device.session(async sample=>{sampleResult=sample(async()=>{entered.resolve();await release.promise;});void sampleResult.catch(()=>{});await entered.promise;},signal()),/active sample/);
 release.resolve();await assert.rejects(sampleResult!,/active sample/);assert.equal(f.device.status.phase,'failed');assert.equal(f.stops,1);
});
test('probe sampling tolerance retries retain one deployed pin for the complete multi-sample session',async()=>{
 const f=fixture({stowOnEachSample:false});await f.device.initialize(signal());const values=[1,2,1,1.02],retracts:number[][]=[];
 const result=await f.device.session((sample,s)=>collectProbeSamples({samples:2,retractDistance:2,liftSpeed:5,tolerance:.1,retries:1,result:'average'},()=>sample(async()=>{const z=values.shift()!;return {trigger:[0,0,z,0],halt:[0,0,z-.01,0]};}),async p=>{assert(f.device.status.deployed);retracts.push([...p]);},s),signal());
 assert.equal(result.attempts,4);assert.equal(result.retries,1);assert.equal(result.position[2],1.01);assert.equal(retracts.length,3);assert.equal(f.commands.filter(c=>c==='pin_down').length,1);assert.equal(f.commands.at(-1),'pin_up');assert.equal(f.device.status.phase,'idle');
});
