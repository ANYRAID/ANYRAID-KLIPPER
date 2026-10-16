import {externalAcceptanceBundle,assertSeparateAcceptanceWorkspace,assertAcceptanceBundleUnchanged} from './acceptance-bundle.ts';
import {spawn} from 'node:child_process';
import {writeFile,readFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {buildProductHost} from '../../scripts/build-product-host.ts';
import {installProductDependencies} from './product-install.ts';
import {productMachineFixture} from './product-machine.ts';
import {simulateClientFirmware} from './client-firmware.ts';
import {compiledClientMoonrakerConfig} from './client-proxy.ts';
export interface CompiledClientExit {pid:number;code:number|null;signal:NodeJS.Signals|null;simulationClosed:true;requestsJoined:true;}
export class CompiledClientExitError extends Error {
 readonly receipt:CompiledClientExit;
 constructor(receipt:CompiledClientExit){super(`Compiled client host exited ${receipt.code}/${receipt.signal}`);this.receipt=receipt;}
}
/** Separate emitted product process. All PTY and test code stays in the parent. */
export async function startCompiledClientHost(dir:string,signal:AbortSignal,onReady:(base:string)=>void,trustedLoopback=false,session?:{fixture:Awaited<ReturnType<typeof productMachineFixture>>;reuseBuild:boolean;listenPort?:number}){
 const retained=await externalAcceptanceBundle(),app=retained?.path??join(dir,'app');
 if(retained){await assertSeparateAcceptanceWorkspace(retained,dir);console.log('CLIENT_DEPENDENCIES '+retained.dependenciesSha256);}
 else if(!session?.reuseBuild){await buildProductHost(app);await installProductDependencies(app);}signal.throwIfAborted();
 console.log('CLIENT_ARTIFACT '+createHash('sha256').update(await readFile(join(app,'build-info.json'))).digest('hex'));
 const fixture=session?.fixture??await productMachineFixture(dir,false,'ack');
 const configRoot=join(dir,'config');
 if(!session?.reuseBuild){
  const printer=await readFile(fixture.config.printerConfig),moonraker=await readFile(fixture.config.moonrakerConfig,'utf8');await mkdir(join(configRoot,'parts'),{recursive:true});
  fixture.config.printerConfig=join(configRoot,'printer.cfg');fixture.config.moonrakerConfig=join(configRoot,'moonraker.conf');
  await writeFile(join(configRoot,'parts','machine.cfg'),printer);await writeFile(fixture.config.printerConfig,'[include parts/machine.cfg]\n');await writeFile(fixture.config.moonrakerConfig,compiledClientMoonrakerConfig(moonraker,trustedLoopback));await writeFile(fixture.path,JSON.stringify(fixture.config));
 }
 if(session?.listenPort!==undefined){
  if(!Number.isInteger(session.listenPort)||session.listenPort<1024||session.listenPort>65535)throw new Error('Invalid explicit client product port');
  const config=await readFile(fixture.config.moonrakerConfig,'utf8'),lines=config.split('\n');let section='',ports:number[]=[];
  for(let i=0;i<lines.length;i++){const header=/^\[([^\]]+)\]\s*$/u.exec(lines[i]);if(header)section=header[1];else if(section==='server'&&/^port\s*[:=]/u.test(lines[i]))ports.push(i);}
  if(ports.length!==1||!/^port\s*[:=]\s*\d+\s*$/u.test(lines[ports[0]]))throw new Error('Ambiguous client fixture port');
  if(session.reuseBuild){if(Number(lines[ports[0]].split(/[:=]/u)[1])!==session.listenPort)throw new Error('Persisted client fixture port changed');}
  else{lines[ports[0]]='port: '+session.listenPort;await writeFile(fixture.config.moonrakerConfig,lines.join('\n'));}
 }
 const profile=join(dir,'client-machine.mjs'),moduleUrl=(path:string)=>JSON.stringify(pathToFileURL(join(app,path)).href);
 await writeFile(profile,`import {createNativeProductHostFactory} from ${moduleUrl('host/src/runtime/native-product-machine.js')};
import {DatabaseStore} from ${moduleUrl('host/src/moonraker/database.js')};
let sequence=0;const pending=new Map();
process.on('message',message=>{const item=pending.get(message?.id);if(!item)return;pending.delete(message.id);clearTimeout(item.timer);if(message.error)item.reject(new Error(message.error));else item.resolve(message.result);});
process.on('disconnect',()=>{for(const item of pending.values()){clearTimeout(item.timer);item.reject(new Error('Simulation parent disconnected'));}pending.clear();process.kill(process.pid,'SIGTERM');});
process.channel?.unref();
function call(method,params){return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Simulation request timeout'));},10000);pending.set(id,{resolve,reject,timer});process.send({id,method,params});});}
export const createProductHostProfile=createNativeProductHostFactory(${JSON.stringify(fixture.path)},{
 filesRoot:${JSON.stringify(join(dir,'files'))},metadataRoot:${JSON.stringify(join(dir,'metadata'))},dataPath:${JSON.stringify(join(dir,'private'))},configFiles:{root:${JSON.stringify(configRoot)},writable:['printer.cfg','parts/machine.cfg']},standardPrint:{nozzle:200,bed:60},
 async createProcess(){const database=await DatabaseStore.open({path:${JSON.stringify(join(dir,'auth.sqlite'))}});return {
  server:{information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'compiled-client-fixture',missingRequirements:[]},database,authorization:{issuer:'http://printer.test'}},
  async release(){await database.close();}
 };},
 async createAdapter(){const prepared=await call('acquire',{});return {
  stops:new Map(['mcu','aux'].map(id=>[id,()=>call('stop',{generation:prepared.generation,id})])),
  output(){},lifecycle:{async prepare(){},async start(){},async finishOutputs(){},async stopOutputs(){}},async authorizePrintFile(){},
  async release(){await call('release',{generation:prepared.generation});}
 };}
});
`);
 const env:NodeJS.ProcessEnv={...process.env,PATH:'/no-programs',NODE_PATH:'',NODE_OPTIONS:'--no-experimental-strip-types',NODE_DISABLE_COMPILE_CACHE:'1'};
 for(const key of Object.keys(env))if(key.startsWith('ANYRAID_')&&key.endsWith('_ADDON'))delete env[key];
 let simulation:ReturnType<typeof simulateClientFirmware>|undefined,generation=0,leased=false,starts:number[]=[],unread='';
 const child=spawn(process.execPath,[join(app,'scripts/product-host.js'),'--profile',profile],{cwd:'/',env,stdio:['ignore','pipe','pipe','ipc']});
 // Serialize device generations. Stop requests finish before product release/factory.
 let requests=Promise.resolve();child.on('message',(message:any)=>{requests=requests.then(async()=>{
  let result:unknown,error:string|undefined;
  try{if(message.method==='acquire'){
   if(leased)throw new Error('Previous simulated device lease remains active');
   simulation?.close();simulation=undefined;starts=fixture.transport.firmware.map(device=>device.outputs.length);leased=true;generation++;result={generation};
  }else if(message.method==='stop'){
   if(message.params.generation!==generation||!leased)throw new Error('Stale simulated device generation');const index=['mcu','aux'].indexOf(message.params.id);if(index<0)throw new Error('Unknown simulated device');simulation?.close();simulation=undefined;fixture.transport.stops[index]++;result=true;
  }else if(message.method==='release'){
   if(message.params.generation!==generation||!leased)throw new Error('Stale simulated device release');simulation?.close();simulation=undefined;leased=false;result=true;
  }else throw new Error('Unknown simulation request');}catch(cause){error=String(cause);}
  if(child.connected)await new Promise<void>((resolve,reject)=>{child.send({id:message.id,result,error},failure=>failure?reject(failure):resolve());});
 });void requests.catch(()=>{});});
 let spawnError:Error|undefined;child.once('error',error=>{spawnError=error;});
 const ended=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>{child.once('close',(code,signal)=>resolve({code,signal}));});
 child.stdout!.on('data',chunk=>{unread+=String(chunk);if(unread.length>65536){child.kill('SIGTERM');return;}for(let at=unread.indexOf('\n');at>=0;at=unread.indexOf('\n')){const line=unread.slice(0,at);unread=unread.slice(at+1);try{const message=JSON.parse(line);if(message.event==='ready'){simulation?.close();simulation=simulateClientFirmware(fixture,starts);console.log('CLIENT_GENERATION '+generation);console.log('CLIENT_FIRMWARE '+JSON.stringify(fixture.transport.firmware.map(device=>({resets:device.configurationTraffic.resets,configurations:device.configurationTraffic.finalizations}))));onReady('http://127.0.0.1:'+message.address.port);}}catch{}}});
 child.stderr!.on('data',chunk=>process.stderr.write(chunk));
 let killTimer:ReturnType<typeof setTimeout>|undefined;const stop=()=>{if(child.exitCode!==null||child.signalCode!==null)return;child.kill('SIGINT');killTimer??=setTimeout(()=>child.kill('SIGKILL'),5000);};signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
 const exited=ended.then(async result=>{
  signal.removeEventListener('abort',stop);if(killTimer)clearTimeout(killTimer);const failures:unknown[]=[];
  try{await requests;}catch(error){failures.push(error);}finally{try{simulation?.close();}catch(error){failures.push(error);}simulation=undefined;leased=false;}
  if(!session)try{await fixture.close();}catch(error){failures.push(error);}
  if(retained)try{await assertAcceptanceBundleUnchanged(retained);}catch(error){failures.push(error);}
  if(failures.length)throw new AggregateError(failures,'Compiled client cleanup failed',{cause:{pid:child.pid!,...result}});
  return {pid:child.pid!,...result,simulationClosed:true,requestsJoined:true} as const;
 });void exited.catch(()=>{});
 const lifetime=exited.then(receipt=>{if(spawnError)throw spawnError;if(receipt.code!==0)throw new CompiledClientExitError(receipt);});void lifetime.catch(()=>{});
 let faultArmed=false,faultSpent=false;
 return {lifetime,exited,pid:child.pid!,armExternalFault(){
  if(faultArmed||faultSpent||!child.pid||child.exitCode!==null||child.signalCode!==null)throw new Error('External child fault cannot be armed');faultArmed=true;
  return ()=>{if(!faultArmed||faultSpent||child.exitCode!==null||child.signalCode!==null)throw new Error('External child fault is not active');faultArmed=false;faultSpent=true;if(!child.kill('SIGKILL'))throw new Error('Owned child SIGKILL failed');};
 },async close(){stop();const timer=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');},5000);try{await lifetime;}finally{clearTimeout(timer);}}};
}
