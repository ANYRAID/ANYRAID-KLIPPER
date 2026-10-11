import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {inspect} from 'node:util';
import {createRequire} from 'node:module';
import {SecretsStore,parseSecretsText} from '../src/moonraker/secrets.ts';
import {MoonrakerTemplateOwner,type SyncTemplateCallable} from '../src/moonraker/template-owner.ts';
import {decodeTemplateCall,templateFloatValue,type TemplateValue} from '../src/moonraker/template-wire.ts';
const bytes=await readFile(new URL('../contracts/moonraker-template-sync-functions-reference.json',import.meta.url));
assert.equal(createHash('sha256').update(bytes).digest('hex'),'2e9660b536d78469ac909b7667c7cfbb9eb3c264f4c714e279fb2666b6592b02');
const reference=JSON.parse(bytes.toString()) as {secrets:string;file:string;cases:{name:string;source:string;context:string;useGlobal:boolean;calls:{name:string;args:unknown;kwargs:unknown}[];output?:string;error?:boolean}[]};
function fixture(){const parsed=parseSecretsText(reference.secrets),secrets=new SecretsStore(reference.file,parsed.type,parsed.values);return {secrets,owner:new MoonrakerTemplateOwner(secrets)};}
function scalar(value:TemplateValue|undefined):number{if(typeof value==='bigint')return Number(value);if(value&&typeof value==='object'&&'kind'in value&&value.kind==='float')return value.value;throw Error('invalid reference scalar');}
for(const row of reference.cases)test('frozen upstream sync callable: '+row.name,()=>{
 const {secrets,owner}=fixture(),calls:unknown[]=[];
 const remember=(call:Parameters<SyncTemplateCallable>[0])=>calls.push({name:'fetch',args:call.args,kwargs:call.kwargs});
 try{owner.addEnvironmentGlobal('custom','private-global');owner.addEnvironmentGlobal('fetch',call=>{remember(call);return templateFloatValue(77);});
  const fetch:SyncTemplateCallable=call=>{remember(call);return templateFloatValue(scalar(call.args[0])*(call.kwargs.has('scale')?scalar(call.kwargs.get('scale')):1));};
  const callables=new Map<string,SyncTemplateCallable>([['fetch',fetch],['fail',()=>{throw Error('synthetic-private-template');}],['nan',()=>templateFloatValue(NaN)],['zero',()=>templateFloatValue(-0)]]);
  const handle=owner.createTemplate(row.source),options=row.useGlobal?{}:{callables};
  if(row.error)assert.throws(()=>handle.render(row.context,options),/Error rendering private template/);else assert.equal(handle.render(row.context,options),row.output);
  assert.deepEqual(calls,row.calls.map(call=>({name:call.name,...decodeTemplateCall(call.args,call.kwargs)})));
 }finally{owner.close();secrets.close();}
});
test('synchronous globals update existing templates and raw context shadows them',()=>{
 const {secrets,owner}=fixture();try{const handle=owner.createTemplate('{later(2)}:{label}');owner.addEnvironmentGlobal('label','registered');owner.addEnvironmentGlobal('later',call=>call.args[0]!);
  assert.equal(handle.render(),'2:registered');assert.equal(handle.render('{"label":"context"}'),'2:context');
  for(const key of ['later','range','dict','secrets','raise_error','log_debug'])assert.throws(()=>owner.addEnvironmentGlobal(key,1n));
 }finally{owner.close();secrets.close();}
});
test('nested calls on the same template use independent native and JS frames',()=>{
 const {secrets,owner}=fixture(),seen:TemplateValue[]=[];try{const handle=owner.createTemplate('{fetch(i)}');
  const fetch:SyncTemplateCallable=call=>{seen.push(call.args[0]!);return call.args[0]===1n?'nested:'+handle.render('{"i":2}',{callables:new Map([['fetch',fetch]])}):templateFloatValue(4);};
  assert.equal(handle.render('{"i":1}',{callables:new Map([['fetch',fetch]])}),'nested:4.0');assert.deepEqual(seen,[1n,2n]);
  assert.equal(handle.render('{"i":2}',{callables:new Map([['fetch',fetch]])}),'4.0');
 }finally{owner.close();secrets.close();}
});
for(const closeOwner of [false,true])test('closing '+(closeOwner?'owner':'template')+' inside a callback stops later effects and publication',()=>{
 const {secrets,owner}=fixture();let count=0;
 try{const handle=owner.createTemplate('{secrets["ldap"]["password"]}{stop()}{next()}');
  assert.throws(()=>handle.render('{}',{callables:new Map([['stop',()=>{if(closeOwner)owner.close();else handle.close();return 1n;}],['next',()=>{count++;return 2n;}]])}),error=>/Error rendering private template/.test(String(error))&&!inspect(error).includes('synthetic-private-template'));
  assert.equal(count,0);assert.throws(()=>handle.render(),/closed/);
 }finally{owner.close();secrets.close();}
});
test('synchronous calls reject promises and private errors while remaining reusable',async()=>{
 const {secrets,owner}=fixture();try{const handle=owner.createTemplate('{value()}');
  for(const fn of [()=>{throw Error('synthetic-private-template');},()=>Promise.reject(Error('synthetic-private-template')),()=>2n**128n])assert.throws(()=>handle.render('{}',{callables:new Map([['value',fn as SyncTemplateCallable]])}),error=>/Error rendering/.test(String(error))&&!inspect(error).includes('synthetic-private-template'));
  await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(handle.render('{}',{callables:new Map([['value',()=>9007199254740993n]])}),'9007199254740993');
  for(const [value,expected] of [[1n,'1'],[templateFloatValue(1),'1.0'],[templateFloatValue(-0),'-0.0'],[templateFloatValue(Infinity),'inf'],[templateFloatValue(NaN),'nan']] as const)assert.equal(handle.render('{}',{callables:new Map([['value',()=>value]])}),expected);
 }finally{owner.close();secrets.close();}
});
test('recursive render scope and side-effect count are bounded and cleaned after failure',()=>{
 const {secrets,owner}=fixture();try{const handle=owner.createTemplate('{recur(n)}');let count=0;
  const recur:SyncTemplateCallable=call=>{count++;const n=call.args[0] as bigint;return n>0n?handle.render('{"n":'+(n-1n)+'}',{callables:new Map([['recur',recur]])}):0n;};
  assert.throws(()=>handle.render('{"n":17}',{callables:new Map([['recur',recur]])}),/Error rendering/);assert.equal(count,16);
  assert.equal(handle.render('{"n":1}',{callables:new Map([['recur',recur]])}),'0');
  count=0;assert.throws(()=>owner.createTemplate('{% for i in range(65) %}{call()}{% endfor %}').render('{}',{callables:new Map([['call',()=>{count++;return 1n;}]])}),/Error rendering/);assert.equal(count,64);
  assert.equal(handle.render('{"n":0}',{callables:new Map([['recur',recur]])}),'0');
 }finally{owner.close();secrets.close();}
});
test('raw synchronous native callback exceptions are consumed and private; later frames remain usable',()=>{
 const addon=createRequire(import.meta.url)('../build/template.node') as {NativeTextTemplate:new(source:string,secrets:string,file:string,type:string)=>{renderWithFunctions(context:string,names:string[],callback:(message:string)=>string):string;close():void}};
 const handle=new addon.NativeTextTemplate('{value()}','{}','/synthetic/native','json');
 try{assert.throws(()=>handle.renderWithFunctions('{}',['value'],()=>{throw Error('synthetic-private-template');}),error=>/Private template operation failed/.test(String(error))&&!inspect(error).includes('synthetic-private-template'));
  assert.equal(handle.renderWithFunctions('{}',['value'],()=>'["float","-0"]'),'-0.0');
 }finally{handle.close();}
});
