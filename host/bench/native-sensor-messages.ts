import {templateBenchmarkReference,templateBenchmarkComparison,templateBenchmarkSummary,nativeTemplateMedianBudget} from './template-benchmark-reference.ts';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {NativeSensorMessages} from '../src/moonraker/native-sensor-config.ts';
import {SensorStore} from '../src/moonraker/sensors.ts';
import {HistoryFields} from '../src/moonraker/history-fields.ts';
const definition={id:'room',type:'MQTT',history:[{name:'power',parameter:'power',description:'Reading',strategy:'average' as const}]};
const template='{% set d=payload|fromjson %}{set_result("power",d.power|float)}{set_result("voltage",d.voltage|float)}{set_result("current",d.current|float)}{set_result("energy",d.energy|float * 0.000001)}';
const payload='{"power":25.5,"voltage":230.0,"current":0.125,"energy":1200}';
const reference=templateBenchmarkReference<{times:number[];info:unknown;fields:unknown}>('native-sensor-messages',{source:template,payload,definition,frames:10000,warmup:2,samples:7}),times=[];
for(let run=0;run<9;run++){
 const fields=new HistoryFields(()=>true),store=new SensorStore();store.register(definition,fields);const receiver=new NativeSensorMessages(store,'room',template),bytes=Buffer.from(payload);
 try{const start=performance.now();for(let i=0;i<10000;i++)receiver.receive(bytes);if(run>=2)times.push(performance.now()-start);assert.equal(receiver.status.accepted,10000);assert.deepEqual(store.info('room',true),reference.info);assert.deepEqual(fields.snapshot().data,reference.fields);}finally{receiver.close();store.close();}
}
const summary=templateBenchmarkSummary;
console.log(JSON.stringify({node:process.version,frames:10000,warmup:2,samples:7,scope:'Byte decoding, original template syntax, typed JSON and four callbacks, SensorStore and average history; excludes MQTT and printing',native:summary(times),frozenPython:summary(reference.times),comparison:templateBenchmarkComparison,medianBudget:nativeTemplateMedianBudget,medianRatio:summary(times).medianMs/summary(reference.times).medianMs},null,2));

assert(summary(times).medianMs/summary(reference.times).medianMs<=nativeTemplateMedianBudget,'Native template median exceeds fixed ratio budget');
