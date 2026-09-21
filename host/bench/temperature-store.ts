import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {TemperatureStore} from '../src/moonraker/temperature-store.ts';
import {temperatureStoreOracle} from '../test/helpers/temperature-store-oracle.ts';
const sensors=Array.from({length:32},(_,i)=>'sensor '+i),frames=Array.from({length:64},(_,i)=>Object.fromEntries(sensors.map((name,j)=>[name,{temperature:200+Math.sin((i+j)/20),target:210,power:(i+j)/100,speed:j/32}]))),samples=1000;
const measurements:Record<string,{medianMs:number;p95Ms:number}>={};
function stats(values:number[]){values.sort((a,b)=>a-b);return {medianMs:values[Math.floor(values.length/2)],p95Ms:values.at(-1)!};}
for(const mode of ['stable','varying']){
 const times:number[]=[];
 for(let run=0;run<9;run++){const store=new TemperatureStore();store.configure(sensors,[],frames[0]);const start=performance.now();for(let i=0;i<samples;i++)store.sample(frames[mode==='stable'?0:i%frames.length]);const elapsed=performance.now()-start;assert.equal(store.snapshot()[sensors[0]].temperatures.length,samples+1);if(run>=2)times.push(elapsed);}
 measurements[mode]=stats(times);
}
const oracle=temperatureStoreOracle(),program=oracle.slice(0,oracle.indexOf('async def main():'))+`
async def bench():
 global stage
 data=json.load(sys.stdin);frames=data['frames'];sensors=data['sensors'];results={}
 for mode in ['stable','varying']:
  values=[]
  for run in range(9):
   store=DataStore.__new__(DataStore);store.temp_store_size=1200;store.temperature_store={};store.temp_monitors=[];store.temp_update_timer=Timer();store.server=Server()
   stage={'sensors':sensors,'monitors':[],'status':frames[0]}
   await store._init_sensors()
   start=time.perf_counter()
   for i in range(1000):
    store.subscription_cache=frames[0 if mode=='stable' else i%len(frames)]
    store._update_temperature_store(i)
   elapsed=(time.perf_counter()-start)*1000
   assert len(store.temperature_store[sensors[0]]['temperature'])==1001
   if run>=2: values.append(elapsed)
  results[mode]=sorted(values)
 print(json.dumps(results))
asyncio.run(bench())
`;
const result=spawnSync('/usr/bin/python3',['-c',program],{input:JSON.stringify({sensors,frames}),encoding:'utf8'});assert.equal(result.status,0,result.stderr);const python=Object.fromEntries(Object.entries(JSON.parse(result.stdout) as Record<string,number[]>).map(([key,values])=>[key,stats(values)]));
console.log(JSON.stringify({node:process.version,sensors:32,fieldsPerSensor:4,samples,nodeHistory:measurements,pythonHistory:python,scope:'1000 synchronous sampling callbacks, excluding I/O, timers, JSON serialization and target hardware'},null,2));
