import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir,userInfo} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {inspect} from 'node:util';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource,ConfigurationError} from '../src/moonraker/config-source.ts';
import {MoonrakerTemplateFactory} from '../src/moonraker/template-factory.ts';
import {resolveConfigurationPath} from '../src/moonraker/config-path.ts';
import {unixUserHome} from '../src/moonraker/unix-peer.ts';
import {readKlippyBinding} from '../src/moonraker/klippy-config.ts';
import {loadSecrets} from '../src/moonraker/secrets.ts';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
const bytes=await readFile(new URL('../contracts/moonraker-config-path-reference.json',import.meta.url));
assert.equal(createHash('sha256').update(bytes).digest('hex'),'1acad838310da914e1f8766eb9e8cf1799cf919f2ef063cf6aed26045d9d813d');
const reference=JSON.parse(bytes.toString()) as {graph:{directories:string[];files:string[];symlinks:Record<string,string>};cases:{name:string;source:string;output?:string;error?:string;parsed:unknown;warningCount:number}[];defaults:{name:string;default:any;output:any;sameIdentity:boolean;parsed:unknown}[]};
const homeBytes=await readFile(new URL('../contracts/moonraker-config-path-home-probe.json',import.meta.url));assert.equal(createHash('sha256').update(homeBytes).digest('hex'),'cacfd42cea6ccc19ea885f496b72593704b2166130b470ecd5dfd6d8bc359147');
const homeProbe=JSON.parse(homeBytes.toString()) as {cases:{source:string;home:string|null;output:string}[]};
function reader(options:Record<string,string>={}){return new ConfigurationReader(new ConfigurationSource('/synthetic/path.conf',{server:options},[]));}
function normalize(value:unknown,root:string):unknown{return JSON.parse(JSON.stringify(value).replaceAll(root,'$ROOT'));}
async function fixture(){const root=await mkdtemp(join(tmpdir(),'config-path-'));
 for(const name of reference.graph.directories)await mkdir(join(root,name),{recursive:true});
 for(const name of reference.graph.files)await writeFile(join(root,name),'synthetic');
 for(const [name,target] of Object.entries(reference.graph.symlinks))await symlink(target.replaceAll('$ROOT',root),join(root,name));
 await mkdir(join(root,'data'));for(const base of [root,join(root,'data')])await writeFile(join(base,'moonraker.secrets'),'{"ldap":{"password":"synthetic-private-template"}}');return root;
}
// chdir/HOME affect this process only. Sequential tests restore both even on
// failure; other Node test files run in independent test-runner processes.
async function atRoot<T>(root:string,run:()=>Promise<T>):Promise<T>{const cwd=process.cwd(),home=process.env.HOME;process.chdir(root);process.env.HOME=join(root,'home');try{return await run();}finally{process.chdir(cwd);if(home===undefined)delete process.env.HOME;else process.env.HOME=home;}}
for(const row of reference.cases)test('frozen pinned getpath: '+row.name,async()=>{const root=await fixture(),r=reader({path:row.source});let factory:MoonrakerTemplateFactory|undefined;try{
 factory=await MoonrakerTemplateFactory.load(r,{dataPath:join(root,'data')});await atRoot(root,async()=>{
  if(row.error)assert.throws(()=>r.section('server').getPath('path'),error=>{assert(error instanceof ConfigurationError);assert(!inspect(error).includes('synthetic-private-template'));return true;});
  else assert.equal(normalize(r.section('server').getPath('path'),root),row.output);
  assert.deepEqual(normalize({server:r.parsed().server},root),row.parsed);assert.equal(r.warnings().length,row.warningCount);assert.equal(factory!.toJSON().templates,0);
 });
}finally{factory?.close();await rm(root,{recursive:true,force:true});}});
for(const row of reference.defaults)test('frozen getpath default identity: '+row.name,async()=>{const root=await fixture(),r=reader();let factory:MoonrakerTemplateFactory|undefined;try{
 factory=await MoonrakerTemplateFactory.load(r,{dataPath:root});const result=r.section('server').getPath('missing',{defaultValue:row.default});assert.equal(result,row.default);assert.deepEqual(result,row.output);assert.deepEqual({server:JSON.parse(JSON.stringify(r.parsed().server))},row.parsed);assert.equal(factory.toJSON().templates,0);
}finally{factory?.close();await rm(root,{recursive:true,force:true});}});
test('NSS current and named homes match system user; absent names and invalid arguments are private',()=>{
 const info=userInfo();assert.equal(unixUserHome(),info.homedir);assert.equal(unixUserHome(info.username),info.homedir);assert.equal(unixUserHome('anyraid_missing_user_7281'),null);assert.throws(()=>unixUserHome('x\0y'),/Invalid/);
});
test('path getter keeps caller-owned default template, releases failures and requires its component',async()=>{const root=await fixture(),r=reader({bad:'{% if'});let factory:MoonrakerTemplateFactory|undefined;try{
 factory=await MoonrakerTemplateFactory.load(r,{dataPath:root});const template=factory.createTemplate('{data_path}/child'),value=r.section('server').getPath('missing',{defaultValue:template});assert.equal(value,join(root,'child'));assert.equal(template.render('{"data_path":"/other"}'),'/other/child');assert.equal(factory.toJSON().templates,1);
 for(let i=0;i<80;i++)assert.equal(r.section('server').getPath('repeated',{defaultValue:null}),null);
 assert.throws(()=>r.section('server').getPath('bad'));assert.equal(factory.toJSON().templates,1);assert.throws(()=>reader().section('server').getPath('missing',{defaultValue:null}),/Failed to load template/);
 factory.close();assert.throws(()=>factory!.configurationDataPath());assert.throws(()=>r.section('server').getPath('missing',{defaultValue:null}));
}finally{factory?.close();await rm(root,{recursive:true,force:true});}});
test('frozen HOME probe keeps empty HOME at root, relative HOME at cwd and unset HOME in NSS',async()=>{const root=await fixture();try{await atRoot(root,async()=>{
 assert.equal(resolveConfigurationPath('  child  '),join(root,'  child  '));for(const row of homeProbe.cases){if(row.home===null)delete process.env.HOME;else process.env.HOME=row.home;assert.equal(resolveConfigurationPath(row.source),row.output.replaceAll('$ROOT',root).replaceAll('$USER_HOME',userInfo().homedir));}
});}finally{await rm(root,{recursive:true,force:true});}});
test('Klippy binding consumes the shared data_path template and preserves source, defaults and socket bounds',async()=>{const root=await fixture(),r=reader({klippy_uds_address:' {data_path}/comms/klippy.sock '});let factory:MoonrakerTemplateFactory|undefined;try{
 factory=await MoonrakerTemplateFactory.load(r,{dataPath:root});assert.deepEqual(await readKlippyBinding(r),{path:join(root,'comms','klippy.sock'),retryDelayMs:250});assert.equal(r.parsed().server.klippy_uds_address,'{data_path}/comms/klippy.sock');assert.equal(factory.toJSON().templates,0);
 const defaults=reader();const other=await MoonrakerTemplateFactory.load(defaults,{dataPath:root});try{assert.equal((await readKlippyBinding(defaults)).path,'/tmp/klippy_uds');assert.equal(other.toJSON().templates,0);}finally{other.close();}
 const long=reader({klippy_uds_address:'/'+ 'x'.repeat(108)}),longOwner=await MoonrakerTemplateFactory.load(long,{dataPath:root});try{await assert.rejects(readKlippyBinding(long),/Unix socket path/);assert.equal(longOwner.toJSON().templates,0);}finally{longOwner.close();}
}finally{factory?.close();await rm(root,{recursive:true,force:true});}});
test('legacy secret path uses physical link-before-parent semantics without bootstrapping a template component',async()=>{
 const root=await fixture(),data=join(root,'empty-data');await mkdir(data);await writeFile(join(root,'real','legacy.json'),'{"value":"synthetic-physical"}');await writeFile(join(root,'legacy.json'),'{"value":"synthetic-lexical"}');
 const r=new ConfigurationReader(new ConfigurationSource('/synthetic/secrets.conf',{server:{},secrets:{secrets_path:root+'/link/../legacy.json'}},[]));
 try{const store=await loadSecrets(r,{dataPath:data});try{assert.equal(store.get('value'),'synthetic-physical');assert.equal(r.hasTemplates(),false);}finally{store.close();}}finally{await rm(root,{recursive:true,force:true});}
});
test('standard service startup resolves Klippy path using its private component and drops resolved data from metadata',async()=>{
 const root=await fixture(),file=join(root,'main.conf');let server:ConfiguredMoonraker|undefined;
 try{await writeFile(file,'[server]\nhost: 127.0.0.1\nport: 0\nklippy_uds_address: {data_path}/comms/klippy.sock\n');
  server=await ConfiguredMoonraker.load(file,{authorize:()=>{},information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'path-test',missingRequirements:[]},templates:{dataPath:root},klippy:{}});
  assert.equal(server.reader.parsed().server.klippy_uds_address,'{data_path}/comms/klippy.sock');assert(!JSON.stringify(server.reader.snapshot().parsed).includes(root));assert.equal(server.templates!.toJSON().templates,0);
 }finally{await server?.close();await rm(root,{recursive:true,force:true});}
});
