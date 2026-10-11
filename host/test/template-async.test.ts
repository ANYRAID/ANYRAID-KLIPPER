import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {inspect} from 'node:util';
import {SecretsStore,parseSecretsText} from '../src/moonraker/secrets.ts';
import {MoonrakerAsyncTemplateOwner,type TemplateCallable} from '../src/moonraker/template-async-owner.ts';
import {decodeTemplateCall,encodeTemplateValue,decodeTemplateValue,templateFloatValue,type TemplateValue} from '../src/moonraker/template-wire.ts';
const bytes=await readFile(new URL('../contracts/moonraker-template-async-reference.json',import.meta.url));
assert.equal(createHash('sha256').update(bytes).digest('hex'),'ca8132c3b88a912b19b460665e91adcd898244c50ca72b4413cc005b84bdfe9a');
const reference=JSON.parse(bytes.toString()) as {secrets:string;file:string;cases:{name:string;source:string;context:string;ui:boolean;calls:{name:string;args:unknown;kwargs:unknown}[];output?:string;error?:boolean;cancelled?:boolean}[]};
function fixture(){const parsed=parseSecretsText(reference.secrets),secrets=new SecretsStore(reference.file,parsed.type,parsed.values);return {secrets,owner:new MoonrakerAsyncTemplateOwner(secrets)};}
function number(v:TemplateValue|undefined):number{if(typeof v==='bigint')return Number(v);if(v&&typeof v==='object'&&'kind'in v&&v.kind==='float')return v.value;throw Error('unsupported reference scalar');}
for(const row of reference.cases)test('frozen upstream async/UI: '+row.name,async()=>{
 const {secrets,owner}=fixture(),calls:unknown[]=[];
 try{owner.addEnvironmentGlobal('custom','private-global');owner.addEnvironmentGlobal('fetch',()=>templateFloatValue(77));
  const handle=row.ui?owner.createUiTemplate(row.source):owner.createTemplate(row.source);
  const fetch:TemplateCallable=async call=>{calls.push({name:'fetch',...call});await new Promise<void>(resolve=>setImmediate(resolve));return templateFloatValue(number(call.args[0])*(call.kwargs.has('scale')?number(call.kwargs.get('scale')):1));};
  const callables=new Map<string,TemplateCallable>([['fetch',fetch],['fail',async()=>{throw Error('synthetic-private-template');}],['cancel',async()=>{throw new DOMException('cancel-source','AbortError');}]]);
  if(row.error)await assert.rejects(handle.renderAsync(row.context,{callables}),/Private asynchronous template operation failed/);
  else if(row.cancelled)await assert.rejects(handle.renderAsync(row.context,{callables}),{name:'AbortError',message:'cancel-source'});
  else assert.equal(await handle.renderAsync(row.context,{callables}),row.output);
  assert.deepEqual(calls,row.calls.map(c=>({name:c.name,...decodeTemplateCall(c.args,c.kwargs)})));
 }finally{owner.close();secrets.close();}
});
test('numeric callback results keep integer, float, signed zero and nonfinite kinds',async()=>{
 const {secrets,owner}=fixture();try{
  const values:TemplateValue[]=[1n,templateFloatValue(1),templateFloatValue(-0),templateFloatValue(Infinity),templateFloatValue(NaN),9007199254740993n];
  const handle=owner.createTemplate('{value() is integer}/{value()}');
  for(const [index,value] of values.entries())assert.equal(await handle.renderAsync('{}',{callables:new Map([['value',()=>value]])}),['True/1','False/1.0','False/-0.0','False/inf','False/nan','True/9007199254740993'][index]);
  await assert.rejects(handle.renderAsync('{}',{callables:new Map([['value',()=>2n**128n]])}),/Private asynchronous/);
  assert.equal(await handle.renderAsync('{}',{callables:new Map([['value',()=>3n]])}),'True/3');
 }finally{owner.close();secrets.close();}
});
test('globals update existing configuration templates and stay outside UI realm',async()=>{
 const {secrets,owner}=fixture();try{const config=owner.createTemplate('{later()}'),ui=owner.createUiTemplate('{{later is undefined}}/{{secrets is undefined}}');owner.addEnvironmentGlobal('later',async()=>7n);
  assert.equal(await config.renderAsync(),'7');assert.equal(await ui.renderAsync(),'True/True');
  for(const key of ['range','dict','secrets','raise_error','log_debug','later'])assert.throws(()=>owner.addEnvironmentGlobal(key,1n));
 }finally{owner.close();secrets.close();}
});
test('cancellation reaches the real function once and late completion is ignored',async()=>{
 const {secrets,owner}=fixture(),controller=new AbortController(),reason=new DOMException('requested cancellation','AbortError');let count=0,signal!:AbortSignal,release!:(value:TemplateValue)=>void;
 try{const handle=owner.createTemplate('{wait()}');let entered!:()=>void;const ready=new Promise<void>(resolve=>entered=resolve);
  const pending=handle.renderAsync('{}',{signal:controller.signal,callables:new Map([['wait',(_call,got)=>{count++;signal=got;entered();return new Promise(resolve=>release=resolve);} ]])});
  await ready;controller.abort(reason);await assert.rejects(pending,error=>error===reason);assert.equal(signal.reason,reason);assert.equal(count,1);release('late-private');
  assert.equal(await handle.renderAsync('{}',{callables:new Map([['wait',()=>9n]])}),'9');
 }finally{owner.close();secrets.close();}
});
test('deadline and per-template close cancel live callbacks and retain privacy',async()=>{
 const {secrets,owner}=fixture();try{const handle=owner.createTemplate('{slow()}');let got!:AbortSignal,entered!:()=>void;const ready=new Promise<void>(resolve=>entered=resolve);
  const pending=handle.renderAsync('{}',{timeoutMs:30,callables:new Map([['slow',(_call,signal)=>{got=signal;entered();return new Promise<TemplateValue>(()=>{});} ]])});
  await ready;await assert.rejects(pending,/deadline|Private asynchronous/);assert(got.aborted);
  const active=handle.renderAsync('{}',{callables:new Map([['slow',()=>new Promise<TemplateValue>(()=>{})]])});handle.close();await assert.rejects(active,/closed/);await assert.rejects(handle.renderAsync(),/closed/);
  for(const object of [owner,handle])for(const privateText of ['synthetic-private-template','/synthetic','slow()'])assert(!inspect(object).includes(privateText)&&!JSON.stringify(object).includes(privateText));
 }finally{owner.close();secrets.close();}
});
test('queue bounds reject excess work; blocked native callbacks leave event loop and file IO usable',async()=>{
 const {secrets,owner}=fixture();try{const handle=owner.createTemplate('{slow()}');const calls=new Map<string,TemplateCallable>([['slow',()=>new Promise<TemplateValue>(()=>{})]]);
  const pending=Array.from({length:32},()=>handle.renderAsync('{}',{callables:calls}));const observed=pending.map(p=>p.catch(e=>e));
  await assert.rejects(handle.renderAsync('{}',{callables:calls}));
  const file=await readFile(new URL('../contracts/moonraker-template-async-reference.json',import.meta.url));assert(file.length>0);
  await new Promise<void>(resolve=>setTimeout(resolve,5));owner.close();const results=await Promise.all(observed);assert(results.every(e=>e instanceof Error));
 }finally{owner.close();secrets.close();}
});
test('bounded errors discard partial private output; invalid raw context and fuel exhaustion are reusable',async()=>{
 const {secrets,owner}=fixture();try{const partial=owner.createTemplate('{secrets["ldap"]["password"]}{fail()}');
  assert.throws(()=>owner.createTemplate('{%'),/Private asynchronous/);assert.throws(()=>owner.createUiTemplate('{{'),/Private asynchronous/);
  await assert.rejects(partial.renderAsync('{}',{callables:new Map([['fail',()=>{throw Error('synthetic-private-template');}]])}),e=>!inspect(e).includes('synthetic-private-template'));
  const text=owner.createTemplate('{x}');for(const ctx of ['[]','{"x":1e999}','{"x":170141183460469231731687303715884105728}'])await assert.rejects(text.renderAsync(ctx));assert.equal(await text.renderAsync('{"x":1.0}'),'1.0');
  await assert.rejects(owner.createTemplate('{"x"*65537}').renderAsync());await assert.rejects(owner.createTemplate('{% for i in range(1000000) %}{% set j=i %}{% endfor %}').renderAsync());
  assert.equal((await owner.createTemplate('{\'"\'*65536}').renderAsync()).length,65536,'completion JSON escaping must not reduce the output byte budget');
 }finally{owner.close();secrets.close();}
});
test('wire codec enforces explicit kinds and bounded well formed data',()=>{
 const value=new Map<TemplateValue,TemplateValue>([['i',2n],['f',templateFloatValue(-0)],['v',[true,null,'text',templateFloatValue(NaN)]]]);assert.deepEqual(decodeTemplateValue(encodeTemplateValue(value)),value);
 assert.throws(()=>encodeTemplateValue(1 as unknown as TemplateValue));assert.throws(()=>encodeTemplateValue('\ud800'));assert.throws(()=>encodeTemplateValue('x'.repeat(65537)));
 for(const text of ['["integer","01"]','["integer","+1"]','["float","NaN"]','["float","1e999"]','["none",1]'])assert.throws(()=>decodeTemplateValue(text));
 assert.throws(()=>decodeTemplateCall([],[['x',['none']],['x',['none']]]));let nested:TemplateValue=null;for(let i=0;i<66;i++)nested=[nested];assert.throws(()=>encodeTemplateValue(nested));
});
