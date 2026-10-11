import {templateBenchmarkReference,templateBenchmarkComparison,templateBenchmarkSummary,nativeTemplateMedianBudget} from './template-benchmark-reference.ts';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {NativeTemplateCandidate} from '../src/moonraker/native-template.ts';
const source='{% set notification = payload|fromjson %}{set_result("power", notification["apower"]|float)}{set_result("voltage", notification["voltage"]|float)}{set_result("current", notification["current"]|float)}{set_result("energy", notification["aenergy"]["by_minute"][0]|float * 0.000001)}';
const payload='{"apower":25.5,"voltage":230.0,"current":0.125,"aenergy":{"by_minute":[1200]}}';
const reference=templateBenchmarkReference<{times:number[];values:Record<string,number>}>('native-template',{source,payload,renders:3000,warmup:2,samples:7}),template=new NativeTemplateCandidate(source),times=[];
try{for(let run=0;run<9;run++){let values;const start=performance.now();for(let i=0;i<3000;i++)values=template.render(payload);if(run>=2)times.push(performance.now()-start);assert.deepEqual(Object.fromEntries(values!.map(value=>[value.name,value.numberValue])),reference.values);assert.ok(values!.every(value=>value.numberType==='float'));}}finally{template.close();}
const summary=templateBenchmarkSummary;console.log(JSON.stringify({node:process.version,engine:'minijinja-2.24.0 via N-API',rust:'1.89.0',renders:3000,warmup:2,samples:7,scope:'Original Moonraker Shelly syntax, native typed JSON/filters/readings versus Jinja2; no MQTT or SensorStore',native:summary(times),frozenPython:summary(reference.times),comparison:templateBenchmarkComparison,medianBudget:nativeTemplateMedianBudget,medianRatio:summary(times).medianMs/summary(reference.times).medianMs},null,2));

assert(summary(times).medianMs/summary(reference.times).medianMs<=nativeTemplateMedianBudget,'Native template median exceeds fixed ratio budget');
