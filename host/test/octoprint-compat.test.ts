import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {OctoprintCompatibility,type OctoprintOwners} from '../src/moonraker/octoprint-compat.ts';
import {ApiError,JsonRpcDispatcher,type Json,type RpcContext} from '../src/moonraker/rpc.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {MoonrakerNetwork} from '../src/moonraker/server.ts';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import type {KlippyState} from '../src/moonraker/metadata.ts';
const raw=await readFile(new URL('../contracts/octoprint-compat-reference.json',import.meta.url));
const reference=JSON.parse(raw.toString()) as {cases:{name:string;path:string;state:KlippyState;printState:string;heaters:Record<string,Json>;ufp:boolean;webcam:Record<string,Json>;expected:Json}[]};
assert.equal(createHash('sha256').update(raw).digest('hex'),'d894cd77b6bc8fc39de9437497d59792850455c319515bbbe7318543abc37335');
const context=():RpcContext=>({transport:'http',signal:new AbortController().signal,authorize(){return {username:'operator'};}});
function reader(options:Record<string,string>={}){return new ConfigurationReader(new ConfigurationSource('/synthetic/octoprint',{server:{},octoprint_compat:options},[]));}
function owners(overrides:Partial<OctoprintOwners>={}):OctoprintOwners{return {state:()=> 'ready',query:async()=>({heaters:{available_sensors:[]},print_stats:{state:'standby'}}),async command(){},async select(){},...overrides};}
for(const row of reference.cases)test('pinned actual OctoPrint methods: '+row.name,async()=>{
 let state:KlippyState='ready';const o=new OctoprintCompatibility(reader({enable_ufp:String(row.ufp),flip_h:String(row.webcam.flipH),flip_v:String(row.webcam.flipV),rotate_90:String(row.webcam.rotate90),stream_url:String(row.webcam.streamUrl),webcam_enabled:String(row.webcam.webcamEnabled)}),'node-test',owners({state:()=>state,query:async selection=>Object.hasOwn(selection,'heaters')?{heaters:{available_sensors:Object.keys(row.heaters)},print_stats:{state:row.printState}}:row.heaters}));
 // The reference represents the pinned cache initialized before this state.
 await o.handle('/api/printer',{},context());state=row.state;
 assert.deepEqual(await o.handle(row.path,{},context()),row.expected);
});
test('dynamic HTTP suffix is decoded once, cannot be overridden and has no RPC registration',async()=>{
 const r=new EndpointRegistry(new JsonRpcDispatcher()),o=new OctoprintCompatibility(reader(),'test',owners()),close=o.register(r),path='/api/files/moonraker/gcodes/literal%252F.gcode';
 try{assert.equal(r.dispatcher.has('api.files.moonraker'),false);assert.deepEqual(r.allowed(path),['POST']);assert.equal(r.allowed('/api/files/moonraker'),undefined);const p=r.parse(path,'command=select',Buffer.alloc(0),'');assert.equal(p.relative_path,'gcodes/literal%2F.gcode');assert.equal(await r.invoke(path,'POST',p,context()),null);assert.throws(()=>r.parse(path,'relative_path=gcodes/other.gcode',Buffer.alloc(0),''),/overridden/);await assert.rejects(r.invoke(path,'POST',{command:'select',relative_path:'gcodes/other.gcode'},context()),/mismatch/);assert.throws(()=>r.parse('/api/files/moonraker/%ff','',Buffer.alloc(0),''),/encoding/);}finally{close();}assert.equal(r.allowed(path),undefined);
});
test('selection is a no-op without print intent and delegates only validated gcodes paths',async()=>{
 const selected:string[]=[],o=new OctoprintCompatibility(reader(),'test',owners({async select(name){selected.push(name);}}));
 assert.equal(await o.handle('/api/files/moonraker',{command:'select',relative_path:'config/printer.cfg'},context()),null);assert.deepEqual(selected,[]);
 await o.handle('/api/files/moonraker',{command:'select',relative_path:'gcodes/零件/50%.gcode',print:true},context());assert.deepEqual(selected,['零件/50%.gcode']);
 for(const relative_path of ['config/printer.cfg','gcodes/../unsafe.gcode','gcodes//unsafe.gcode'])await assert.rejects(o.handle('/api/files/moonraker',{command:'select',relative_path,print:true},context()),ApiError);
 await assert.rejects(o.handle('/api/files/moonraker',{command:'delete',relative_path:'gcodes/a.gcode'},context()),/Unsupported/);await assert.rejects(o.handle('/api/files/moonraker',{command:'select',relative_path:'gcodes/a.gcode',print:1},context()),/boolean/);
});
test('commands stay ordered, report operational failure, and never mask authority or cancellation',async()=>{
 const commands:string[]=[],o=new OctoprintCompatibility(reader(),'test',owners({async command(script){commands.push(script);if(script==='fail')throw new ApiError(409,'Busy');if(script==='denied')throw new ApiError(403,'Denied');}}));
 assert.deepEqual(await o.handle('/api/printer/command',{commands:['G28','fail','M105']},context()),{});assert.deepEqual(commands,['G28','fail','M105']);assert.equal(o.status.commandFailures,1);await assert.rejects(o.handle('/api/printer/command',{commands:['denied','M105']},context()),e=>e instanceof ApiError&&e.status===403);assert.equal(commands.at(-1),'denied');
 for(const value of ['G28',[1],Array(65).fill('G28')])await assert.rejects(o.handle('/api/printer/command',{commands:value},context()),/bounded/);
 const cancel=new AbortController(),c=context();c.signal=cancel.signal;cancel.abort(new Error('Cancelled'));await assert.rejects(o.handle('/api/printer/command',{commands:['G28']},c),/Cancelled/);
});
test('real HTTP routes are raw and protected; selection returns 204 and original routes retain result wrapping',async()=>{
 const rpc=new JsonRpcDispatcher(),r=new EndpointRegistry(rpc),o=new OctoprintCompatibility(reader(),'node-test',owners()),close=o.register(r);r.register({endpoint:'/server/example',methods:['GET']},()=>({value:1}));
 const n=new MoonrakerNetwork(rpc,{endpoints:r,authorize(_method,_params,{request}){if(request.headers['x-api-key']!=='synthetic')throw new ApiError(401,'Denied');}}),address=await n.listen(),base='http://127.0.0.1:'+address.port;
 try{assert.equal((await fetch(base+'/api/version')).status,401);const headers={'x-api-key':'synthetic','content-type':'application/json'};assert.deepEqual(await(await fetch(base+'/api/version',{headers})).json(),{server:'1.5.0',api:'0.1',text:'OctoPrint (Moonraker node-test)'});assert.deepEqual(await(await fetch(base+'/server/example',{headers})).json(),{result:{value:1}});const selected=await fetch(base+'/api/files/moonraker/gcodes/a.gcode',{method:'POST',headers,body:'{"command":"select"}'});assert.equal(selected.status,204);assert.equal(await selected.text(),'');assert.equal((await fetch(base+'/api/printer/command',{headers})).status,405);assert.equal((await fetch(base+'/api/files/moonraker',{method:'POST',headers,body:'{}'})).status,404);}finally{close();await n.close();}
});
test('configured component is optional, consumes its options and is visible through server.info',async()=>{
 const root=await mkdtemp(join(tmpdir(),'octoprint-config-')),path=join(root,'moonraker.conf');await writeFile(path,'[server]\nhost=127.0.0.1\nport=0\n[octoprint_compat]\nenable_ufp=false\nflip_h=true\nstream_url=/stream\n[file_manager]\nqueue_gcode_uploads=false');
 const s=await ConfiguredMoonraker.load(path,{authorize(){},information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'node-test',missingRequirements:[]}});
 try{const address=await s.start(),base='http://127.0.0.1:'+address.port;const info=await(await fetch(base+'/server/info')).json();assert(info.result.components.includes('octoprint_compat'));assert.deepEqual(info.result.warnings,[]);const settings=await(await fetch(base+'/api/settings')).json();assert.deepEqual(settings.plugins,{});assert.equal(settings.webcam.flipH,true);assert.equal(settings.webcam.streamUrl,'/stream');assert.equal((await(await fetch(base+'/api/job')).json()).state,'Offline');}finally{await s.close();await rm(root,{recursive:true,force:true});}
});
test('constant handshake cannot be mutated and retired device requests cannot issue later commands',async()=>{
 const o=new OctoprintCompatibility(reader(),'node-test',owners()),version=await o.handle('/api/version',{},context());assert(Object.isFrozen(version));assert.equal((await o.handle('/api/version',{},context()) as Record<string,Json>).text,'OctoPrint (Moonraker node-test)');
 const generation=new AbortController(),commands:string[]=[],running=new OctoprintCompatibility(reader(),'node-test',owners({async command(value){commands.push(value);generation.abort(new ApiError(503,'Generation retired'));throw generation.signal.reason;}})),c={...context(),nativeGenerationSignal:generation.signal};
 await assert.rejects(running.handle('/api/printer/command',{commands:['G28','M105']},c),/Generation retired/);assert.deepEqual(commands,['G28']);assert.equal(running.status.commandFailures,0);
 // Process handshake continues to work after the printer disconnects.
 assert.equal((await running.handle('/api/version',{},c) as Record<string,Json>).api,'0.1');
});
test('enabled UFP alias extracts exact sealed G-code bytes through the existing archive owner',async()=>{
 const {NativePrintUploads,registerNativeFileInfo}=await import('../src/moonraker/native-print-uploads.ts'),{PublishedPrintFiles}=await import('../src/storage/published-files.ts'),{MaintenanceGate}=await import('../src/operations/maintenance-gate.ts'),{ufpFixture}=await import('./helpers/ufp-fixture.ts');
 const root=await mkdtemp(join(tmpdir(),'octoprint-ufp-')),files=await PublishedPrintFiles.open(join(root,'files')),uploads=new NativePrintUploads(files,new MaintenanceGate(),{stagingRoot:root}),rpc=new JsonRpcDispatcher(),registry=new EndpointRegistry(rpc);registerNativeFileInfo(registry,uploads);const network=new MoonrakerNetwork(rpc,{endpoints:registry,nativeUploads:uploads,octoprint:{enableUfp:true},authorize(){}}),address=await network.listen();
 try{const model=Buffer.from('G1 X0.12345678901234567 E0.01 F1200\r\n; 中文\r\n'),archive=ufpFixture([{name:'/3D/model.gcode',data:model}]),form=new FormData();form.append('file',new Blob([new Uint8Array(archive)]),'模型.ufp');form.append('select','true');const response=await fetch('http://127.0.0.1:'+address.port+'/api/files/local',{method:'POST',body:form});assert.equal(response.status,201);const value=await response.json();assert.equal(value.item.path,'模型.gcode');assert.equal(value.file.sha256,createHash('sha256').update(model).digest('hex'));assert.equal(value.print_started,false);assert.deepEqual((await files.readBytes(value.file.id,new AbortController().signal)).bytes,model);assert(response.headers.get('location')!.includes('/api/files/moonraker/gcodes/'));}
 finally{await network.close();await uploads.close();await files.close();await rm(root,{recursive:true,force:true});}
});
test('resolved handshake reuse still checks every caller and component retirement',async()=>{
 const rpc=new JsonRpcDispatcher(),registry=new EndpointRegistry(rpc),o=new OctoprintCompatibility(reader(),'node-test',owners()),close=o.register(registry),first=o.handle('/api/version',{},context());assert.equal(o.handle('/api/version',{},context()),first);await first;
 const c=context(),aborted=new AbortController();c.signal=aborted.signal;aborted.abort(new ApiError(499,'Cancelled handshake'));await assert.rejects(o.handle('/api/version',{},c),/Cancelled handshake/);close();await assert.rejects(o.handle('/api/version',{},context()),/closed/);
});
