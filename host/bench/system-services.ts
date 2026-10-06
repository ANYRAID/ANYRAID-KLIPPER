import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {SystemInformation} from '../src/moonraker/system-information.ts';
import {SystemServices,type ServiceSnapshot} from '../src/moonraker/system-services.ts';
const catalogue=(active:string):ServiceSnapshot=>{const names=Array.from({length:64},(_,i)=>'klipper-'+i);return {provider:'systemd_cli',available_services:names,service_state:Object.fromEntries(names.map(name=>[name,{active_state:active,sub_state:active==='active'?'running':'dead'}])),instance_ids:{moonraker:'klipper-0',klipper:'klipper-0'}};};
function summary(values:number[]){const sorted=values.toSorted((a,b)=>a-b);return {medianUs:sorted[Math.floor(sorted.length/2)]*1000,p99Us:sorted[Math.ceil(sorted.length*.99)-1]*1000};}
async function run(enabled:boolean){
 const system=new SystemInformation(async()=>({runtime:{name:'node',version:process.version},provider:'none',available_services:[],service_state:{},instance_ids:{moonraker:'',klipper:''}}));let state=catalogue('active'),notifications=0;
 const services=enabled?new SystemServices({source:async()=>state},()=>{notifications++;}):undefined;
 await system.refresh();await services?.refresh();const loop=monitorEventLoopDelay({resolution:1});loop.enable();const queries:number[]=[],polls:number[]=[];
 try{for(let i=0;i<5000;i++){const begin=performance.now(),view=system.snapshot() as {system_info:Record<string,unknown>};if(services)Object.assign(view.system_info,services.snapshot());JSON.stringify(view);queries.push(performance.now()-begin);if(i%10===0){state=catalogue(i%20===0?'inactive':'active');const poll=performance.now();await services?.refresh();polls.push(performance.now()-poll);}if(i%100===0)await yieldTurn();}await new Promise(r=>setTimeout(r,10));return {queries:summary(queries),polls:summary(polls),notifications,loopP99Ms:loop.percentile(99)/1e6,loopMaxMs:loop.max/1e6};}
 finally{loop.disable();await Promise.all([system.close(),services?.close()]);}
}
const baseline:Awaited<ReturnType<typeof run>>[]=[],enabled:Awaited<ReturnType<typeof run>>[]=[];
for(let round=0;round<8;round++){const first=await run(round%2===0),second=await run(round%2!==0);if(round>=2){enabled.push(round%2===0?first:second);baseline.push(round%2===0?second:first);}}
console.log(JSON.stringify({node:process.version,scope:'CPU-only cached system_info serialization and synthetic service polls: maximum 64 services, 5000 queries and 500 polls per round, 8 alternating rounds, first 2 warm-up rounds excluded. No subprocess, Python baseline, target board or physical print timing.',baseline,enabled},null,2));
