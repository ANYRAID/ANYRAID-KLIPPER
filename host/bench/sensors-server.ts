import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import {SensorStore,registerSensors} from '../src/moonraker/sensors.ts';
const dir=await mkdtemp(join(tmpdir(),'sensor-bench-')),samples:Record<string,number[]>={manual:[],owned:[]};
try{
 const path=join(dir,'moonraker.conf');await writeFile(path,'[server]\nhost=127.0.0.1\nport=0');
 for(let round=0;round<9;round++)for(const mode of round%2?['owned','manual']:['manual','owned']){
  const sensors=new SensorStore();for(let i=0;i<8;i++){sensors.register({id:String(i),type:'MQTT'});sensors.update(String(i),{t:{value:22.5}});}
  const service=await ConfiguredMoonraker.load(path,{authorize:()=>{},information:{connected:false,state:'disconnected',components:['application'],failedComponents:[],directories:[],warnings:[],version:'bench',missingRequirements:[]},...(mode==='owned'?{sensors}:{})});
  const release=mode==='manual'?registerSensors(service.endpoints,sensors):()=>{};
  try{
   const address=await service.start(),url=`http://127.0.0.1:${address.port}/server/sensors/list`,expected=sensors.list();
   for(let i=0;i<10;i++)await(await fetch(url)).json();const start=performance.now();
   for(let i=0;i<200;i++){const response=await fetch(url);assert.equal(response.status,200);assert.deepEqual((await response.json() as any).result,expected);}
   if(round>=2)samples[mode].push(performance.now()-start);
  }finally{release();await service.close();sensors.close();}
 }
 const summary=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[3],p95Ms:v[6]};};
 console.log(JSON.stringify({node:process.version,warmup:2,samples:7,requests:200,sensors:8,scope:'Sequential loopback HTTP list, manual registration versus server-owned store; assertions included',manual:summary(samples.manual),owned:summary(samples.owned)},null,2));
}finally{await rm(dir,{recursive:true,force:true});}
