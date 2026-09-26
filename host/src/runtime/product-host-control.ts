import {randomUUID} from 'node:crypto';
/** Local trusted process control. Coalesce repeated reinitialization requests;
 * the owner resolves only after the next generation is ready, never on dispatch. */
export class ProductHostControl {
 #token=randomUUID();#validate=()=>{};#queuedCancel:(()=>void)|undefined;
 #requests=new Map<string,{request_id:string;state_token:string;state:'queued'|'running'|'succeeded'|'failed';error:string|null}>();
 get status(){return {state_token:this.#token,available:!!this.#handler,busy:!!this.#pending||!!this.#queuedCancel};}
 operation(id:string){const record=this.#requests.get(id);return record?{...record}:null;}
 /** Queue only until response handoff. Readiness is checked again at dispatch;
  * acceptance is not successful recovery and never authorizes file replay. */
 request(id:string,token:string,afterResponse:(callback:(sent:boolean)=>void)=>void){
  const existing=this.#requests.get(id);if(existing){if(existing.state_token!==token)throw new Error('Reinitialization request identity conflicts');return {...existing};}
  if(token!==this.#token)throw new Error('Stale host state token');
  if(!this.#handler)throw new Error('Product host is not ready for reinitialization');
  if(this.#pending||this.#queuedCancel)throw new Error('Reinitialization is already pending');
  if(this.#requests.size>=128)throw new Error('Reinitialization history capacity exceeded');
  this.#validate();const record={request_id:id,state_token:token,state:'queued' as 'queued'|'running'|'succeeded'|'failed',error:null as string|null};this.#requests.set(id,record);
  let settled=false;const finish=(sent:boolean)=>{if(settled)return;settled=true;clearTimeout(timer);this.#queuedCancel=undefined;
   if(!sent||token!==this.#token){record.state='failed';record.error='Response was not handed off or host generation changed';return;}
   record.state='running';void this.reinitialize().then(()=>{record.state='succeeded';},()=>{record.state='failed';record.error='Reinitialization failed; inspect host status and process error';});
  };
  const timer=setTimeout(()=>finish(false),10000);timer.unref();this.#queuedCancel=()=>finish(false);
  try{afterResponse(finish);}catch(error){finish(false);throw error;}
  return {...record};
 }
 #handler:(()=>Promise<void>)|undefined;#pending:Promise<void>|undefined;
 attach(handler:()=>Promise<void>,validate:()=>void=()=>{}):()=>void{
  if(this.#handler)throw new Error('Product host control already owned');this.#handler=handler;this.#validate=validate;this.#token=randomUUID();
  return ()=>{if(this.#handler===handler){this.#queuedCancel?.();this.#handler=undefined;}};
 }
 reinitialize():Promise<void>{
  if(this.#queuedCancel)return Promise.reject(new Error('Remote reinitialization response is pending'));
  if(this.#pending)return this.#pending;
  if(!this.#handler)return Promise.reject(new Error('Product host is not ready for reinitialization'));
  let work:Promise<void>;try{work=this.#handler();}catch(error){return Promise.reject(error);}
  const pending=work.finally(()=>{if(this.#pending===pending)this.#pending=undefined;});this.#pending=pending;return pending;
 }
}
