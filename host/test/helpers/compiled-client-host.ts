import {spawn} from 'node:child_process';
import {writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {buildProductHost} from '../../scripts/build-product-host.ts';
import {installProductDependencies} from './product-install.ts';
import {productMachineFixture} from './product-machine.ts';
import {simulateClientFirmware} from './client-firmware.ts';
/** Separate emitted product process. All PTY and test code stays in the parent. */
export async function startCompiledClientHost(dir:string,signal:AbortSignal,onReady:(base:string)=>void){
 const app=join(dir,'app');await buildProductHost(app);await installProductDependencies(app);signal.throwIfAborted();
 console.log('CLIENT_ARTIFACT '+createHash('sha256').update(await readFile(join(app,'build-info.json'))).digest('hex'));
 const profile=join(dir,'client-machine.mjs'),moduleUrl=(path:string)=>JSON.stringify(pathToFileURL(join(app,path)).href);
 await writeFile(profile,`import {loadNativeProductMachineProfile} from ${moduleUrl('host/src/runtime/native-product-machine.js')};
import {DatabaseStore} from ${moduleUrl('host/src/moonraker/database.js')};
let sequence=0;const pending=new Map();
process.on('message',message=>{const item=pending.get(message?.id);if(!item)return;pending.delete(message.id);clearTimeout(item.timer);if(message.error)item.reject(new Error(message.error));else item.resolve(message.result);});
process.on('disconnect',()=>{for(const item of pending.values()){clearTimeout(item.timer);item.reject(new Error('Simulation parent disconnected'));}pending.clear();process.kill(process.pid,'SIGTERM');});
process.channel?.unref();
function call(method,params){return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Simulation request timeout'));},10000);pending.set(id,{resolve,reject,timer});process.send({id,method,params});});}
export async function createProductHostProfile(signal){
 const prepared=await call('prepare',{}),database=await DatabaseStore.open({path:${JSON.stringify(join(dir,'auth.sqlite'))}});
 try{return await loadNativeProductMachineProfile(prepared.path,{filesRoot:${JSON.stringify(join(dir,'files'))},metadataRoot:${JSON.stringify(join(dir,'metadata'))},standardPrint:{nozzle:200,bed:60},createAdapter:async()=>({
  stops:new Map(['mcu','aux'].map(id=>[id,()=>call('stop',{generation:prepared.generation,id})])),
  output(){},lifecycle:{async prepare(){},async start(){},async finishOutputs(){},async stopOutputs(){}},async authorizePrintFile(){},
  server:{information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'compiled-client-fixture',missingRequirements:[]},database,authorization:{issuer:'http://printer.test'}},
  async release(){await database.close();}
 })},signal);}catch(error){await database.close();throw error;}
}
`);
 const env:NodeJS.ProcessEnv={...process.env,PATH:'/no-programs',NODE_PATH:'',NODE_OPTIONS:'--no-experimental-strip-types',NODE_DISABLE_COMPILE_CACHE:'1'};
 for(const key of Object.keys(env))if(key.startsWith('ANYRAID_')&&key.endsWith('_ADDON'))delete env[key];
 let fixture:Awaited<ReturnType<typeof productMachineFixture>>|undefined,simulation:ReturnType<typeof simulateClientFirmware>|undefined,generation=0,unread='';
 const child=spawn(process.execPath,[join(app,'scripts/product-host.js'),'--profile',profile],{cwd:'/',env,stdio:['ignore','pipe','pipe','ipc']});
 // Serialize device generations. Stop requests finish before product release/factory.
 let requests=Promise.resolve();child.on('message',(message:any)=>{requests=requests.then(async()=>{
  let result:unknown,error:string|undefined;
  try{if(message.method==='prepare'){
   simulation?.close();if(fixture)await fixture.close();fixture=await productMachineFixture(dir);simulation=simulateClientFirmware(fixture);generation++;result={path:fixture.path,generation};
  }else if(message.method==='stop'){
   if(message.params.generation!==generation||!fixture)throw new Error('Stale simulated device generation');const index=['mcu','aux'].indexOf(message.params.id);if(index<0)throw new Error('Unknown simulated device');fixture.transport.stops[index]++;result=true;
  }else throw new Error('Unknown simulation request');}catch(cause){error=String(cause);}
  if(child.connected)child.send({id:message.id,result,error});
 });});
 const ended=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,exitSignal)=>{if(code===0)resolve();else reject(new Error(`Compiled client host exited ${code}/${exitSignal}`));});});void ended.catch(()=>{});
 child.stdout!.on('data',chunk=>{unread+=String(chunk);if(unread.length>65536){child.kill('SIGTERM');return;}for(let at=unread.indexOf('\n');at>=0;at=unread.indexOf('\n')){const line=unread.slice(0,at);unread=unread.slice(at+1);try{const message=JSON.parse(line);if(message.event==='ready'){console.log('CLIENT_GENERATION '+generation);onReady('http://127.0.0.1:'+message.address.port);}}catch{}}});
 child.stderr!.on('data',chunk=>process.stderr.write(chunk));
 let killTimer:ReturnType<typeof setTimeout>|undefined;const stop=()=>{if(child.exitCode!==null||child.signalCode!==null)return;child.kill('SIGINT');killTimer??=setTimeout(()=>child.kill('SIGKILL'),5000);};signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
 const lifetime=ended.finally(async()=>{signal.removeEventListener('abort',stop);if(killTimer)clearTimeout(killTimer);await requests;simulation?.close();if(fixture)await fixture.close();});void lifetime.catch(()=>{});
 return {lifetime,async close(){stop();const timer=setTimeout(()=>child.kill('SIGKILL'),5000);try{await lifetime;}finally{clearTimeout(timer);}}};
}
