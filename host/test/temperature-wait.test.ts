import {test} from 'node:test';
import assert from 'node:assert/strict';
import {waitForTemperature,type TemperatureWaitTimer} from '../src/thermal/temperature-wait.ts';
import {PrinterHeaters} from '../src/thermal/heaters.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
function clock(){
 let now=0;const pending=new Set<()=>void>();
 const timer:TemperatureWaitTimer={now:()=>now,schedule(callback){pending.add(callback);return ()=>{pending.delete(callback);};}};
 return {timer,advance(value:number){now=value;const callbacks=[...pending];pending.clear();for(const callback of callbacks)callback();},get pending(){return pending.size;}};
}
const fresh=(temperature:number)=>({temperature,target:0,stale:false});
test('temperature wait accepts inclusive bounds, reports while waiting and removes timer on success',async()=>{
 const c=clock();let temp=20,reports=0;
 const pending=waitForTemperature({minimum:30,maximum:40,signal:new AbortController().signal,read:()=>fresh(temp),report:()=>reports++,timer:c.timer});
 assert.equal(reports,1);temp=29;c.advance(1);assert.equal(reports,2);temp=30;c.advance(2);await pending;assert.equal(c.pending,0);
 await waitForTemperature({minimum:30,maximum:40,signal:new AbortController().signal,read:()=>fresh(40),report:()=>assert.fail(),timer:c.timer});
});
test('temperature wait never completes from stale, faulty or nonfinite readings',async()=>{
 for(const state of [{...fresh(0),stale:true},{...fresh(20),fault:'stopped'},fresh(NaN),{...fresh(20),target:Infinity}]){
  const c=clock();await assert.rejects(waitForTemperature({maximum:30,signal:new AbortController().signal,read:()=>state,report(){},timer:c.timer}),/fresh healthy/);assert.equal(c.pending,0);
 }
});
test('temperature waits reject invalid bounds, timeouts and clock regression',async()=>{
 const base={signal:new AbortController().signal,read:()=>fresh(10),report(){}};
 for(const range of [{},{minimum:20,maximum:20},{minimum:NaN},{maximum:Infinity}])await assert.rejects(waitForTemperature({...base,...range}),/range/);
 for(const timeoutSeconds of [0,-1,Infinity,86401])await assert.rejects(waitForTemperature({...base,minimum:20,timeoutSeconds}),/timeout/);
 const c=clock();c.advance(2);const pending=waitForTemperature({...base,minimum:20,timer:c.timer});c.advance(1);await assert.rejects(pending,/clock/);
});
test('temperature timeout and cancellation remove polling without a success result',async()=>{
 const c=clock();const pending=waitForTemperature({minimum:20,timeoutSeconds:2,signal:new AbortController().signal,read:()=>fresh(10),report(){},timer:c.timer});
 c.advance(2);await assert.rejects(pending,/timed out/);assert.equal(c.pending,0);
 const controller=new AbortController(),reason=new Error('cancelled');const aborted=waitForTemperature({minimum:20,signal:controller.signal,read:()=>fresh(10),report(){},timer:c.timer});controller.abort(reason);
 await assert.rejects(aborted,error=>error===reason);assert.equal(c.pending,0);
 await assert.rejects(waitForTemperature({minimum:20,signal:controller.signal,read:()=>assert.fail(),report(){},timer:c.timer}),error=>error===reason);
});
test('registry temperature command supports independent sensors and interrupts pending work on turn off',async()=>{
 const c=clock();let temp=20;const output:string[]=[];
 const heaters=new PrinterHeaters(()=>{}, {waitTimer:c.timer});heaters.registerSensor('temperature_sensor chamber',{getTemperature:()=>fresh(temp)},'C');heaters.start();
 const dispatch=new GCodeDispatch({output:line=>output.push(line),shutdown:reason=>heaters.shutdown(reason)});heaters.attach(dispatch);dispatch.setReady(true);
 const command=dispatch.execute('TEMPERATURE_WAIT SENSOR="temperature_sensor chamber" MINIMUM=30 MAXIMUM=40');
 await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(output,['C:20.0 /0.0']);
 temp=30;c.advance(1);await command;assert.equal(c.pending,0);
 temp=20;const wait=heaters.wait('temperature_sensor chamber',30,undefined,new AbortController().signal);heaters.turnOffAll();await assert.rejects(wait,/turn off/);assert.equal(c.pending,0);assert.equal(heaters.status.closed,false);
 heaters.shutdown();
});
test('sensor timeout shuts registry down and cancels its other waits',async()=>{
 const c=clock(),heaters=new PrinterHeaters(()=>{}, {waitTimer:c.timer,waitTimeoutSeconds:2});heaters.registerSensor('sensor',{getTemperature:()=>fresh(20)});heaters.start();
 const first=heaters.wait('sensor',30,undefined,new AbortController().signal),second=heaters.wait('sensor',40,undefined,new AbortController().signal);
 c.advance(2);const results=await Promise.allSettled([first,second]);assert.ok(results.every(r=>r.status==='rejected'));assert.equal(heaters.status.closed,true);assert.equal(c.pending,0);
});
test('M112 aborts temperature wait immediately and prevents following script commands',async()=>{
 const c=clock(),heaters=new PrinterHeaters(()=>{}, {waitTimer:c.timer});heaters.registerSensor('sensor',{getTemperature:()=>fresh(20)});heaters.start();
 let follow=0;const dispatch=new GCodeDispatch({output(){},shutdown:reason=>heaters.shutdown(reason)});heaters.attach(dispatch);dispatch.register('AFTER_WAIT',()=>{follow++;});dispatch.setReady(true);
 const pending=dispatch.execute('TEMPERATURE_WAIT SENSOR=sensor MINIMUM=30\nAFTER_WAIT');await new Promise(resolve=>setImmediate(resolve));
 dispatch.emergencyStop();await assert.rejects(pending);assert.equal(c.pending,0);assert.equal(follow,0);assert.equal(heaters.status.closed,true);
});
test('healthy heating and cooling traces match pinned Python TEMPERATURE_WAIT reports',async()=>{
 const {execFileSync,spawnSync}=await import('node:child_process');
 const source=execFileSync('git',['show','a59f8bae:klippy/extras/heaters.py'],{encoding:'utf8'});
 const cases=Array.from({length:50},(_,i)=>i%2?{values:[80,70,60,50],bounds:{MAXIMUM:50}}:{values:[20,30,40,50],bounds:{MINIMUM:50,MAXIMUM:60}});
 const py=spawnSync('/usr/bin/python3',['-c',source+`
import types,json,sys
results=[]
for case in json.load(sys.stdin):
 index=[0];messages=[]
 sensor=types.SimpleNamespace(get_temp=lambda time:(case['values'][index[0]],0.))
 def pause(time): index[0]+=1; return time
 reactor=types.SimpleNamespace(monotonic=lambda:0.,pause=pause)
 toolhead=types.SimpleNamespace(get_last_move_time=lambda:0.)
 printer=types.SimpleNamespace(get_start_args=lambda:{},lookup_object=lambda name:toolhead if name=='toolhead' else sensor,get_reactor=lambda:reactor,is_shutdown=lambda:False)
 registry=PrinterHeaters.__new__(PrinterHeaters);registry.printer=printer;registry.heaters={};registry.has_started=True;registry.gcode_id_to_sensor={'C':sensor}
 command=types.SimpleNamespace(get=lambda name:'sensor',get_float=lambda name,default,**kw:case['bounds'].get(name,default),respond_raw=messages.append)
 registry.cmd_TEMPERATURE_WAIT(command)
 results.append(messages)
print(json.dumps(results))
`],{input:JSON.stringify(cases),encoding:'utf8'});
 assert.equal(py.status,0,py.stderr);const expected=JSON.parse(py.stdout);
 for(let i=0;i<cases.length;i++){
  const c=clock(),testcase=cases[i],messages:string[]=[];let index=0;
  const heaters=new PrinterHeaters(()=>{}, {waitTimer:c.timer});heaters.registerSensor('sensor',{getTemperature:()=>fresh(testcase.values[index])},'C');heaters.start();
  const pending=heaters.wait('sensor',testcase.bounds.MINIMUM,testcase.bounds.MAXIMUM,new AbortController().signal,()=>messages.push(heaters.report()));
  for(index=1;index<testcase.values.length;index++)c.advance(index);
  await pending;assert.deepEqual(messages,expected[i]);heaters.shutdown();
 }
});
