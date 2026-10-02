import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {PrinterHeaters} from '../src/thermal/heaters.ts';
import {HeaterRuntime} from '../src/thermal/runtime.ts';
import {BangBangControl} from '../src/thermal/control.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
function fixture(options:{off?:()=>void;cancel?:()=>void}={}){
 let time=1,offs=0;
 const runtime=new HeaterRuntime({minimum:0,maximum:300,minimumExtrude:170,smoothTime:1,maxPower:1,reportDelay:.3},new BangBangControl(1),{configureMaximumDuration(){},schedule(){},turnOff(){offs++;options.off?.();}},()=>({system:time,print:time}),{},()=>()=>options.cancel?.());
 return {runtime,get offs(){return offs;},advance(value:number){time=value;}};
}
const signal=()=>new AbortController().signal;
test('heater commands query with one ack, apply ordered targets, and turn all outputs off',async()=>{
 const output:string[]=[],events:string[]=[];const bed=fixture(),extruder=fixture();
 const heaters=new PrinterHeaters(()=>{events.push('barrier');});heaters.register('heater_bed',bed.runtime,'B');heaters.register('extruder',extruder.runtime,'T');
 const dispatch=new GCodeDispatch({output:line=>output.push(line),shutdown:reason=>heaters.shutdown(reason)});heaters.attach(dispatch);
 await dispatch.execute('M105',{acknowledge:true});assert.deepEqual(output,['ok T:0']);
 heaters.start();bed.runtime.sample(1,25);extruder.runtime.sample(1,200);dispatch.setReady(true);
 output.length=0;await dispatch.execute('SET_HEATER_TEMPERATURE HEATER=extruder TARGET=220\nM105',{acknowledge:true});
 assert.deepEqual(events,['barrier']);assert.deepEqual(output,['ok','ok B:25.0 /0.0 T:200.0 /220.0']);
 output.length=0;await dispatch.execute('M105');assert.deepEqual(output,['B:25.0 /0.0 T:200.0 /220.0']);
 await dispatch.execute('TURN_OFF_HEATERS');assert.equal(extruder.runtime.status.target,0);assert.equal(bed.offs,2);assert.equal(extruder.offs,2);
 await dispatch.execute('SET_HEATER_TEMPERATURE HEATER=extruder TARGET=200');await dispatch.execute('SET_HEATER_TEMPERATURE HEATER=extruder');assert.equal(extruder.runtime.status.target,0);
 heaters.shutdown();
});
test('heater target rejected before motion barrier for bad names or temperatures',async()=>{
 let barriers=0;const heater=fixture(),heaters=new PrinterHeaters(()=>{barriers++;});heaters.register('extruder',heater.runtime);heaters.start();
 for(const [name,target] of [['unknown',200],['extruder',301],['extruder',NaN],['extruder',-1]] as const)await assert.rejects(heaters.setTarget(name,target,signal()));
 assert.equal(barriers,0);assert.equal(heaters.status.closed,false);heaters.shutdown();
});
test('pending heater target cannot re-enable heating after off, shutdown or abort',async()=>{
 for(const action of ['off','shutdown','abort']){
  let release!:()=>void;const heater=fixture(),heaters=new PrinterHeaters(()=>new Promise<void>(resolve=>{release=resolve;}));heaters.register('extruder',heater.runtime);heaters.start();heater.runtime.sample(1,25);
  const controller=new AbortController(),pending=heaters.setTarget('extruder',200,controller.signal);
  if(action==='off')heaters.turnOffAll();else if(action==='shutdown')heaters.shutdown();else controller.abort();
  release();await assert.rejects(pending);assert.equal(heater.runtime.status.target,0);heaters.shutdown();
 }
});
test('turn off attempts every heater after one fails, latches registry and retains cleanup failures',()=>{
 let fail=false;const offError=new Error('pin off failed'),cancelError=new Error('cancel failed');
 const first=fixture({off(){if(fail)throw offError;},cancel(){throw cancelError;}}),second=fixture();
 const heaters=new PrinterHeaters(()=>{});heaters.register('a',first.runtime);heaters.register('b',second.runtime);heaters.start();
 fail=true;assert.throws(()=>heaters.turnOffAll(),AggregateError);
 assert.equal(heaters.status.closed,true);assert.ok(second.offs>=2);assert.equal(second.runtime.status.stopped,true);
 const cleanup=first.runtime.status.shutdownError;assert.ok(cleanup instanceof AggregateError);assert.deepEqual(cleanup.errors,[cancelError,offError]);
 assert.throws(()=>heaters.start());
});
test('M105 suppresses stale readings and registry validates all command names before attachment',async()=>{
 const heater=fixture(),heaters=new PrinterHeaters(()=>{});heaters.register('heater_generic chamber',heater.runtime,'C');
 assert.throws(()=>heaters.register('duplicate',heater.runtime,'D'));
 assert.throws(()=>heaters.register('another chamber',fixture().runtime));
 assert.throws(()=>heaters.register('other',fixture().runtime,'C'));
 const dispatch=new GCodeDispatch({output(){},shutdown(){}});dispatch.register('TURN_OFF_HEATERS',()=>{});
 assert.throws(()=>heaters.attach(dispatch));assert.equal(dispatch.hasCommand('M105'),false);
 heaters.start();heater.runtime.sample(1,50);heater.advance(9);assert.equal(heaters.report(),'C:0.0 /0.0');heaters.shutdown();
});
test('M105 formatting matches pinned Python heater registry',()=>{
 const source=execFileSync('git',['show','1e9d1a81:klippy/extras/heaters.py'],{encoding:'utf8'});
 const cases=Array.from({length:101},(_,i)=>({B:[i+.25,0],T:[i+.75,200]}));
 const py=spawnSync('/usr/bin/python3',['-c',source+`
import json,sys,types
results=[]
for case in json.load(sys.stdin):
 h=PrinterHeaters.__new__(PrinterHeaters);h.has_started=True
 h.gcode_id_to_sensor={key:types.SimpleNamespace(get_temp=lambda time,pair=pair:pair) for key,pair in case.items()}
 results.append(h._get_temp(1))
print(json.dumps(results))
`],{input:JSON.stringify(cases),encoding:'utf8'});
 assert.equal(py.status,0,py.stderr);const expected=JSON.parse(py.stdout);
 cases.forEach((c,i)=>{
  const b=fixture(),t=fixture(),heaters=new PrinterHeaters(()=>{});heaters.register('bed',b.runtime,'B');heaters.register('extruder',t.runtime,'T');heaters.start();
  b.runtime.sample(1,c.B[0]);t.runtime.sample(1,c.T[0]);t.runtime.setTarget(c.T[1]);assert.equal(heaters.report(),expected[i]);heaters.shutdown();
 });
});
test('startup failure stops earlier heaters and prevents registry restart',()=>{
 const first=fixture(),last=fixture(),broken=fixture({off(){throw new Error('startup output failed');}}),heaters=new PrinterHeaters(()=>{});
 heaters.register('first',first.runtime);heaters.register('broken',broken.runtime);heaters.register('last',last.runtime);
 assert.throws(()=>heaters.start(),/startup output failed/);
 assert.equal(heaters.status.closed,true);assert.equal(first.runtime.status.stopped,true);assert.equal(last.runtime.status.stopped,true);
 assert.ok(heaters.status.shutdownErrors.length>0);assert.throws(()=>heaters.start());
});
