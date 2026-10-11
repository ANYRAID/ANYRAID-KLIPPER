import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {SecretsStore,parseSecretsText} from '../src/moonraker/secrets.ts';
import {MoonrakerAsyncTemplateOwner,type TemplateCallable} from '../src/moonraker/template-async-owner.ts';
import {templateFloatValue} from '../src/moonraker/template-wire.ts';
const bytes=await readFile(new URL('../contracts/moonraker-template-async-reference.json',import.meta.url));
if(createHash('sha256').update(bytes).digest('hex')!=='ca8132c3b88a912b19b460665e91adcd898244c50ca72b4413cc005b84bdfe9a')throw Error('Frozen async reference digest mismatch');
const reference=JSON.parse(bytes.toString()) as {secrets:string;file:string;benchmarks:{name:string;source:string;context:string;ui:boolean;iterations:number;warmups:number;samples:number;output:string;medianMs:number;maximumMedianRatio:number}[]};
const parsed=parseSecretsText(reference.secrets),secrets=new SecretsStore(reference.file,parsed.type,parsed.values),owner=new MoonrakerAsyncTemplateOwner(secrets);
const fetch:TemplateCallable=async call=>{await new Promise<void>(resolve=>setImmediate(resolve));return templateFloatValue(Number(call.args[0]));};
const callables=new Map([['fetch',fetch]]),results=[];
try{for(const row of reference.benchmarks){const template=row.ui?owner.createUiTemplate(row.source):owner.createTemplate(row.source);
 const batch=async()=>{for(let i=0;i<row.iterations;i++){const output=await template.renderAsync(row.context,{callables:row.name==='pure'?undefined:callables});if(output!==row.output)throw Error('Async benchmark output mismatch');}};
 for(let i=0;i<row.warmups;i++)await batch();const sampleMs=[];for(let i=0;i<row.samples;i++){const start=performance.now();await batch();sampleMs.push(performance.now()-start);}
 const medianMs=[...sampleMs].sort((a,b)=>a-b)[Math.floor(sampleMs.length/2)]!,ratio=medianMs/row.medianMs;
 results.push({name:row.name,iterations:row.iterations,warmups:row.warmups,samples:row.samples,sampleMs,medianMs,referenceMedianMs:row.medianMs,ratio,maximumMedianRatio:row.maximumMedianRatio,pass:ratio<=row.maximumMedianRatio});template.close();
}}finally{owner.close();secrets.close();}
console.log(JSON.stringify({schema:1,node:process.version,referenceSha256:'ca8132c3b88a912b19b460665e91adcd898244c50ca72b4413cc005b84bdfe9a',results,pass:results.every(r=>r.pass)},null,2));
if(results.some(r=>!r.pass))process.exitCode=1;
