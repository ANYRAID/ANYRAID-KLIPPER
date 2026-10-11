import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {inspect} from 'node:util';
import {MoonrakerTemplateFactory,MoonrakerRenderableTemplate,type TemplateFactoryOptions} from '../src/moonraker/template-factory.ts';
import {ConfigurationSource,ConfigurationError} from '../src/moonraker/config-source.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ApiError,type Json} from '../src/moonraker/rpc.ts';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import {DatabaseStore} from '../src/moonraker/database.ts';
const bytes=await readFile(new URL('../contracts/moonraker-template-factory-reference.json',import.meta.url));
assert.equal(createHash('sha256').update(bytes).digest('hex'),'721c0483ce20450e2f95f4abf1629d5101bfdc97cffb97c8ae3653ece0e104b0');
const reference=JSON.parse(bytes.toString()) as {secrets:string;cases:{name:string;kind:string;method:string;source:string;context:string;originalSource:string;output?:string;error?:boolean;code?:number|null;message?:string}[];configuration:{name:string;section:string;fallback:string|null;method:string;option:string;default:Json;isAsync:boolean;parsed:Json;warningCount:number;error?:boolean;kind?:string;source?:Json;templateAsync?:boolean|null}[]};
async function fixture(values:Record<string,Record<string,string>>={server:{}},options:TemplateFactoryOptions={}){
 const root=await mkdtemp(join(tmpdir(),'template-factory-')),reader=new ConfigurationReader(new ConfigurationSource('/synthetic/factory.conf',values,[]));
 await writeFile(join(root,'moonraker.secrets'),reference.secrets);const factory=await MoonrakerTemplateFactory.load(reader,{dataPath:root},options);
 return {root,reader,factory,async close(){factory.close();await rm(root,{recursive:true,force:true});}};
}
for(const row of reference.cases)test('frozen full factory surface: '+row.name,async()=>{
 const f=await fixture();try{const factory=f.factory;factory.addEnvironmentGlobal('custom','global');factory.addEnvironmentGlobal('fetch',call=>call.args[0]!);if(row.name==='configured render stage')factory.markConfigured();
  const handle=row.kind==='ui'?factory.createUiTemplate(row.source):factory.createTemplate(row.source,row.kind==='async');assert.equal(handle.toString(),row.originalSource);
  const run=()=>row.method==='render_async'?handle.renderAsync(row.context):Promise.resolve(handle.render(row.context));
  if(row.error)await assert.rejects(async()=>run(),error=>{assert.equal((error as Error).message,row.message);if(row.code===null)assert(error instanceof ConfigurationError);else assert.equal((error as ApiError).status,row.code);assert(!inspect(error).includes('synthetic-private-template'));return true;});
  else assert.equal(await run(),row.output);
 }finally{await f.close();}
});
for(const row of reference.configuration)test('frozen actual ConfigHelper template option: '+row.name,async()=>{
 const f=await fixture({server:{value:'  {i+1}  ',bad:'{% if'},old:{value:' old '}});try{
  const section=f.reader.section(row.section,row.fallback??undefined),options={isAsync:row.isAsync,deprecate:row.name==='fallback',...row.default==='REQUIRED'?{}:{defaultValue:row.default}};
  const run=()=>row.method==='load_template'?section.loadTemplate(row.option,options as {isAsync:boolean;defaultValue:string}):section.getTemplate(row.option,options);
  // The original fallback capture failed with KeyError('old') because its
  // parsed-section map was empty. The independent retained probe shows the
  // actual getter succeeds after that section has been initialized.
  if(row.name==='fallback'){const value=run();assert(value instanceof MoonrakerRenderableTemplate);assert.equal(value.toString(),'old');assert.equal(value.isAsync,false);assert.equal(f.reader.parsed().old.value,'old');}
  else if(row.error)assert.throws(run,ConfigurationError);else{const value=run();if(row.kind==='template'){assert(value instanceof MoonrakerRenderableTemplate);assert.equal(value.toString(),row.source);assert.equal(value.isAsync,row.templateAsync);}else assert.deepEqual(value,row.source);}
  // The frozen ConfigHelper harness injects its component; the candidate also
  // loads Secrets. Compare every frozen option section without hiding its
  // extra private component record from the reader's actual metadata.
  const parsed=f.reader.parsed(),expected=row.parsed as Record<string,Json>;
  assert.deepEqual(JSON.parse(JSON.stringify(Object.fromEntries(Object.keys(expected).map(key=>[key,parsed[key]])))),expected);assert.equal(f.reader.warnings().length,row.warningCount);
 }finally{await f.close();}
});
test('factory lazy async ownership, shared globals, explicit source and closed generation cleanup',async()=>{
 const f=await fixture();try{const sync=f.factory.createTemplate('{later()}'),source='{% set private="synthetic-source-marker" %}{later()}';assert.equal(f.factory.toJSON().asyncInitialized,false);
  f.factory.addEnvironmentGlobal('later',()=>3n);assert.equal(sync.render(),'3');const async=f.factory.createTemplate(source,true),ui=f.factory.createUiTemplate('{{later is defined}}');assert.equal(f.factory.toJSON().asyncInitialized,true);assert.equal(await async.renderAsync(),'3');assert.equal(await ui.renderAsync(),'False');
  f.factory.addEnvironmentGlobal('value',4n);assert.equal(await f.factory.createTemplate('{value}',true).renderAsync(),'4');
  f.factory.addEnvironmentGlobal('waiting',async call=>{assert(call.signal);await new Promise<void>(resolve=>setImmediate(resolve));return 8n;});assert.equal(await f.factory.createTemplate('{waiting()}',true).renderAsync(),'8');assert.throws(()=>f.factory.createTemplate('{waiting()}').render());
  for(const key of ['later','range','secrets','log_debug'])assert.throws(()=>f.factory.addEnvironmentGlobal(key,1n));
  assert(!inspect(f.factory).includes('synthetic'));assert(!inspect(async).includes('synthetic'));assert(!JSON.stringify(async).includes('synthetic'));assert.equal(async.toString(),source);
  f.factory.close();assert.deepEqual(f.factory.toJSON(),{closed:true,templates:0,asyncInitialized:false});assert.throws(()=>f.reader.templates());assert.throws(()=>sync.render());assert.throws(()=>async.toString());await assert.rejects(async.renderAsync());
 }finally{await f.close();}
});
test('factory close cancels pending callbacks before their late results can publish',async()=>{
 const f=await fixture(),started=Promise.withResolvers<AbortSignal>(),late=Promise.withResolvers<bigint>();try{const handle=f.factory.createTemplate('{hold()}',true),pending=handle.renderAsync('{}',{callables:new Map([['hold',call=>{started.resolve(call.signal);return late.promise;}]])});
  const signal=await started.promise,failed=assert.rejects(pending,error=>error===signal.reason&&error instanceof Error&&error.name==='AbortError');f.factory.close();assert(signal.aborted);late.resolve(9n);await failed;
 }finally{await f.close();}
});
test('trusted debug sink is explicit, typed, shadowable and excluded from UI',async()=>{
 const calls:unknown[]=[],f=await fixture({server:{}},{debug:call=>calls.push(call)});try{
  assert.equal(f.factory.createTemplate('{log_debug("synthetic",1,value=1.0)}').render(),'None');assert.equal(calls.length,1);
  assert.equal(await f.factory.createTemplate('{% do log_debug(msg="synthetic",value=2) %}done',true).renderAsync(),'done');assert.equal(calls.length,2);
  assert.equal(await f.factory.createUiTemplate('{{log_debug is defined}}').renderAsync(),'False');assert.equal(calls.length,2);
  const override=f.factory.createTemplate('{log_debug is string}');assert.equal(override.render('{"log_debug":"context"}'),'True');assert.equal(calls.length,2);
  assert.throws(()=>f.factory.createTemplate('{log_debug("a",msg="b")}').render());assert.equal(calls.length,2);
 }finally{await f.close();}
});
test('template getters keep first source/default records, private redaction and component dependency failures',async()=>{
 const f=await fixture({server:{value:' {i+1} ',secret:' {secrets["ldap"]["password"]} '}});try{f.reader.redact('server','secret');const section=f.reader.section('server');
  const value=section.getTemplate('value');assert.equal(value.render('{"i":2}'),'3');assert.equal(section.getTemplate('value').render('{"i":4}'),'5');assert.equal(f.reader.parsed().server.value,'{i+1}');
  const defaultTemplate=f.factory.createTemplate('default');assert.equal(section.getTemplate('absent',{defaultValue:defaultTemplate}),defaultTemplate);assert.equal(f.reader.parsed().server.absent,'default');assert.equal(section.getTemplate('nil',{defaultValue:null}),null);
  assert.equal(section.getTemplate('secret').render(),'synthetic-private-template');assert.equal(f.reader.snapshot().parsed.server.secret,'<redacted>');assert(!JSON.stringify(f.reader.snapshot()).includes('synthetic-private-template'));
  const without=new ConfigurationReader(new ConfigurationSource('/synthetic/unbound',{server:{}},[]));assert.throws(()=>without.section('server').getTemplate('missing',{defaultValue:null}),/Failed to load template/);assert.deepEqual(JSON.parse(JSON.stringify(without.parsed())),{server:{}});
  await assert.rejects(MoonrakerTemplateFactory.load(f.reader,{dataPath:f.root}));assert.equal(section.getTemplate('value').render('{"i":2}'),'3');
 }finally{await f.close();}
});
test('standard server without LDAP owns one immutable private generation, publishes component names and cancels on close',{timeout:10000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'configured-template-')),file=join(root,'main.conf');let server:ConfiguredMoonraker|undefined;
 const information={connected:false,state:'disconnected' as const,components:['application'],failedComponents:[],directories:[],warnings:[],version:'template-factory-test',missingRequirements:[]};
 try{
  await writeFile(join(root,'moonraker.secrets'),'{"marker":"synthetic-retained-private"}');await writeFile(file,'[server]\nhost: 127.0.0.1\nport: 0\n');
  server=await ConfiguredMoonraker.load(file,{information,authorize:()=>{},templates:{dataPath:root}});const owner=server.templates!;assert(owner);assert.equal(owner.toJSON().asyncInitialized,false);
  const handle=owner.createTemplate('{secrets["marker"]}');await writeFile(join(root,'moonraker.secrets'),'{"marker":"synthetic-next-generation"}');assert.equal(handle.render(),'synthetic-retained-private');
  const address=await server.start();server.setInformation(information);const url=`http://127.0.0.1:${address.port}`;
  const info:any=await(await fetch(url+'/server/info')).json();for(const component of ['template','secrets'])assert(info.result.components.includes(component));
  const settings=await(await fetch(url+'/server/config')).text();for(const privateValue of ['synthetic-retained-private','synthetic-next-generation',join(root,'moonraker.secrets')])assert(!settings.includes(privateValue));
  const started=Promise.withResolvers<AbortSignal>(),late=Promise.withResolvers<bigint>(),pending=owner.createTemplate('{hold()}',true).renderAsync('{}',{callables:new Map([['hold',call=>{started.resolve(call.signal);return late.promise;}]])});
  const signal=await started.promise,failed=assert.rejects(pending,error=>error instanceof Error&&error.name==='AbortError');await server.close();assert(signal.aborted);late.resolve(1n);await failed;assert.equal(owner.toJSON().closed,true);assert.throws(()=>handle.render());assert.throws(()=>server!.reader.templates());
 }finally{await server?.close();await rm(root,{recursive:true,force:true});}
});
test('standard authorization accepts private templates without LDAP and rejects conflicting ownership without taking the database',{timeout:10000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'configured-template-auth-')),file=join(root,'main.conf'),database=await DatabaseStore.open({path:join(root,'users.sqlite')});let server:ConfiguredMoonraker|undefined;
 const information={connected:false,state:'disconnected' as const,components:['application'],failedComponents:[],directories:[],warnings:[],version:'template-factory-test',missingRequirements:[]},authorization={issuer:'http://printer.test:7125'};
 try{
  await writeFile(join(root,'moonraker.secrets'),'{"marker":"synthetic-auth-private"}');await writeFile(file,'[server]\nhost: 127.0.0.1\nport: invalid\n');
  await assert.rejects(ConfiguredMoonraker.loadAuthorized(file,{information,database,authorization,templates:{dataPath:root}}));assert.equal(database.status.closed,false);
  await writeFile(file,'[server]\nhost: 127.0.0.1\nport: 0\n');await assert.rejects(ConfiguredMoonraker.loadAuthorized(file,{information,database,authorization:{...authorization,templateSecrets:{dataPath:root}},templates:{dataPath:root}}),/Choose one private template generation/);assert.equal(database.status.closed,false);
  server=await ConfiguredMoonraker.loadAuthorized(file,{information,database,authorization,templates:{dataPath:root}});assert.equal(server.templates!.createTemplate('{secrets["marker"]}').render(),'synthetic-auth-private');await server.close();assert.equal(database.status.closed,true);
 }finally{await server?.close();await database.close();await rm(root,{recursive:true,force:true});}
});
test('trusted debug sink cannot silently schedule an asynchronous failure',async()=>{
 const f=await fixture({server:{}},{debug:async()=>{throw new Error('synthetic-logger-private');}});try{assert.throws(()=>f.factory.createTemplate('{log_debug("msg")}').render(),ConfigurationError);await assert.rejects(f.factory.createTemplate('{log_debug("msg")}',true).renderAsync(),error=>error instanceof ApiError&&!inspect(error).includes('synthetic-logger-private'));await new Promise<void>(resolve=>setImmediate(resolve));}finally{await f.close();}
});
test('external cancellation preserves its first reason even if generation closes before rejection is observed',async()=>{
 const f=await fixture(),external=new AbortController(),reason=new Error('synthetic-external-cancel'),started=Promise.withResolvers<AbortSignal>(),late=Promise.withResolvers<bigint>();try{
  const pending=f.factory.createTemplate('{hold()}',true).renderAsync('{}',{signal:external.signal,callables:new Map([['hold',call=>{started.resolve(call.signal);return late.promise;}]])});
  const signal=await started.promise,failed=assert.rejects(pending,error=>error===reason);external.abort(reason);f.factory.close();late.resolve(1n);await failed;assert.equal(signal.reason,reason);
 }finally{await f.close();}
});
