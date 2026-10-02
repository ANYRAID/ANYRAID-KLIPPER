import {execFileSync,spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {waitForTemperature} from '../src/thermal/temperature-wait.ts';
const count=20000,times:number[]=[];
for(let run=0;run<13;run++){
 let now=0,tick=()=>{},reports=0,cancelled=false;
 const begin=performance.now();
 const pending=waitForTemperature({minimum:50,timeoutSeconds:count+1,signal:new AbortController().signal,read:()=>({temperature:now===count?50:20,target:0,stale:false}),report:()=>{reports++;},timer:{now:()=>now,schedule(callback){tick=callback;return ()=>{cancelled=true;};}}});
 for(now=1;now<=count;now++)tick();await pending;
 const elapsed=performance.now()-begin;assert.equal(reports,count);assert.equal(cancelled,false);
 if(run>=2)times.push(elapsed);
}
const source=execFileSync('git',['show','a59f8bae:klippy/extras/heaters.py'],{encoding:'utf8'});
const py=spawnSync('/usr/bin/python3',['-c',source+`
import types,time,json
samples=[]
for run in range(13):
 index=[0];reports=[0]
 def pause(t): index[0]+=1; return t
 def report(message): reports[0]+=1
 sensor=types.SimpleNamespace(get_temp=lambda t:(50. if index[0]==${count} else 20.,0.))
 toolhead=types.SimpleNamespace(get_last_move_time=lambda:0.)
 reactor=types.SimpleNamespace(monotonic=lambda:0.,pause=pause)
 printer=types.SimpleNamespace(get_start_args=lambda:{},lookup_object=lambda name:toolhead if name=='toolhead' else sensor,get_reactor=lambda:reactor,is_shutdown=lambda:False)
 registry=PrinterHeaters.__new__(PrinterHeaters);registry.printer=printer;registry.heaters={};registry._get_temp=lambda t:''
 command=types.SimpleNamespace(get=lambda name:'sensor',get_float=lambda name,default,**kw:50. if name=='MINIMUM' else default,respond_raw=report)
 start=time.perf_counter();registry.cmd_TEMPERATURE_WAIT(command);elapsed=(time.perf_counter()-start)*1000
 assert reports[0]==${count}
 if run>=2:samples.append(elapsed)
print(json.dumps(samples))
`],{encoding:'utf8'});assert.equal(py.status,0,py.stderr);
const stats=(a:number[])=>{a.sort((x,y)=>x-y);return {medianMs:a[5],p95Ms:a[10]};};
console.log(JSON.stringify({node:process.version,pythonRevision:'a59f8bae',warmups:2,samples:11,polls:count,nodeResult:stats(times),pythonResult:stats(JSON.parse(py.stdout)),scope:'Virtual one-second polling, no-op reports and motion hook. Node includes cancellation, freshness and deadline checks. No wall-clock waiting or hardware.'},null,2));
