import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PrinterHeaters} from '../src/thermal/heaters.ts';
import {HeaterRuntime} from '../src/thermal/runtime.ts';
import {PIDControl,BangBangControl} from '../src/thermal/control.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
function setup(pid=false){
 let now=1;const pending=new Set<()=>void>(),outputs:string[]=[];
 const timer={now:()=>now,schedule(callback:()=>void){pending.add(callback);return ()=>{pending.delete(callback);};}};
 const heaters=new PrinterHeaters(()=>{}, {waitTimer:timer,waitTimeoutSeconds:10});
 const make=()=>new HeaterRuntime({minimum:0,maximum:300,minimumExtrude:170,smoothTime:1,maxPower:1,reportDelay:.3},pid?new PIDControl({kp:22,ki:1,kd:80,smoothTime:1,maxPower:1}):new BangBangControl(1),{configureMaximumDuration(){},schedule(){},turnOff(){}},()=>({system:now,print:now}),{},()=>()=>{});
 const bed=make(),a=make(),b=make();heaters.register('heater_bed',bed,'B');heaters.register('extruder',a,'T');heaters.register('extruder1',b,'T1');
 let active='extruder';const dispatch=new GCodeDispatch({output:line=>outputs.push(line),shutdown:reason=>heaters.shutdown(reason)});
 heaters.attach(dispatch,{bed:'heater_bed',extruders:['extruder','extruder1'],activeExtruder:()=>active});heaters.start();for(const h of [bed,a,b])h.sample(now,25);dispatch.setReady(true);
 return {heaters,dispatch,bed,a,b,outputs,active(name:string){active=name;},advance(values:[number,number,number]){now++;[bed,a,b].forEach((h,i)=>h.sample(now,values[i]));const ticks=[...pending];pending.clear();ticks.forEach(tick=>tick());},get timers(){return pending.size;}};
}
const admitted=()=>new Promise(resolve=>setImmediate(resolve));
test('M104 and M140 select explicit bed, active extruder or T index without waiting',async()=>{
 const f=setup();try{
  await f.dispatch.execute('M140 S60\nM104 S200');assert.equal(f.bed.status.target,60);assert.equal(f.a.status.target,200);assert.equal(f.timers,0);
  f.active('extruder1');await f.dispatch.execute('M104 S210');assert.equal(f.b.status.target,210);
  await f.dispatch.execute('M104 T-0 S220');assert.equal(f.a.status.target,220);
  await f.dispatch.execute('M104 T99 S0');await assert.rejects(f.dispatch.execute('M104 T99 S200'),/not configured/);
  await assert.rejects(f.dispatch.execute('M104 T-1 S200'),/index/);await assert.rejects(f.dispatch.execute('M140 S301'),/out of range/);
  await f.dispatch.execute('M140\nM104 T0');assert.equal(f.bed.status.target,0);assert.equal(f.a.status.target,0);
 }finally{f.heaters.shutdown();}
});
test('M109 PID waits for derivative settling even after measured temperature reaches target',async()=>{
 const f=setup(true);try{
  let done=false;const command=f.dispatch.execute('M109 S200').then(()=>{done=true;});await admitted();assert.equal(done,false);assert.equal(f.a.status.target,200);
  f.advance([25,200,25]);await admitted();assert.equal(done,false);assert.equal(f.timers,1);
  f.advance([25,200,25]);await command;assert.equal(done,true);assert.equal(f.timers,0);
 }finally{f.heaters.shutdown();}
});
test('M190 watermark preserves heating threshold and S0 does not wait for cooling',async()=>{
 const f=setup();try{
  const command=f.dispatch.execute('M190 S60');await admitted();f.advance([57,25,25]);assert.equal(f.timers,1);f.advance([58,25,25]);await command;
  await f.dispatch.execute('M190 S0');assert.equal(f.bed.status.target,0);assert.equal(f.timers,0);
  await f.dispatch.execute('M190 S50');assert.equal(f.timers,0);
 }finally{f.heaters.shutdown();}
});
test('standard wait commands reject on emergency shutdown and leave all targets zero',async()=>{
 const f=setup(true);const command=f.dispatch.execute('M109 S200');await admitted();f.dispatch.emergencyStop();await assert.rejects(command);
 assert.equal(f.timers,0);assert.equal(f.a.status.target,0);assert.equal(f.b.status.target,0);assert.equal(f.bed.status.target,0);
});
test('standard command mapping and duplicate validation are atomic and isolate caller arrays',async()=>{
 const f=setup();try{
  const d=new GCodeDispatch({output(){},shutdown(){}});d.register('M109',()=>{});
  assert.throws(()=>f.heaters.attach(d,{extruders:['extruder']}),/Duplicate/);assert.equal(d.hasCommand('M105'),false);assert.equal(d.hasCommand('M104'),false);
  assert.throws(()=>f.heaters.attach(new GCodeDispatch({output(){},shutdown(){}}),{extruders:['extruder','extruder1']}),/mapping/);
  assert.throws(()=>f.heaters.attach(new GCodeDispatch({output(){},shutdown(){}}),{bed:'missing'}),/not registered/);
  const names=['extruder'],isolated=new GCodeDispatch({output(){},shutdown(){}});f.heaters.attach(isolated,{extruders:names});names[0]='extruder1';isolated.setReady(true);await isolated.execute('M104 S210');assert.equal(f.a.status.target,210);assert.equal(f.b.status.target,0);
 }finally{f.heaters.shutdown();}
});
test('runtime stability decisions match pinned Python for PID and watermark traces',async()=>{
 const {execFileSync,spawnSync}=await import('node:child_process');
 const source=execFileSync('git',['show','8c4d0143:klippy/extras/heaters.py'],{encoding:'utf8'});
 const temperatures=Array.from({length:1000},(_,i)=>i<20?25+i*9:i%100<80?200:199+(i%5)*.5);
 const py=spawnSync('/usr/bin/python3',['-c',source+`
import types,json,sys
values=json.load(sys.stdin);result=[]
for algorithm in ['pid','watermark']:
 h=Heater.__new__(Heater);h.lock=threading.Lock();h.last_temp_time=0.;h.smoothed_temp=0.;h.target_temp=200.;h.min_extrude_temp=170.;h.max_power=1.;h.smooth_time=1.;h.inv_smooth_time=1.;h.set_pwm=lambda t,p:None
 cfg=types.SimpleNamespace(getfloat=lambda name,default=None,**kwargs:{'pid_Kp':22.,'pid_Ki':1.,'pid_Kd':80.,'max_delta':2.}[name])
 h.control=ControlPID(h,cfg) if algorithm=='pid' else ControlBangBang(h,cfg)
 decisions=[]
 for i,temp in enumerate(values):
  h.temperature_callback((i+1)*.1,temp);decisions.append(h.check_busy((i+1)*.1))
 result.append(decisions)
print(json.dumps(result))
`],{input:JSON.stringify(temperatures),encoding:'utf8'});
 assert.equal(py.status,0,py.stderr);const expected=JSON.parse(py.stdout);
 for(const [index,pid] of [true,false].entries()){
  let now=.1;const control=pid?new PIDControl({kp:22,ki:1,kd:80,smoothTime:1,maxPower:1}):new BangBangControl(1);
  const runtime=new HeaterRuntime({minimum:0,maximum:300,minimumExtrude:170,smoothTime:1,maxPower:1,reportDelay:.3},control,{configureMaximumDuration(){},schedule(){},turnOff(){}},()=>({system:now,print:now}),{},()=>()=>{});
  runtime.start();
  const decisions=temperatures.map((temp,i)=>{now=(i+1)*.1;runtime.sample(now,temp);if(i===0)runtime.setTarget(200);return runtime.isBusy();});
  assert.deepEqual(decisions,expected[index]);runtime.shutdown();
 }
});
