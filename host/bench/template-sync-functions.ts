import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {SecretsStore,parseSecretsText} from '../src/moonraker/secrets.ts';
import {MoonrakerTemplateOwner,type SyncTemplateCallable} from '../src/moonraker/template-owner.ts';
import {encodeTemplateValue,templateFloatValue} from '../src/moonraker/template-wire.ts';
const bytes=await readFile(new URL('../contracts/moonraker-template-sync-functions-reference.json',import.meta.url));
if(createHash('sha256').update(bytes).digest('hex')!=='2e9660b536d78469ac909b7667c7cfbb9eb3c264f4c714e279fb2666b6592b02')throw Error('Fixed sync callable reference mismatch');
const reference=JSON.parse(bytes.toString()) as {secrets:string;file:string;benchmarks:{name:string;source:string;context:string;useGlobal:boolean;iterations:number;warmups:number;samples:number;output:string;medianMs:number;maximumMedianRatio:number}[]};
const parsed=parseSecretsText(reference.secrets),secrets=new SecretsStore(reference.file,parsed.type,parsed.values),owner=new MoonrakerTemplateOwner(secrets),trace:unknown[]=[],results=[];
// Match the frozen global reference's typed transcript work; context callback
// is deliberately uninstrumented in both runtimes.
owner.addEnvironmentGlobal('fetch',call=>{trace.push({name:'fetch',args:call.args.map(value=>JSON.parse(encodeTemplateValue(value))),kwargs:[...call.kwargs].map(([name,value])=>[name,JSON.parse(encodeTemplateValue(value))])});return templateFloatValue(77);});
const fetch:SyncTemplateCallable=call=>templateFloatValue(Number(call.args[0]));
try{for(const row of reference.benchmarks){const handle=owner.createTemplate(row.source),options=row.name==='callback'?{callables:new Map([['fetch',fetch]])}:{};
 const batch=()=>{for(let i=0;i<row.iterations;i++)if(handle.render(row.context,options)!==row.output)throw Error('Sync callable benchmark output mismatch');};
 for(let i=0;i<row.warmups;i++)batch();const sampleMs=[];for(let i=0;i<row.samples;i++){const start=performance.now();batch();sampleMs.push(performance.now()-start);}
 const medianMs=[...sampleMs].sort((a,b)=>a-b)[Math.floor(sampleMs.length/2)]!,ratio=medianMs/row.medianMs;
 results.push({name:row.name,iterations:row.iterations,warmups:row.warmups,samples:row.samples,sampleMs,medianMs,referenceMedianMs:row.medianMs,ratio,maximumMedianRatio:row.maximumMedianRatio,pass:ratio<=row.maximumMedianRatio});handle.close();
}if(trace.length!==4500)throw Error('Global reference transcript work mismatch');}finally{owner.close();secrets.close();}
console.log(JSON.stringify({schema:1,node:process.version,referenceSha256:'2e9660b536d78469ac909b7667c7cfbb9eb3c264f4c714e279fb2666b6592b02',results,pass:results.every(row=>row.pass)},null,2));if(results.some(row=>!row.pass))process.exitCode=1;
