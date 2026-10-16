import {templateBenchmarkReference,templateBenchmarkComparison,templateBenchmarkSummary,nativeTemplateMedianBudget} from './template-benchmark-reference.ts';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {NativeTemplateCandidate} from '../src/moonraker/native-template.ts';
const cases=[{v:true,p:0,m:'common'},{v:false,p:400,m:'floor'},{v:9007199254740991,p:1,m:'ceil'},{v:-9007199254740991,p:400,m:'floor'},{v:145,p:-1,m:'common'},{v:-155,p:-1,m:'common'},{v:2.675,p:2,m:'common'},{v:-2.675,p:2,m:'common'}];
const source='{% set d=payload|fromjson %}{set_result("x",d.v|round(d.p,d.m))}';
const reference=templateBenchmarkReference<{times:number[];expected:{kind:string;value:number}[]}>('native-template-round',{source,cases,renders:4000,warmup:2,samples:7}),t=new NativeTemplateCandidate(source),payloads=cases.map(c=>JSON.stringify(c)),times=[];
try{
 payloads.forEach((p,i)=>{const value=t.render(p)[0];assert.deepEqual({kind:value.numberType,value:value.numberValue},reference.expected[i]);});
 for(let run=0;run<9;run++){let value;const start=performance.now();for(let i=0;i<500;i++)for(const p of payloads)value=t.render(p)[0];if(run>=2)times.push(performance.now()-start);assert.deepEqual({kind:value!.numberType,value:value!.numberValue},reference.expected.at(-1));}
}finally{t.close();}
const summary=templateBenchmarkSummary;console.log(JSON.stringify({node:process.version,renders:4000,warmup:2,samples:7,scope:'Mixed integer, boolean and binary64 round inside native/Jinja templates; excludes MQTT, storage and printing',native:summary(times),frozenPython:summary(reference.times),comparison:templateBenchmarkComparison,medianBudget:nativeTemplateMedianBudget,medianRatio:summary(times).medianMs/summary(reference.times).medianMs},null,2));

assert(summary(times).medianMs/summary(reference.times).medianMs<=nativeTemplateMedianBudget,'Native template median exceeds fixed ratio budget');
