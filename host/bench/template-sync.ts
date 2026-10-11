import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {SecretsStore,parseSecretsText} from '../src/moonraker/secrets.ts';
import {MoonrakerTemplateOwner} from '../src/moonraker/template-owner.ts';
// Budgets fixed before candidate measurement. Synthetic file values only.
const budgets={renderToJinja:1.5,coldToJinja:1.5,fuelFailureMaxMs:25,secretsParseToBaseline:1.2,secretsCachedToBaseline:1.2};
const source='{secrets["ldap"]["base"]}/{secrets["large"]+2}/{value.f is integer}',context='{"value":{"f":1.0}}',expected='dc=example,dc=test/9007199254740995/False';
const referenceBytes=await readFile(new URL('../contracts/moonraker-template-sync-reference.json',import.meta.url));
assert.equal(createHash('sha256').update(referenceBytes).digest('hex'),'34c13d8c3779362b77720ec0651086cc40df2dbf22630772dd831e6967b7e7d2','Frozen template input hash mismatch');
const reference=JSON.parse(referenceBytes.toString());
const repetitions={render:3000,cold:100,parse:2000,cached:1000000},warmups=2,samples=7;
const summary=(runs:number[])=>{const sorted=[...runs].sort((a,b)=>a-b);return {samplesMs:runs,medianMs:sorted[Math.floor(sorted.length/2)],p95Ms:sorted[Math.ceil(sorted.length*0.95)-1]};};
const frozenBytes=await readFile(new URL('../contracts/template-sync-performance-reference.json',import.meta.url));
assert.equal(createHash('sha256').update(frozenBytes).digest('hex'),'d599fa25d7da01ad9973bbdfb1980e134c30a9bd7596237b564fca0a8cae130e','Frozen template performance reference hash mismatch');
const frozen=JSON.parse(frozenBytes.toString()),performanceReference=frozen.performance;
assert.deepEqual(performanceReference.upstream,reference.upstream);assert.deepEqual(performanceReference.repetitions,repetitions);assert.deepEqual(performanceReference.budgets,budgets);assert.equal(performanceReference.warmups,warmups);assert.equal(performanceReference.samples,samples);
assert.equal(performanceReference.inputs.sourceSha256,createHash('sha256').update(source).digest('hex'));assert.equal(performanceReference.inputs.contextSha256,createHash('sha256').update(context).digest('hex'));
for(const row of [...Object.values(performanceReference.jinja),...Object.values(performanceReference.baseline.old)] as {samplesMs:number[];medianMs:number}[]){assert.equal(row.samplesMs.length,samples);assert(row.samplesMs.every(value=>Number.isFinite(value)&&value>0));assert.equal(summary(row.samplesMs).medianMs,row.medianMs);}
const parsed=parseSecretsText(reference.secrets),secrets=new SecretsStore(reference.file,parsed.type,parsed.values),owner=new MoonrakerTemplateOwner(secrets),template=owner.createTemplate(source),times={render:[] as number[],cold:[] as number[]};
try{
 for(let run=0;run<warmups+samples;run++){
  let output='';let start=performance.now();for(let i=0;i<repetitions.render;i++)output=template.render(context);assert.equal(output,expected);if(run>=warmups)times.render.push(performance.now()-start);
  start=performance.now();for(let i=0;i<repetitions.cold;i++)owner.createTemplate(source).close();if(run>=warmups)times.cold.push(performance.now()-start);
 }
 const exhausted=owner.createTemplate('{% for i in range(1000000) %}{% set v=i %}{% endfor %}'),start=performance.now();assert.throws(()=>exhausted.render());const fuelFailureMs=performance.now()-start;exhausted.close();
 const native=Object.fromEntries(Object.entries(times).map(([name,runs])=>[name,summary(runs)])),jinja=Object.fromEntries(Object.entries(performanceReference.jinja).map(([name,runs])=>[name,summary((runs as {samplesMs:number[]}).samplesMs)]));
 const text=JSON.stringify(Object.fromEntries(Array.from({length:32},(_,i)=>['section'+i,{password:'synthetic-value-'.repeat(4),index:String(i)}]))),rows={parse:[] as number[],cached:[] as number[]},store=new SecretsStore('/synthetic/baseline','json',parseSecretsText(text).values);
 try{for(let run=0;run<warmups+samples;run++){let sum=0,start=performance.now();for(let i=0;i<repetitions.parse;i++)sum+=Object.keys(parseSecretsText(text).values).length;assert.equal(sum,32*repetitions.parse);if(run>=warmups)rows.parse.push(performance.now()-start);sum=0;start=performance.now();for(let i=0;i<repetitions.cached;i++)sum+=typeof store.item('section31')==='object'?1:0;assert.equal(sum,repetitions.cached);if(run>=warmups)rows.cached.push(performance.now()-start);}}finally{store.close();}
 const old=performanceReference.baseline.old,current={parse:summary(rows.parse),cached:summary(rows.cached)},baseline={old,current,parseRatio:current.parse.medianMs/old.parse.medianMs,cachedRatio:current.cached.medianMs/old.cached.medianMs};
 const result={schema:1,node:process.version,rust:'1.89.0',engine:'minijinja 2.24.0 via N-API',upstream:reference.upstream,repetitions,warmups,samples,inputs:{sourceSha256:createHash('sha256').update(source).digest('hex'),contextSha256:createHash('sha256').update(context).digest('hex')},budgets,native,jinja,frozenPythonRuntime:performanceReference.python,referenceEvidence:frozen.originalEvidence,comparison:'Historical frozen reference; no Python process and no same-run comparison',ratios:{render:native.render.medianMs/jinja.render.medianMs,cold:native.cold.medianMs/jinja.cold.medianMs},fuelFailureMs,baseline,scope:'Desktop synchronous private text rendering, compilation and old secrets hot-path regression. No MCU, printing, target-board, async callable or full-template compatibility claim.'};
 console.log(JSON.stringify(result));
 assert(result.ratios.render<=budgets.renderToJinja);assert(result.ratios.cold<=budgets.coldToJinja);assert(fuelFailureMs<=budgets.fuelFailureMaxMs);
 assert(baseline.parseRatio<=budgets.secretsParseToBaseline);assert(baseline.cachedRatio<=budgets.secretsCachedToBaseline);
}finally{template.close();owner.close();secrets.close();}
