import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {planTmc5160} from '../src/drivers/tmc5160.ts';
import {tmc5160Current,Tmc5160Current} from '../src/drivers/tmc5160-current.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/tmc5160-reference.json',import.meta.url),'utf8'));
const reader=(driver:Record<string,string>,stepper:Record<string,string>)=>new ConfigurationReader(new ConfigurationSource('/tmc.cfg',{'tmc5160 stepper_x':driver,stepper_x:stepper},[]),null);
const signal=()=>new AbortController().signal;
test('5160 startup registers and current match 256 original constructors including unsigned protection fields',()=>{
 for(const row of reference.rows){const plan=planTmc5160(reader(row.driver,row.stepper),'tmc5160 stepper_x');assert.deepEqual(plan.registers,row.registers);assert.deepEqual(plan.current,row.current);}
});
test('adjacent Float64 global-scale boundaries preserve the encoded zero-as-256 convention',()=>{
 for(const row of reference.boundaries)assert.deepEqual(tmc5160Current(row.run,row.hold,row.resistor),row.current);
 for(const run of [-1,10.01,NaN,Infinity])assert.throws(()=>tmc5160Current(run));assert.throws(()=>tmc5160Current(1,0));assert.throws(()=>tmc5160Current(1,1,Number.MIN_VALUE),/overflow/);assert.throws(()=>tmc5160Current(1,1,Number.MAX_VALUE),/overflow/);
});
test('5160 writes GLOBALSCALER before current bits and publishes only after both acknowledgements',async()=>{
 const row=reference.rows[32],plan=planTmc5160(reader(row.driver,row.stepper),'tmc5160 stepper_x'),writes:number[][]=[],pending=Promise.withResolvers<void>();
 const current=new Tmc5160Current({async write(r,v){writes.push([r,v]);if(r===16)await pending.promise;}},plan,signal(),()=>assert.fail('fault'));
 const job=current.set({run:3,hold:.5},signal());await new Promise(r=>setImmediate(r));assert.equal(current.current,plan.current);assert.deepEqual(writes.map(w=>w[0]),[11,16]);assert.equal(writes[1][1]&~0x1f1f,plan.registers.find(r=>r.name==='IHOLD_IRUN')!.value&~0x1f1f);pending.resolve();await job;assert.equal(current.revision,1);assert.deepEqual(current.current,tmc5160Current(3,.5,plan.resistor));
 await current.set({run:1},signal());assert.deepEqual(current.current,tmc5160Current(1,.5,plan.resistor));
});
test('partial 5160 update failure retires current ownership without advancing the published revision',async()=>{
 const row=reference.rows[32],plan=planTmc5160(reader(row.driver,row.stepper),'tmc5160 stepper_x'),faults:unknown[]=[];let writes=0;
 const current=new Tmc5160Current({async write(r){writes++;if(r===16)throw new Error('lost');}},plan,signal(),e=>faults.push(e));await assert.rejects(current.set({run:3},signal()),/lost/);assert.equal(current.current,plan.current);assert.equal(current.revision,0);assert.equal(faults.length,1);await assert.rejects(current.set({run:1},signal()),/unavailable/);assert.equal(writes,2);
});
test('cancelled global-scale write cannot publish state or proceed to current bits',async()=>{
 const row=reference.rows[32],plan=planTmc5160(reader(row.driver,row.stepper),'tmc5160 stepper_x'),abort=new AbortController(),faults:unknown[]=[];let writes=0;
 const current=new Tmc5160Current({async write(){writes++;abort.abort(new Error('cancel'));}},plan,signal(),e=>faults.push(e));await assert.rejects(current.set({run:3},abort.signal),/cancel/);assert.equal(writes,1);assert.equal(current.current,plan.current);assert.equal(faults.length,1);
});
