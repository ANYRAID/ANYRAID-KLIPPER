import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {inspect} from 'node:util';
import {createRequire} from 'node:module';
import {SecretsStore,parseSecretsText} from '../src/moonraker/secrets.ts';
import {MoonrakerAsyncTemplateOwner,type TemplateCallable,type TemplateInvocation} from '../src/moonraker/template-async-owner.ts';
import {decodeTemplateCall,encodeTemplateValue,decodeTemplateValue,templateFloatValue,type TemplateValue} from '../src/moonraker/template-wire.ts';
const bytes=await readFile(new URL('../contracts/moonraker-template-async-reference.json',import.meta.url));
assert.equal(createHash('sha256').update(bytes).digest('hex'),'ca8132c3b88a912b19b460665e91adcd898244c50ca72b4413cc005b84bdfe9a');
const reference=JSON.parse(bytes.toString()) as {secrets:string;file:string;cases:{name:string;source:string;context:string;ui:boolean;calls:{name:string;args:unknown;kwargs:unknown}[];output?:string;error?:boolean;cancelled?:boolean}[]};
function fixture(){const parsed=parseSecretsText(reference.secrets),secrets=new SecretsStore(reference.file,parsed.type,parsed.values);return {secrets,owner:new MoonrakerAsyncTemplateOwner(secrets)};}
test('repeated typed contexts retain independent callable frames and recover after invalid input',async()=>{
 const {secrets,owner}=fixture();try{
  const first='{"id":"one","number":1.0,"negative":-0.0,"payload":{"large":9007199254740993}}',second='{"id":"two","number":1,"negative":0,"payload":{"large":9007199254740995}}';
  for(const ui of [false,true]){
   const source='{{id}}/{{number is integer}}/{{number}}/{{negative}}/{{payload.large+1}}/{{read(number)}}',handle=ui?owner.createUiTemplate(source):owner.createTemplate(source.replaceAll('{{','{').replaceAll('}}','}'));
   const render=(context:string,tag:string)=>handle.renderAsync(context,{callables:new Map([['read',async invocation=>{assert.equal(invocation.args.length,1);await new Promise<void>(resolve=>setImmediate(resolve));return tag;}]])});
   try{
    for(let i=0;i<3;i++)assert.equal(await render(first,'repeat'+i),'one/False/1.0/-0.0/9007199254740994/repeat'+i);
    const jobs=Array.from({length:8},(_,i)=>render(i%2?second:first,'job'+i));
    assert.deepEqual(await Promise.all(jobs),Array.from({length:8},(_,i)=>(i%2?'two/True/1/0/9007199254740996/':'one/False/1.0/-0.0/9007199254740994/')+'job'+i));
    await assert.rejects(render('[1]','invalid'));await assert.rejects(render('{','invalid'));
    assert.equal(await render(first,'recovered'),'one/False/1.0/-0.0/9007199254740994/recovered');
   }finally{handle.close();}
  }
 }finally{owner.close();secrets.close();}
});
test('native call envelope includes escaped bytes and rejects overflow before invoking a callback',async()=>{
 const {secrets,owner}=fixture();let calls=0;
 try{
  const overhead=Buffer.byteLength(JSON.stringify({render:1,call:1,name:'fetch',args:[['string','']],kwargs:[]})),length=65536-overhead;
  const capability=new Map<string,TemplateCallable>([['fetch',invocation=>{calls++;assert.equal(Buffer.byteLength(invocation.args[0] as string),length);return 1n;}]]);
  const exact=owner.createUiTemplate('{{fetch("x"*'+length+')}}');assert.equal(await exact.renderAsync('{}',{callables:capability}),'1');assert.equal(calls,1);exact.close();
  for(const source of ['{{fetch("x"*'+(length+1)+')}}','{{fetch("\\n"*'+Math.floor(length/2+1)+')}}']){
   const overflow=owner.createUiTemplate(source);await assert.rejects(overflow.renderAsync('{}',{callables:capability}),/Private asynchronous/);overflow.close();assert.equal(calls,1,'overflow may not cross the capability boundary');
  }
 }finally{owner.close();secrets.close();}
});
test('bounded callback arguments retain nested map/list kinds, i128 limits, negative zero and Unicode',async()=>{
 const {secrets,owner}=fixture();try{
  const handle=owner.createUiTemplate('{{fetch(value, named=value)}}'),value={text:'"\\\n😀',integer:'not numeric',list:[null,true,false,170141183460469231731687303715884105727n]},text='{"value":{"text":"\\\"\\\\\\n😀","integer":"not numeric","list":[null,true,false,170141183460469231731687303715884105727],"minimum":-170141183460469231731687303715884105728,"negative":-0.0,"float":1.0}}';
  const expected=new Map<TemplateValue,TemplateValue>([['text',value.text],['integer',value.integer],['list',Object.freeze(value.list)],['minimum',-(2n**127n)],['negative',templateFloatValue(-0)],['float',templateFloatValue(1)]]);
  let count=0;assert.equal(await handle.renderAsync(text,{callables:new Map([['fetch',invocation=>{count++;assert.deepEqual(invocation.args,[expected]);assert.deepEqual(invocation.kwargs,new Map([['named',expected]]));return 'ok';}]])}),'ok');assert.equal(count,1);
  handle.close();
 }finally{owner.close();secrets.close();}
});
test('native callback responses reject stale, future and duplicate replies across 64 calls',async()=>{
 const addon=createRequire(import.meta.url)('../build/template.node') as {NativeTemplateExecutor:new(callback:(message:string,id:number,failed:boolean)=>void)=>{createTemplate(source:string,secrets:string,file:string,type:string,ui:boolean):{render(context:string,callables:string[],id:number,timeout:number):void;close():void};respondFloat(id:number,call:number,value:number):boolean;close():void}};
 const completed=Promise.withResolvers<string>(),seen:number[]=[],expected=Array.from({length:64},(_,i)=>i+'.0').join('/');let native:InstanceType<typeof addon.NativeTemplateExecutor>|undefined;
 const timer=setTimeout(()=>completed.reject(new Error('Native callback regression timeout')),5000);
 try{
  native=new addon.NativeTemplateExecutor((message,id,failed)=>{try{
   if(id!==0){assert.equal(id,101);assert.equal(failed,false);completed.resolve(message);return;}
   const row=JSON.parse(message),args=decodeTemplateCall(row.args,row.kwargs);assert.equal(row.render,101);assert.equal(row.call,seen.length+1);assert.equal(row.name,'fetch');
   assert.equal(args.args[0],BigInt(seen.length));assert.equal(args.kwargs.get('note'),'"\\\n😀');seen.push(row.call);
   assert.equal(native!.respondFloat(101,row.call+1,999),false,'future response must be refused before current reply');
   assert.equal(native!.respondFloat(101,row.call-1,999),false,'prior reply must not replace the current reply');
   assert.equal(native!.respondFloat(999,row.call,999),false,'another frame cannot consume this reply');
   assert.equal(native!.respondFloat(101,row.call,seen.length-1),true);
   assert.equal(native!.respondFloat(101,row.call,999),false,'duplicate reply is refused');
  }catch(error){completed.reject(error);}});
  const handle=native.createTemplate('{% for i in range(64) %}{{fetch(i, note=note)}}{% if not loop.last %}/{% endif %}{% endfor %}','{}','','json',true);
  try{handle.render(JSON.stringify({note:'"\\\n😀'}),['fetch'],101,5000);assert.equal(await completed.promise,expected);assert.equal(seen.length,64);}finally{handle.close();}
 }finally{clearTimeout(timer);native?.close();}
});
test('two native lanes isolate sequential typed callbacks from a failed frame',async()=>{
 const {secrets,owner}=fixture();try{
  const handle=owner.createUiTemplate('{% for i in range(64) %}{{value(i)}}{% if not loop.last %}/{% endif %}{% endfor %}');
  const jobs=Array.from({length:8},(_,job)=>{
   let count=0;const calls=new Map<string,TemplateCallable>([['value',async invocation=>{
    assert.equal(invocation.args[0],BigInt(count));await new Promise<void>(resolve=>setImmediate(resolve));const index=count++;
    if(job===3&&index===7)throw new Error('synthetic reply-slot failure');
    return index%2?templateFloatValue(-0):BigInt(job*100+index);
   }]]);
   return handle.renderAsync('{}',{callables:calls}).then(output=>{assert.notEqual(job,3);assert.equal(count,64);assert.equal(output,Array.from({length:64},(_,i)=>i%2?'-0.0':String(job*100+i)).join('/'));},error=>{assert.equal(job,3);assert.equal(count,8);assert.match(String(error),/Private asynchronous/);});
  });await Promise.all(jobs);assert.equal(await owner.createUiTemplate('{{value()}}').renderAsync('{}',{callables:new Map([['value',()=>9007199254740993n]])}),'9007199254740993');
 }finally{owner.close();secrets.close();}
});
test('direct async and UI completion preserves empty, escaped and UTF-8 byte-boundary output',async()=>{
 const {secrets,owner}=fixture();try{
  for(const ui of [false,true]){
   const handle=ui?owner.createUiTemplate('{{text}}'):owner.createTemplate('{text}');
   for(const value of ['', 'a\0\n"\\😀z'])assert.equal(await handle.renderAsync(JSON.stringify({text:value})),value);
   const boundary=ui?owner.createUiTemplate("{{'😀'*16384}} "):owner.createTemplate("{'😀'*16384} ");
   // The output budget is independent of the raw context JSON envelope.
   // Generate exactly 64 KiB rather than exceeding the context input limit.
   await assert.rejects(boundary.renderAsync(),/Private asynchronous/);boundary.close();
   const full=ui?owner.createUiTemplate("{{'😀'*16384}}"):owner.createTemplate("{'😀'*16384}");
   assert.equal(await full.renderAsync(),'😀'.repeat(16384));full.close();
   assert.equal(await handle.renderAsync('{"text":"reused"}'),'reused');handle.close();
  }
 }finally{owner.close();secrets.close();}
});
test('pure async and UI completion cannot overtake caller microtask cancellation',async()=>{
 const {secrets,owner}=fixture();try{
  for(const ui of [false,true]){
   const handle=ui?owner.createUiTemplate('{{3}}'):owner.createTemplate('{3}'),controller=new AbortController(),reason={cancelled:'before completion delivery',ui};
   const pending=handle.renderAsync('{}',{signal:controller.signal});queueMicrotask(()=>controller.abort(reason));
   await assert.rejects(pending,error=>error===reason);assert.equal(await handle.renderAsync(),'3');handle.close();
  }
 }finally{owner.close();secrets.close();}
});
test('completion observers cannot replace the first result through reentrant cancellation or generation closure',async()=>{
 for(const close of[false,true]){const {secrets,owner}=fixture(),external=new AbortController();let ended:AbortSignal|undefined;
  try{const handle=owner.createUiTemplate('{{answer()}}'),render=handle.renderAsync('{}',{signal:external.signal,callables:new Map([['answer',call=>{ended=call.signal;call.signal.addEventListener('abort',()=>{if(close)owner.close();else external.abort({late:'after completion'});},{once:true});return 9n;}]])});
   assert.equal(await render,'9');assert.equal(ended?.aborted,true);assert.equal(ended?.reason.message,'Template render completed');assert.equal(owner.toJSON().renders,0);if(close)assert.equal(owner.toJSON().closed,true);else assert.equal(external.signal.aborted,true);
  }finally{owner.close();secrets.close();}
 }
});
test('synchronous native admission failures stay rejected promises and release render capacity',async()=>{
 const {secrets,owner}=fixture();try{const handle=owner.createUiTemplate('{{3}}');for(let i=0;i<64;i++){let render!:Promise<string>;assert.doesNotThrow(()=>{render=handle.renderAsync('[');});assert(render instanceof Promise);await assert.rejects(render);assert.equal(owner.toJSON().renders,0);}assert.equal(await handle.renderAsync(),'3');handle.close();}finally{owner.close();secrets.close();}
});
test('late globals copy the template generation without changing an active native render',async()=>{
 const {secrets,owner}=fixture();let release!:(value:TemplateValue)=>void,entered!:()=>void;
 try{
  const handle=owner.createTemplate('{wait()}:{later is defined}'),ready=new Promise<void>(resolve=>entered=resolve);
  const pending=handle.renderAsync('{}',{callables:new Map([['wait',()=>{entered();return new Promise<TemplateValue>(resolve=>release=resolve);}]])});
  await ready;owner.addEnvironmentGlobal('later',7n);release('first');assert.equal(await pending,'first:False');
  assert.equal(await handle.renderAsync('{}',{callables:new Map([['wait',()=> 'next']])}),'next:True');
  assert.equal(await owner.createUiTemplate('{{later is undefined}}').renderAsync(),'True');
 }finally{release?.('cleanup');owner.close();secrets.close();}
});
test('one owner timer preserves independent active and queued deadlines and cancellation reasons',async()=>{
 const {secrets,owner}=fixture();try{
  const handle=owner.createTemplate('{wait()}');let entered!:()=>void,release!:(value:TemplateValue)=>void;
  const ready=new Promise<void>(resolve=>entered=resolve),controller=new AbortController(),reason={requested:'long frame'};
  const long=handle.renderAsync('{}',{signal:controller.signal,callables:new Map([['wait',()=>{entered();return new Promise<TemplateValue>(resolve=>release=resolve);}]])});
  const observedLong=long.catch(error=>error);await ready;
  const wait=new Map<string,TemplateCallable>([['wait',()=>new Promise<TemplateValue>(()=>{})]]);
  const medium=handle.renderAsync('{}',{timeoutMs:80,callables:wait}).catch(error=>error);
  const queued=handle.renderAsync('{}',{timeoutMs:20,callables:wait}).catch(error=>error);
  assert.match(String(await queued),/deadline|Private asynchronous/);assert.equal(controller.signal.aborted,false);
  assert.match(String(await medium),/deadline|Private asynchronous/);assert.equal(controller.signal.aborted,false);
  controller.abort(reason);assert.equal(await observedLong,reason);release('late');
  assert.equal(await handle.renderAsync('{}',{callables:new Map([['wait',()=>9n]])}),'9');
  await assert.rejects(handle.renderAsync('{}',{timeoutMs:10,callables:wait}),/deadline|Private asynchronous/);
 }finally{owner.close();secrets.close();}
});
function number(v:TemplateValue|undefined):number{if(typeof v==='bigint')return Number(v);if(v&&typeof v==='object'&&'kind'in v&&v.kind==='float')return v.value;throw Error('unsupported reference scalar');}
for(const row of reference.cases)test('frozen upstream async/UI: '+row.name,async()=>{
 const {secrets,owner}=fixture(),calls:unknown[]=[];
 try{owner.addEnvironmentGlobal('custom','private-global');owner.addEnvironmentGlobal('fetch',()=>templateFloatValue(77));
  const handle=row.ui?owner.createUiTemplate(row.source):owner.createTemplate(row.source);
  const fetch:TemplateCallable=async call=>{calls.push({name:'fetch',args:call.args,kwargs:call.kwargs});await new Promise<void>(resolve=>setImmediate(resolve));return templateFloatValue(number(call.args[0])*(call.kwargs.has('scale')?number(call.kwargs.get('scale')):1));};
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
  const pending=handle.renderAsync('{}',{signal:controller.signal,callables:new Map([['wait',call=>{count++;signal=call.signal;entered();return new Promise(resolve=>release=resolve);} ]])});
  await ready;controller.abort(reason);await assert.rejects(pending,error=>error===reason);assert.equal(signal.reason,reason);assert.equal(count,1);release('late-private');
  assert.equal(await handle.renderAsync('{}',{callables:new Map([['wait',()=>9n]])}),'9');
 }finally{owner.close();secrets.close();}
});
test('deadline and per-template close cancel live callbacks and retain privacy',async()=>{
 const {secrets,owner}=fixture();try{const handle=owner.createTemplate('{slow()}');let got!:AbortSignal,entered!:()=>void;const ready=new Promise<void>(resolve=>entered=resolve);
  const pending=handle.renderAsync('{}',{timeoutMs:30,callables:new Map([['slow',call=>{got=call.signal;entered();return new Promise<TemplateValue>(()=>{});} ]])});
  await ready;await assert.rejects(pending,/deadline|Private asynchronous/);assert(got.aborted);
  const active=handle.renderAsync('{}',{callables:new Map([['slow',()=>new Promise<TemplateValue>(()=>{})]])});handle.close();await assert.rejects(active,/closed/);await assert.rejects(handle.renderAsync(),/closed/);
  for(const object of [owner,handle])for(const privateText of ['synthetic-private-template','/synthetic','slow()'])assert(!inspect(object).includes(privateText)&&!JSON.stringify(object).includes(privateText));
 }finally{owner.close();secrets.close();}
});
test('invocation signals share one render lifetime and remain native AbortSignals',async()=>{
 const {secrets,owner}=fixture();try{const handle=owner.createTemplate('{value()}/{value()}'),signals:AbortSignal[]=[];let events=0;
  const callables=new Map<string,TemplateCallable>([['value',call=>{assert(Object.isFrozen(call));assert.throws(()=>Object.assign(call,{signal:new AbortController().signal}));const signal=call.signal;assert(signal instanceof AbortSignal);assert.equal(call.signal,signal);assert.equal(signal.aborted,false);signals.push(signal);signal.addEventListener('abort',()=>events++,{once:true});return 7n;}]]);
  assert.equal(await handle.renderAsync('{}',{callables}),'7/7');assert.equal(signals[0],signals[1]);assert.equal(events,2);assert.equal(signals[0]!.aborted,true);
  assert.throws(()=>signals[0]!.throwIfAborted(),{name:'AbortError',message:'Template render completed'});
  assert.equal(await handle.renderAsync('{}',{callables}),'7/7');assert.notEqual(signals[0],signals[2]);assert.equal(signals[2],signals[3]);assert.equal(events,4);
 }finally{owner.close();secrets.close();}
});
test('first signal access after successful completion observes the ended lifetime',async()=>{
 const {secrets,owner}=fixture();let invocation!:TemplateInvocation;
 try{assert.equal(await owner.createTemplate('{value()}').renderAsync('{}',{callables:new Map([['value',call=>{invocation=call;return 8n;}]])}),'8');
  const signal=invocation.signal;assert(signal instanceof AbortSignal);assert.equal(invocation.signal,signal);assert.equal(signal.aborted,true);assert.throws(()=>signal.throwIfAborted(),{name:'AbortError',message:'Template render completed'});
 }finally{owner.close();secrets.close();}
});
test('first signal access after cancellation preserves the original reason and ignores late output',async()=>{
 const {secrets,owner}=fixture(),controller=new AbortController(),reason={requested:true};let invocation!:TemplateInvocation,release!:(value:TemplateValue)=>void,entered!:()=>void;
 const ready=new Promise<void>(resolve=>entered=resolve);
 try{const handle=owner.createTemplate('{value()}'),pending=handle.renderAsync('{}',{signal:controller.signal,callables:new Map([['value',call=>{invocation=call;entered();return new Promise(resolve=>release=resolve);}]])});
  await ready;controller.abort(reason);await assert.rejects(pending,error=>error===reason);assert.equal(invocation.signal.reason,reason);assert.throws(()=>invocation.signal.throwIfAborted(),error=>error===reason);
  release('late');assert.equal(await handle.renderAsync('{}',{callables:new Map([['value',()=>9n]])}),'9');assert.equal(invocation.signal.reason,reason);
 }finally{release?.('cleanup');owner.close();secrets.close();}
});
for(const closeOwner of [false,true])test('first signal access after '+(closeOwner?'owner':'template')+' close observes cancellation',async()=>{
 const {secrets,owner}=fixture();let invocation!:TemplateInvocation,release!:(value:TemplateValue)=>void,entered!:()=>void;const ready=new Promise<void>(resolve=>entered=resolve);
 try{const handle=owner.createTemplate('{wait()}'),pending=handle.renderAsync('{}',{callables:new Map([['wait',call=>{invocation=call;entered();return new Promise(resolve=>release=resolve);}]])});
  await ready;if(closeOwner)owner.close();else handle.close();await assert.rejects(pending,/closed/);assert(invocation.signal.aborted);assert.throws(()=>invocation.signal.throwIfAborted(),/closed/);
 }finally{release?.('late');owner.close();secrets.close();}
});
test('already aborted render never invokes a capability; callback cancellation reaches late signal access',async()=>{
 const {secrets,owner}=fixture(),controller=new AbortController(),reason=new DOMException('callback cancellation','AbortError');let calls=0,invocation!:TemplateInvocation;
 try{const handle=owner.createTemplate('{value()}'),callables=new Map<string,TemplateCallable>([['value',call=>{calls++;invocation=call;throw reason;}]]);controller.abort(reason);
  await assert.rejects(handle.renderAsync('{}',{signal:controller.signal,callables}),error=>error===reason);assert.equal(calls,0);
  await assert.rejects(handle.renderAsync('{}',{callables}),error=>error===reason);assert.equal(calls,1);assert.equal(invocation.signal.reason,reason);
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
