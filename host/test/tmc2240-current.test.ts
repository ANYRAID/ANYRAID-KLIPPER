import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {tmc2240Current,tmc2240FullScale,Tmc2240Current} from '../src/drivers/tmc2240-current.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/tmc2240-current-reference.json',import.meta.url),'utf8')) as {rows:[number,number,number,number|null,...number[]][]};
test('4488 original TMC2240 current cases match every register and quantized amp value exactly',()=>{
 assert.equal(reference.rows.length,4488);
 for(const [rref,run,hold,fixed,...expected] of reference.rows){const r=tmc2240Current(run,hold,rref,fixed??undefined);assert.deepEqual([r.currentRange,r.globalscaler,r.irun,r.ihold,r.runCurrent,r.holdCurrent,r.fullScale],expected);}
});
test('range and current limits reject malformed or unsupported electrical settings',()=>{
 for(const rref of [0,11999,60001,NaN,Infinity])assert.throws(()=>tmc2240Current(.5,.2,rref));
 for(const range of [-1,.5,4,NaN])assert.throws(()=>tmc2240Current(.5,.2,12000,range));
 for(const run of [-1,3,Infinity,NaN])assert.throws(()=>tmc2240Current(run));for(const hold of [0,-1,3,Infinity,NaN])assert.throws(()=>tmc2240Current(.5,hold));
 assert.throws(()=>tmc2240Current(.8,.2,12000,0),/range/);assert.equal(tmc2240Current(.7).currentRange,1);assert.equal(tmc2240Current(.7).fullScale,tmc2240FullScale(12000,1));
});
const signal=()=>new AbortController().signal;
function setup(write:(register:number,value:number,signal:AbortSignal)=>Promise<void>){const current=tmc2240Current(.7),faults:unknown[]=[];const owner=new Tmc2240Current({write},{current,requestedHold:tmc2240FullScale(),rref:12000,registers:[{name:'IHOLD_IRUN',value:0x04601f1f}]},signal(),cause=>faults.push(cause));return {owner,current,faults};}
test('live current preserves initialized range and publishes only after both register acknowledgements',async()=>{
 const first=Promise.withResolvers<void>(),second=Promise.withResolvers<void>(),writes:{register:number;value:number}[]=[];
 const f=setup(async(register,value)=>{writes.push({register,value});await (writes.length===1?first.promise:second.promise);});
 const pending=f.owner.set({run:.3,hold:.1},signal());assert.equal(f.owner.current,f.current);assert.equal(f.owner.revision,0);first.resolve();await new Promise(r=>setImmediate(r));assert.equal(f.owner.current,f.current);assert.deepEqual(writes.map(w=>w.register),[0x0b,0x10]);
 await assert.rejects(f.owner.set({run:.2},signal()),/unavailable/);second.resolve();await pending;assert.equal(f.owner.current.currentRange,1);assert.equal(f.owner.revision,1);assert.deepEqual(f.owner.current,tmc2240Current(.3,.1,12000,1));assert.equal((writes[1].value&~0x1f1f)>>>0,(0x04601f1f&~0x1f1f)>>>0);assert.equal(f.faults.length,0);
 const count=writes.length;await assert.rejects(f.owner.set({run:f.owner.maxCurrent+.01},signal()),/range/);await assert.rejects(f.owner.set({hold:f.owner.maxCurrent+.01},signal()),/range/);assert.equal(writes.length,count);
});
for(const cancel of [false,true])test(`partial current update retires owner on ${cancel?'cancellation':'write failure'}`,async()=>{
 const controller=new AbortController();let writes=0;const f=setup(async()=>{writes++;if(cancel)controller.abort(new Error('cancelled'));else if(writes===2)throw new Error('write failed');});
 await assert.rejects(f.owner.set({run:.3},controller.signal),cancel?/cancelled/:/write failed/);assert.equal(f.owner.current,f.current);assert.equal(f.owner.revision,0);assert.equal(f.faults.length,1);assert.equal(writes,cancel?1:2);await assert.rejects(f.owner.set({run:.3},signal()),/unavailable/);
});
