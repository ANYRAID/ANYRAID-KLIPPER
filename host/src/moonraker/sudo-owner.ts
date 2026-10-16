import {userInfo} from 'node:os';
import {ApiError,authorizedContext,type Json,type RpcContext} from './rpc.ts';
import type {EndpointRegistry} from './endpoints.ts';
import type {SudoBackend,SudoOperation,SudoInstallReceipt,SudoDeploymentDeclaration} from './sudo-backend.ts';

export interface SudoConsumerResult {message:string;restart:boolean;}
type Consumer={id:string;message:string;run(context:RpcContext):Promise<SudoConsumerResult>};
/** Process-only memory owner. Callbacks remain queued until known completion;
 * cancellation never pops an in-flight installation or automatically retries it. */
export class ProcessSudoOwner {
 readonly #backend:SudoBackend;readonly #consumers:Consumer[]=[];readonly #pending=new Set<Promise<unknown>>();readonly #stop=new AbortController();
 readonly #notify:(event:Json)=>void;readonly #restart:(context:RpcContext)=>Promise<void>;
 #password:Buffer|undefined;#busy=false;#operations=0;#restartRequired=false;#closing:Promise<void>|undefined;
 constructor(backend:SudoBackend,notify:(event:Json)=>void,restart:(context:RpcContext)=>Promise<void>){this.#backend=backend;this.#notify=notify;this.#restart=restart;}
 setConfiguredPassword(password:string):void{if(this.#busy||this.#operations||this.#stop.signal.aborted||!password||!password.isWellFormed()||/[\0\r\n]/u.test(password)||Buffer.byteLength(password)>4096)throw new ApiError(400,'Invalid private sudo password');this.#password?.fill(0);this.#password=Buffer.from(password);}
 get snapshot(){const messages=[...this.#consumers.map(c=>c.message),...this.#restartRequired?['Installation completed; process restart still required.']:[]];return {sudo_requested:messages.length>0,sudo_request_message:messages.join('\n'),request_messages:messages,linux_user:userInfo().username,busy:this.#busy,restart_required:this.#restartRequired};}
 #changed(){this.#notify({sudo_requested:this.snapshot.sudo_requested,request_messages:this.snapshot.request_messages});}
 register(id:string,message:string,run:Consumer['run']):()=>void{
  if(this.#stop.signal.aborted||this.#consumers.length>=16||this.#consumers.some(c=>c.id===id)||typeof run!=='function'||!message||message.length>4096)throw new ApiError(409,'Sudo consumer registration unavailable');
  const c={id,message,run};this.#consumers.push(c);this.#changed();return ()=>{const at=this.#consumers.indexOf(c);if(at>=0){this.#consumers.splice(at,1);this.#changed();}};
 }
 operation(operation:SudoOperation,signal:AbortSignal):Promise<SudoInstallReceipt>{
  if(this.#stop.signal.aborted)return Promise.reject(new ApiError(503,'Sudo owner closed'));if(this.#operations>=4)return Promise.reject(new ApiError(429,'Sudo operation capacity exceeded'));
  this.#operations++;const password=this.#password?Buffer.from(this.#password):undefined;
  const task=Promise.resolve().then(()=>this.#backend.execute(operation,password,AbortSignal.any([signal,this.#stop.signal])));this.#pending.add(task);return task.finally(()=>{password?.fill(0);this.#pending.delete(task);this.#operations--;});
 }
 deployment(signal:AbortSignal):Promise<SudoDeploymentDeclaration|undefined>{
  if(this.#stop.signal.aborted)return Promise.reject(new ApiError(503,'Sudo owner closed'));if(!this.#backend.deployment)return Promise.resolve(undefined);if(this.#operations>=4)return Promise.reject(new ApiError(429,'Sudo operation capacity exceeded'));this.#operations++;const task=Promise.resolve().then(()=>this.#backend.deployment!(AbortSignal.any([signal,this.#stop.signal])));this.#pending.add(task);return task.finally(()=>{this.#pending.delete(task);this.#operations--;});
 }
 async info(check=false,signal:AbortSignal):Promise<Json>{let sudo_access:boolean|null=null;if(check)try{await this.operation('probe',signal);sudo_access=true;}catch{signal.throwIfAborted();sudo_access=false;}return {sudo_access,linux_user:this.snapshot.linux_user,sudo_requested:this.snapshot.sudo_requested,request_messages:this.snapshot.request_messages};}
 setPassword(password:string,context:RpcContext):Promise<Json>{
  if(this.#busy||this.#stop.signal.aborted)return Promise.reject(new ApiError(409,'Another sudo password operation is pending'));
  if(typeof password!=='string'||!password||!password.isWellFormed()||/[\0\r\n]/u.test(password)||Buffer.byteLength(password)>4096)return Promise.reject(new ApiError(400,'Invalid sudo password'));
  this.#busy=true;const input=Buffer.from(password);let bound={...context,signal:AbortSignal.any([context.signal,this.#stop.signal])};
  const task=(async()=>{
   bound=authorizedContext(bound,await bound.authorize('machine.sudo.password',{}));bound.signal.throwIfAborted();this.#password?.fill(0);this.#password=input;
   try{await this.operation('probe',bound.signal);}catch{this.#password?.fill(0);this.#password=undefined;bound.signal.throwIfAborted();throw new ApiError(400,'Sudo password validation failed');}
   bound=authorizedContext(bound,await bound.authorize('machine.sudo.password',{}));bound.signal.throwIfAborted();const responses:string[]=[],failed:Consumer[]=[];
   for(const c of [...this.#consumers]){bound=authorizedContext(bound,await bound.authorize('machine.sudo.password',{}));bound.signal.throwIfAborted();try{
    const result=await c.run(bound);responses.push(result.message);this.#restartRequired||=result.restart;const at=this.#consumers.indexOf(c);if(at>=0)this.#consumers.splice(at,1);this.#changed();
   }catch{failed.push(c);if(bound.signal.aborted)throw bound.signal.reason;}}
   this.#changed();if(failed.length)throw new ApiError(500,'Sudo installation callback failed; request retained');
   if(this.#restartRequired){bound=authorizedContext(bound,await bound.authorize('machine.sudo.password',{}));bound.signal.throwIfAborted();if(!bound.afterResponse)throw new ApiError(503,'Response handoff unavailable');await this.#restart(bound);}
   return {sudo_responses:responses,is_restarting:this.#restartRequired};
  })();this.#pending.add(task);return task.finally(()=>{if(this.#password!==input)input.fill(0);this.#pending.delete(task);this.#busy=false;});
 }
 registerEndpoints(endpoints:EndpointRegistry):()=>void{
  const info=endpoints.register({endpoint:'/machine/sudo/info',methods:['GET'],transports:['http','websocket']},async(params,_verb,context)=>{if(Object.keys(params).some(k=>k!=='check_access'))throw new ApiError(400,'Invalid sudo info query');const check=params.check_access??false;if(typeof check!=='boolean'&&check!=='true'&&check!=='false')throw new ApiError(400,'Invalid sudo access flag');const result=await this.info(check===true||check==='true',context.signal);authorizedContext(context,await context.authorize('machine.sudo.info',{}));return result;});
  const password=endpoints.register({endpoint:'/machine/sudo/password',methods:['POST'],transports:['http','websocket']},(params,_verb,context)=>{if(Object.keys(params).length!==1||typeof params.password!=='string')throw new ApiError(400,'Expected sudo password only');return this.setPassword(params.password,context);});return ()=>{password();info();};
 }
 close():Promise<void>{this.#stop.abort(new ApiError(503,'Sudo owner closed'));return this.#closing??=(async()=>{const results=await Promise.allSettled([...this.#pending]);try{await this.#backend.close();}finally{this.#password?.fill(0);this.#password=undefined;this.#consumers.length=0;}const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)throw new AggregateError(errors,'Sudo consumer shutdown failed');})();}
 toJSON(){return this.snapshot;}
 [Symbol.for('nodejs.util.inspect.custom')](){return 'ProcessSudoOwner <private>';}
}
