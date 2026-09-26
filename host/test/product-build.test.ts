import {once} from 'node:events';
import {WebSocket} from 'ws';
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildProductHost} from '../scripts/build-product-host.ts';
import {productBuildSmoke} from './helpers/product-build-smoke.ts';
import {installProductDependencies} from './helpers/product-install.ts';
import {calculateSpectrum} from '../src/calibration/spectrum.ts';
import {fitInputShapers} from '../src/calibration/shaper-fit.ts';
import {configuredPrinterFixture} from './helpers/configured-printer.ts';
import {productTransports} from './helpers/product-transports.ts';
const root=fileURLToPath(new URL('../../',import.meta.url));
function environment(){const env={...process.env,PATH:'/no-programs',NODE_PATH:'',NODE_OPTIONS:'--no-experimental-strip-types',NODE_DISABLE_COMPILE_CACHE:'1'};for(const key of Object.keys(env))if(key.startsWith('ANYRAID_')&&key.endsWith('_ADDON'))delete (env as NodeJS.ProcessEnv)[key];return env;}
test('compiled product workers, addons, assets and mathematical output run without TS or Python',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'product-build-')),output=join(dir,'app'),work=join(dir,'data');try{
  await mkdir(work);await buildProductHost(output);const marker=JSON.parse(await readFile(join(output,'build-info.json'),'utf8'));
  assert.equal(marker.product,'anyraid-product-host');assert.equal(marker.modules,process.versions.modules);
  for(const [path,hash] of Object.entries(marker.files)){assert(!path.endsWith('.ts'));assert.equal(createHash('sha256').update(await readFile(join(output,path))).digest('hex'),hash,path);}
  assert(marker.files['host/contracts/unicode-lower-15.json']);assert(marker.files['host/assets/fonts/LICENSE-DejaVu.txt']);assert(marker.files['package-lock.json']);assert(marker.files['host/build/serialqueue.node']);
  await installProductDependencies(output);
  const result=JSON.parse(execFileSync(process.execPath,[await productBuildSmoke(output,work)],{env:environment(),encoding:'utf8',timeout:15000,maxBuffer:4*1024**2}));
  const samples=Float64Array.from({length:4096*4},(_,i)=>i%4===0?Math.floor(i/4)/1024:Math.sin(2*Math.PI*64*Math.floor(i/4)/1024));
  const dataset={frequencies:Float64Array.from({length:128},(_,i)=>i*2),psd:Float64Array.from({length:128},(_,i)=>Math.exp(-(((i*2-45)/8)**2))+.01)};
  assert.deepEqual(result.spectrum,JSON.parse(JSON.stringify(calculateSpectrum('compiled',samples))));assert.deepEqual(result.fit,JSON.parse(JSON.stringify(fitInputShapers([dataset],{shapers:['mzv','ei'],frequencies:[35,40,45,50]}))));assert.equal(result.steps,'1000');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('product publication is reproducible and preserves prior output on compiler or addon failure',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'product-publish-')),output=join(dir,'app');try{
  await buildProductHost(output);const before=await readFile(join(output,'build-info.json'),'utf8');await buildProductHost(output);assert.equal(await readFile(join(output,'build-info.json'),'utf8'),before);
  const bad=join(dir,'bad.ts'),config=join(dir,'bad.json');await writeFile(bad,'const invalid:number="text";');await writeFile(config,JSON.stringify({extends:join(root,'host/tsconfig.product-host.json'),include:[bad]}));
  await assert.rejects(buildProductHost(output,config),/TypeScript build failed/);assert.equal(await readFile(join(output,'build-info.json'),'utf8'),before);
  await assert.rejects(buildProductHost(output,undefined,join(dir,'missing')));assert.equal(await readFile(join(output,'build-info.json'),'utf8'),before);
  await mkdir(output+'.lock');await assert.rejects(buildProductHost(output),/locked/);await rm(output+'.lock',{recursive:true});
  const other=join(dir,'unowned');await mkdir(other);await writeFile(join(other,'keep'),'keep');await assert.rejects(buildProductHost(other),/unrecognized/);assert.equal(await readFile(join(other,'keep'),'utf8'),'keep');
  assert(!(await readdir(dir)).some(name=>name.startsWith('.product-build-')||name.endsWith('.lock')));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('compiled CLI uses bundled native owners and a JS profile to start and stop two real UART transports',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'product-built-cli-')),output=join(dir,'app'),f=await configuredPrinterFixture(false,false),transport=await productTransports(f.reader);let child:ReturnType<typeof spawn>|undefined;
 try{
  await buildProductHost(output);await installProductDependencies(output);const profile=join(output,'machine.mjs'),configPath=join(dir,'moonraker.conf');await writeFile(configPath,'[server]\nhost=127.0.0.1\nport=0');
  const printerConfig=join(dir,'printer.cfg'),manifest=join(dir,'machine.json');
  await writeFile(printerConfig,Object.entries(transport.reader.source.original).map(([section,options])=>'['+section+']\n'+Object.entries(options).map(([key,value])=>key+': '+value.replaceAll('\n','\n  ')).join('\n')).join('\n\n'));
  const {output:discardOutput,open:discardOpen,lifecycle:discardLifecycle,...print}=f.options.print;
  await writeFile(manifest,JSON.stringify({version:1,deviceId:'printer',printerConfig,moonrakerConfig:configPath,journalPath:join(dir,'jobs.db'),mcus:Object.fromEntries([...transport.policies].map(([id,{stopDevice,...policy}])=>[id,policy])),machine:{enableLeadTime:.001,fanMinimumScheduleTime:.001},hardware:{heaterGcodeIds:f.options.hardware.heaterGcodeIds},print,limits:{maxNozzle:300,maxBed:130}}));
  await writeFile(profile,`import {writeFile} from 'node:fs/promises';
import {loadProductMachineProfile} from './host/src/runtime/product-machine-profile.js';
import {ApiError} from './host/src/moonraker/rpc.js';
export async function createProductHostProfile(signal){const stops=[];return loadProductMachineProfile(${JSON.stringify(manifest)},async()=>({stops:new Map(['mcu','aux'].map(id=>[id,async()=>{stops.push(id);}])),print:{output(){},lifecycle:{async prepare(){},async start(){},async finishOutputs(){},async stopOutputs(){}},open:async()=>{throw new Error('Unexpected file');}},server:{information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'compiled',missingRequirements:[]},authorizeNotification:()=>{},authorize:(_m,_p,context)=>{if(context.request.headers['x-api-key']!=='test')throw new ApiError(401,'Denied');}},async release(){await writeFile(${JSON.stringify(join(dir,'closed.json'))},JSON.stringify(stops.sort()));}}),signal);}
`);
  child=spawn(process.execPath,[join(output,'scripts/product-host.js'),'--profile',profile],{env:environment(),stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';const ready=Promise.withResolvers<{address:{port:number}}>();void ready.promise.catch(()=>{});
  child.stdout!.on('data',chunk=>{stdout+=chunk;for(const line of stdout.split('\n'))try{const v=JSON.parse(line);if(v.event==='ready')ready.resolve(v);}catch{}});child.stderr!.on('data',chunk=>{stderr+=chunk;});
  const exited=new Promise<number|null>((resolve,reject)=>{child!.on('error',reject);child!.on('exit',code=>{ready.reject(new Error(stderr));resolve(code);});});
  const timer=setTimeout(()=>{child!.kill('SIGKILL');ready.reject(new Error('Compiled CLI timeout: '+stderr));},15000);
  try{const {address}=await ready.promise,url=`http://127.0.0.1:${address.port}/printer/print/status`,response=await fetch(url,{headers:{'x-api-key':'test'}});assert.equal(response.status,200);assert.equal((await response.json() as any).result.state,'idle');const infoResponse=await fetch(`http://127.0.0.1:${address.port}/server/info`,{headers:{'x-api-key':'test'}}),info=(await infoResponse.json() as any).result;assert.equal(info.native_host.ready,true);assert.equal(info.native_host.homed_axes,'');assert.equal(info.native_host.mcus.length,2);assert.equal(info.klippy_connected,false);const objectsResponse=await fetch(`http://127.0.0.1:${address.port}/printer/objects/query?gcode_move=speed&toolhead=homed_axes&extruder=target&virtual_sdcard&print_stats&missing=absent`,{headers:{'x-api-key':'test'}});assert.equal(objectsResponse.status,200);const objectStatus=(await objectsResponse.json() as any).result.status;assert.deepEqual(objectStatus,{gcode_move:{speed:1500},toolhead:{homed_axes:''},extruder:{target:0},virtual_sdcard:{progress:0,is_active:false,file_position:0,file_size:0},print_stats:{state:'standby',message:'',info:{total_layer:null,current_layer:null}},missing:{absent:null}});const ws=new WebSocket(`ws://127.0.0.1:${address.port}/websocket`,{headers:{'x-api-key':'test'}});try{await once(ws,'open');const message=once(ws,'message',{signal:AbortSignal.timeout(3000)});ws.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'printer.objects.subscribe',params:{objects:{native_host:['ready']}}}));assert.deepEqual(JSON.parse(String((await message)[0])).result.status,{native_host:{ready:true}});}finally{ws.terminate();}child.kill('SIGTERM');assert.equal(await exited,0);assert.deepEqual(JSON.parse(await readFile(join(dir,'closed.json'),'utf8')),['aux','mcu']);assert(transport.firmware.every(f=>f.motion.length===0));}finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited.catch(()=>{});}
 }finally{await transport.close();await f.close();await rm(dir,{recursive:true,force:true});}
});
