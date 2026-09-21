import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {PrintApi,type PrintBackend} from '../src/moonraker/print-api.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {printApiOracle} from '../test/helpers/print-api-oracle.ts';
const cases=[{action:'start',filename:'part.gcode'},{action:'pause'},{action:'resume'},{action:'cancel'}] as const,count=20000;
const python=JSON.parse(execFileSync('/usr/bin/python3',['-c',printApiOracle()],{input:JSON.stringify({cases,count}),encoding:'utf8'}));
const abort=new AbortController(),backend:PrintBackend={signal:abort.signal,snapshot:{connected:true,initialized:true,state:'ready',endpoints:['gcode/script','pause_resume/pause','pause_resume/resume','pause_resume/cancel']},async request(){return 'ok';}},api=new PrintApi({backend:()=>backend,maintenanceGate:new MaintenanceGate()}),context={transport:'http' as const,signal:abort.signal,authorize(){}};
const roundsMs:number[]=[];for(let round=0;round<9;round++){let result;const start=performance.now();for(let i=0;i<count;i++){const item=cases[i%cases.length];result=await api.call(item.action,'filename' in item?{filename:item.filename}:{},context);}const elapsed=performance.now()-start;assert.equal(result,'ok');if(round>=2)roundsMs.push(elapsed);}
const sorted=[...roundsMs].sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,count,python,typescript:{roundsMs,medianMs:sorted[3],p95Ms:sorted[6]},scope:'In-memory control adapters; TypeScript includes bounded admission and cancellation. No socket, printer or auth-provider latency.'},null,2));
