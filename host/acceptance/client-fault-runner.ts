import {spawn,type ChildProcess} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
import {startCompiledClientHost,CompiledClientExitError,type CompiledClientExit} from '../test/helpers/compiled-client-host.ts';
import {productMachineFixture} from '../test/helpers/product-machine.ts';
import {externalAcceptanceBundle,assertAcceptanceBundleUnchanged} from '../test/helpers/acceptance-bundle.ts';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {ApiKeyAuthorization} from '../src/moonraker/api-key-authorization.ts';

/** Finite software acceptance supervisor. It never repairs a product journal. */
export async function createClientFaultSession(assets:string,upstreamPort:number,gatewayPort:number,record:(value:unknown)=>void){
 const bundle=await externalAcceptanceBundle();if(!bundle)throw new Error('An immutable external acceptance bundle is required');
 if(![upstreamPort,gatewayPort].every(port=>Number.isInteger(port)&&port>=1024&&port<=65535)||upstreamPort===gatewayPort)throw new Error('Explicit distinct loopback ports required');
 const root=await mkdtemp(join(tmpdir(),'anyraid-client-external-')),abort=new AbortController(),origin='http://127.0.0.1:'+gatewayPort,upstream='http://127.0.0.1:'+upstreamPort;
 let fixture:Awaited<ReturnType<typeof productMachineFixture>>|undefined,host:Awaited<ReturnType<typeof startCompiledClientHost>>|undefined,gateway:ChildProcess|undefined,gatewayEnded:Promise<void>|undefined;
 let generation=0,state:'starting'|'online'|'armed'|'faulting'|'offline'|'closing'='starting',spent=false,kill:(()=>void)|undefined,expectedCrash=false,failure:unknown;
 const check=()=>{if(failure)throw failure;abort.signal.throwIfAborted();};
 async function start(){
  check();const ready=Promise.withResolvers<void>();generation++;
  host=await startCompiledClientHost(root,abort.signal,base=>{if(base!==upstream){ready.reject(new Error('Product moved from its fixed private listener'));return;}record({event:'product-ready',generation,pid:host?.pid,upstream:base});ready.resolve();},false,{fixture:fixture!,reuseBuild:generation>1,listenPort:upstreamPort});
  const owned=host;void owned.lifetime.catch(error=>{if(expectedCrash&&error instanceof CompiledClientExitError&&error.receipt.signal==='SIGKILL')return;if(state!=='closing'){failure=error;record({event:'unexpected-product-exit',generation,error:String(error)});}});
  await Promise.race([ready.promise,owned.lifetime.then(()=>{throw new Error('Product exited before ready');}),new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Client product ready timeout')),20000);timer.unref();ready.promise.finally(()=>clearTimeout(timer)).catch(()=>{});})]);check();state='online';
 }
 async function close(){
  state='closing';abort.abort();const errors:unknown[]=[];
  if(host)try{await host.close();}catch(error){if(!(expectedCrash&&error instanceof CompiledClientExitError&&error.receipt.signal==='SIGKILL'))errors.push(error);}
  if(gateway&&gateway.exitCode===null&&gateway.signalCode===null)gateway.kill('SIGINT');
  const force=setTimeout(()=>{if(gateway&&gateway.exitCode===null&&gateway.signalCode===null)gateway.kill('SIGKILL');},5000);
  try{await gatewayEnded;}catch(error){errors.push(error);}finally{clearTimeout(force);}
  try{await fixture?.close();}catch(error){errors.push(error);}try{await assertAcceptanceBundleUnchanged(bundle!);}catch(error){errors.push(error);}
  // Preserve files on failure for diagnosis; successful callers explicitly dispose.
  if(failure)errors.push(failure);if(errors.length)throw new AggregateError(errors,'Client fault session cleanup failed');
 }
 try{
  fixture=await productMachineFixture(root,false,'ack');
  const db=await DatabaseStore.open({path:join(root,'auth.sqlite')});let key:string;try{const auth=await ApiKeyAuthorization.open(db,{issuer:'http://printer.test'});try{key=auth.localApiKey();}finally{await auth.close();}}finally{await db.close();}
  await start();const user=await fetch(upstream+'/access/user',{method:'POST',headers:{'content-type':'application/json','x-api-key':key!},body:JSON.stringify({username:'operator',password:'client-test-only'}),signal:AbortSignal.timeout(5000)});if(user.status!==200)throw new Error('Client fixture user bootstrap failed');await user.arrayBuffer();
  const gatewayReady=Promise.withResolvers<void>();let unread='',spawnError:Error|undefined;
  gateway=spawn(process.execPath,[join(bundle.path,'scripts/product-client.js'),'--origin',origin,'--upstream',upstream,'--assets',resolve(assets),'--port',String(gatewayPort),'--loopback-http'],{cwd:'/',env:{...process.env,PATH:'/no-programs',NODE_PATH:'',NODE_OPTIONS:'--no-experimental-strip-types',NODE_DISABLE_COMPILE_CACHE:'1'},stdio:['ignore','pipe','pipe']});
  const owned=gateway;record({event:'gateway-spawn',pid:owned.pid,origin,upstream,manifest:bundle.manifestSha256,dependencies:bundle.dependenciesSha256});
  owned.once('error',error=>{spawnError=error;gatewayReady.reject(error);});owned.stderr!.on('data',bytes=>process.stderr.write(bytes));
  owned.stdout!.on('data',bytes=>{unread+=String(bytes);if(unread.length>65536){owned.kill('SIGTERM');gatewayReady.reject(new Error('Gateway output limit'));return;}for(let at=unread.indexOf('\n');at>=0;at=unread.indexOf('\n')){const line=unread.slice(0,at);unread=unread.slice(at+1);try{if(JSON.parse(line).event==='client-listening')gatewayReady.resolve();}catch{}}});
  gatewayEnded=new Promise<void>((resolve,reject)=>owned.once('close',(code,signal)=>{record({event:'gateway-close',pid:owned.pid,code,signal});if(spawnError||code!==0){const error=spawnError??new Error(`Gateway exited ${code}/${signal}`);failure=error;gatewayReady.reject(error);reject(error);}else if(state!=='closing'){failure=new Error('Gateway exited unexpectedly');gatewayReady.reject(failure);reject(failure);}else resolve();}));void gatewayEnded.catch(()=>{});
  const timer=setTimeout(()=>gatewayReady.reject(new Error('Gateway ready timeout')),10000);try{await gatewayReady.promise;}finally{clearTimeout(timer);}
  return {root,origin,upstream,gatewayPid:owned.pid!,get state(){return state;},get generation(){return generation;},get productPid(){return host?.pid;},get config(){return fixture!.config;},get firmware(){return fixture!.transport.firmware;},
   arm(){check();if(state!=='online'||spent)throw new Error('One external fault arm is available per session');kill=host!.armExternalFault();state='armed';record({event:'fault-armed',pid:host!.pid,generation});},
   async crash(){check();if(state!=='armed'||!kill||spent)throw new Error('An explicit unspent arm is required');spent=true;state='faulting';expectedCrash=true;const owned=host!;kill();kill=undefined;
    let receipt:CompiledClientExit;try{await owned.lifetime;throw new Error('SIGKILL was not observed');}catch(error){if(!(error instanceof CompiledClientExitError)||error.receipt.signal!=='SIGKILL'||error.receipt.code!==null||error.receipt.pid!==owned.pid)throw error;receipt=error.receipt;}
    state='offline';record({event:'external-product-close',...receipt,generation});return receipt;
   },
   async recover(){check();if(state!=='offline')throw new Error('Explicit recovery requires joined external child exit');expectedCrash=false;state='starting';await start();record({event:'explicit-process-recovery',generation,pid:host!.pid});},
   async close(){await close();},async dispose(){await rm(root,{recursive:true,force:true});}
  };
 }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Client fault fixture setup failed');}throw error;}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [client,assets]=process.argv.slice(2);if(!['fluidd','mainsail'].includes(client)||!assets||process.argv.length!==4)throw new Error('Usage: client-fault-runner.ts fluidd|mainsail /fixed/frontend/assets');
 const ports=client==='fluidd'?[18428,18430]:[18432,18434],started=Date.now(),abort=new AbortController();let session:Awaited<ReturnType<typeof createClientFaultSession>>|undefined;
 const record=(value:unknown)=>console.log(JSON.stringify(value)),timer=setTimeout(()=>abort.abort(new Error('Finite client scene deadline')),888000);
 for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>abort.abort(new Error(signal)));
 const lines=createInterface({input:process.stdin,terminal:false});abort.signal.addEventListener('abort',()=>lines.close(),{once:true});
 try{session=await createClientFaultSession(assets,ports[0],ports[1],record);record({event:'scene-ready',origin:session.origin,root:session.root,deadline:started+900000});
  for await(const line of lines){abort.signal.throwIfAborted();if(line==='ARM')session.arm();else if(line==='CRASH')await session.crash();else if(line==='RECOVER')await session.recover();else if(line==='CLOSE')break;else throw new Error('Unknown explicit scene command');}
 }finally{clearTimeout(timer);lines.close();await session?.close();record({event:'scene-closed',elapsedMs:Date.now()-started,root:session?.root});}
}
