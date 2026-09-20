import {execFileSync,spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {PrinterHeaters} from '../src/thermal/heaters.ts';
import {HeaterRuntime} from '../src/thermal/runtime.ts';
import {BangBangControl} from '../src/thermal/control.ts';
function heater(temp:number){
 const runtime=new HeaterRuntime({minimum:0,maximum:300,minimumExtrude:170,smoothTime:1,maxPower:1,reportDelay:.3},new BangBangControl(1),{configureMaximumDuration(){},schedule(){},turnOff(){}},()=>({system:1,print:1}),{},()=>()=>{});
 return {runtime,temp};
}
const b=heater(60),t=heater(200),registry=new PrinterHeaters(()=>{});
registry.register('bed',b.runtime,'B');registry.register('extruder',t.runtime,'T');registry.start();b.runtime.sample(1,b.temp);t.runtime.sample(1,t.temp);
const reports:number[]=[],commands:number[]=[],signal=new AbortController().signal;
for(let run=0;run<13;run++){
 let start=performance.now(),message='';for(let i=0;i<100000;i++)message=registry.report();const reportMs=performance.now()-start;
 assert.equal(message,'B:60.0 /0.0 T:200.0 /0.0');
 start=performance.now();for(let i=0;i<10000;i++){await registry.setTarget('bed',60,signal);await registry.setTarget('extruder',200,signal);registry.turnOffAll();}const commandMs=performance.now()-start;
 assert.equal(b.runtime.status.target,0);assert.equal(t.runtime.status.target,0);
 if(run>=2){reports.push(reportMs);commands.push(commandMs);}
}
registry.shutdown();
const source=execFileSync('git',['show','1e9d1a81:klippy/extras/heaters.py'],{encoding:'utf8'});
const py=spawnSync('/usr/bin/python3',['-c',source+`
import types,time,json
mcu=types.SimpleNamespace(estimated_print_time=lambda time:1.)
def heater(temp):
 h=Heater.__new__(Heater);h.min_temp=0.;h.max_temp=300.;h.target_temp=0.;h.smoothed_temp=temp;h.last_temp_time=1.;h.lock=threading.Lock()
 h.mcu_pwm=types.SimpleNamespace(get_mcu=lambda:mcu)
 return h
b,t=heater(60.),heater(200.)
r=PrinterHeaters.__new__(PrinterHeaters);r.has_started=True;r.gcode_id_to_sensor={'B':b,'T':t};r.heaters={'bed':b,'extruder':t}
reports=[];commands=[]
for run in range(13):
 start=time.perf_counter()
 for i in range(100000): message=r._get_temp(1.)
 reportms=(time.perf_counter()-start)*1000
 assert message=='B:60.0 /0.0 T:200.0 /0.0'
 start=time.perf_counter()
 for i in range(10000): b.set_temp(60.);t.set_temp(200.);r.turn_off_all_heaters()
 commandms=(time.perf_counter()-start)*1000
 if run>=2: reports.append(reportms);commands.append(commandms)
print(json.dumps({'reports':reports,'commands':commands}))
`],{encoding:'utf8'});assert.equal(py.status,0,py.stderr);const python=JSON.parse(py.stdout);
const stats=(a:number[])=>{a.sort((x,y)=>x-y);return {medianMs:a[5],p95Ms:a[10]};};
console.log(JSON.stringify({node:process.version,pythonRevision:'1e9d1a81',warmups:2,samples:11,reports:100000,targetOffCycles:10000,nodeReports:stats(reports),pythonReports:stats(python.reports),nodeCommands:stats(commands),pythonCommands:stats(python.commands),scope:'Two synthetic heaters. Node target cycles include promise barrier and immediate no-op output cancellation; Python changes target only. Excludes serial IO and real motion ordering.'},null,2));
