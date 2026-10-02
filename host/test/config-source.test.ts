import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm,link,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadConfiguration,ConfigurationError} from '../src/moonraker/config-source.ts';
import {ServerConfiguration,ServerInformation,registerServerMetadata} from '../src/moonraker/metadata.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher} from '../src/moonraker/rpc.ts';
async function fixture(run:(directory:string,put:(name:string,value:string|Buffer)=>Promise<void>)=>Promise<void>){const directory=await mkdtemp(join(tmpdir(),'node-config-test-'));try{await run(directory,async(name,value)=>{await mkdir(join(directory,name,'..'),{recursive:true});await writeFile(join(directory,name),value);});}finally{await rm(directory,{recursive:true,force:true});}}
const plain=(value:unknown)=>JSON.parse(JSON.stringify(value));
test('configuration source merges sorted includes, defaults and per-file section provenance',()=>fixture(async(dir,put)=>{
 await put('main.conf','[DEFAULT]\nshared: base\n[server]\nport=7125\n[include parts/*.conf]\n[tail]\nvalue=last');
 await put('parts/b.conf','[server]\nport: 7127\n[tail]\nb=second');await put('parts/a.conf','[server]\nport: 7126\n[a]\nvalue=first');
 const result=await loadConfiguration(join(dir,'main.conf'));
 assert.deepEqual(plain(result.original),{DEFAULT:{shared:'base'},server:{shared:'base',port:'7127'},a:{shared:'base',value:'first'},tail:{shared:'base',b:'second',value:'last'}});
 assert.deepEqual(result.files.map(f=>({filename:f.filename.slice(dir.length+1),sections:f.sections})),[{filename:'main.conf',sections:['DEFAULT','server','tail']},{filename:'parts/a.conf',sections:['server','a']},{filename:'parts/b.conf',sections:['server','tail']}]);
 assert.throws(()=>{result.original.server.port='9999';});assert.throws(()=>{(result.files[0].sections as string[]).push('fake');});
}));
test('configuration preserves raw multiline values, percent templates, escaped comments and delimiters',()=>fixture(async(dir,put)=>{
 await put('main.conf','[server] ignored suffix\nUPPER: Value # removed\nscript: first\n\t second ; comment\n\t third \\# literal \\; literal\n\n# ignored\n\t fourth\nurl=http://host/#anchor\ntemplate: %(name)s {value}\npunctuation=a:b=c;literal\n');
 const result=await loadConfiguration(join(dir,'main.conf'));
 assert.deepEqual(plain(result.original.server),{upper:'Value',script:'first\nsecond\nthird # literal ; literal\nfourth',url:'http://host/#anchor',template:'%(name)s {value}',punctuation:'a:b=c;literal'});
}));
test('configuration fails on duplicates, malformed files and include chunk errors',()=>fixture(async(dir,put)=>{
 await put('child.conf','[child]\nx=1');
 for(const text of ['[server]\nx=1\nx=2','[server]\nX=1\nx=2','[server]\n[server]','[server]\nmissing delimiter','key=value\n[server]','[other]\nx=1','[server]\n[include missing*]','[server]\n[include ]','[server]\na=1\n[include child.conf]\nb=2','\ufeff[server]\nx=1']){await put('main.conf',text);await assert.rejects(loadConfiguration(join(dir,'main.conf')),ConfigurationError);}
 await put('main.conf',Buffer.from([0x5b,0x73,0x65,0x72,0x76,0x65,0x72,0x5d,0x0a,0xff]));await assert.rejects(loadConfiguration(join(dir,'main.conf')),ConfigurationError);
}));
test('configuration rejects repeated inode through include cycles, symlinks and hardlinks',()=>fixture(async(dir,put)=>{
 await put('main.conf','[server]\n[include child.conf]');await put('child.conf','[child]\n[include main.conf]');await assert.rejects(loadConfiguration(join(dir,'main.conf')),/Recursive/);
 await put('child.conf','[child]\nx=1');await link(join(dir,'child.conf'),join(dir,'hard.conf'));await symlink('child.conf',join(dir,'soft.conf'));
 for(const name of ['hard.conf','soft.conf']){await put('main.conf',`[server]\n[include child.conf]\n[include ${name}]`);await assert.rejects(loadConfiguration(join(dir,'main.conf')),/Recursive/);}
}));
test('configuration glob supports dotfiles, wildcard patterns, recursive directories and literal braces',()=>fixture(async(dir,put)=>{
 await put('main.conf','[server]\n[include parts/**/??.conf]\n[include parts/.hidden]\n[include parts/{literal}]');
 await put('parts/a1.conf','[a]\nx=1');await put('parts/deep/b2.conf','[b]\nx=2');await put('parts/deep/skip.conf','[excluded]\nx=3');await put('parts/.hidden','[hidden]\nx=4');await put('parts/{literal}','[literal]\nx=5');
 const source=await loadConfiguration(join(dir,'main.conf'));assert.deepEqual(Object.keys(source.original),['DEFAULT','server','a','b','hidden','literal']);
}));
test('configuration enforces byte, file, depth and directory scanning limits before publication',()=>fixture(async(dir,put)=>{
 await put('main.conf','[server]\nport=7125\n[include child.conf]');await put('child.conf','[child]\nx=1');
 for(const limits of [{bytes:4},{files:1},{depth:1,directoryEntries:1},{bytes:NaN},{files:0}])await assert.rejects(loadConfiguration(join(dir,'main.conf'),limits),ConfigurationError);
 await put('child.conf','[child]\n[include grand.conf]');await put('grand.conf','[grand]\nx=1');await assert.rejects(loadConfiguration(join(dir,'main.conf'),{depth:1}),ConfigurationError);
 await put('main.conf','[server]\n[include parts]');await mkdir(join(dir,'parts'));await assert.rejects(loadConfiguration(join(dir,'main.conf')),/regular file/);
}));
test('file-backed metadata publication is explicit, atomic and visible through registered RPC',()=>fixture(async(dir,put)=>{
 const path=join(dir,'main.conf');await put('main.conf','[server]\nport=7125');const source=await loadConfiguration(path),config=new ServerConfiguration(source.snapshot({server:{port:7125}}));
 const rpc=new JsonRpcDispatcher(),registry=new EndpointRegistry(rpc);registerServerMetadata(registry,new ServerInformation({connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]}),config,()=>0);
 await put('main.conf','[server]\nport=7126');const next=await loadConfiguration(path);assert.equal((config.read().orig as any).server.port,'7125');next.publish(config,{server:{port:7126}});assert.equal((config.read().orig as any).server.port,'7126');
 await put('main.conf','[server]\nport=1\nport=2');await assert.rejects(loadConfiguration(path));assert.equal((config.read().orig as any).server.port,'7126');
 const response=await rpc.dispatch(JSON.stringify({jsonrpc:'2.0',method:'server.config',id:1}),{transport:'websocket',signal:new AbortController().signal,authorize(){}});assert.equal(JSON.parse(response!).result.orig.server.port,'7126');assert.equal(JSON.parse(response!).result.config.server.port,7126);
}));
test('relative include paths preserve symlink followed by parent traversal and API provenance',()=>fixture(async(dir,put)=>{
 await put('outside/deep/empty','');await symlink('outside/deep',join(dir,'alias'));
 await put('child.conf','[child]\nvalue=wrong');await put('outside/child.conf','[child]\nvalue=correct');
 await put('main.conf','[server]\n[include alias/../child.conf]');const source=await loadConfiguration(join(dir,'main.conf'));
 assert.equal(source.original.child.value,'correct');assert.equal(source.files[1].filename,dir+'/alias/../child.conf');
 const config=new ServerConfiguration(source.snapshot({}));assert.equal((config.read().files as any)[1].filename,'alias/../child.conf');
 await put('main.conf',`[server]\n[include ${dir}/alias/../child.conf]`);const absolute=await loadConfiguration(join(dir,'main.conf'));assert.equal(absolute.original.child.value,'correct');assert.equal(absolute.files[1].filename,dir+'/outside/child.conf');
}));
