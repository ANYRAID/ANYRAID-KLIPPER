import {ApiError,type AuthorizedUser} from './rpc.ts';
interface Pending {expires:number;filename:string;user:string;release():void;}
/** One request may claim only the next observed start in this connection.
 * This records the requester, not proof of command success or file identity. */
export class HistoryAttribution {
 #pending:Pending|undefined;readonly #pendingMs:number;readonly #confirmedMs:number;
 constructor(options:{pendingMs?:number;confirmedMs?:number}={}){
  this.#pendingMs=options.pendingMs??300000;this.#confirmedMs=options.confirmedMs??20000;
  for(const value of [this.#pendingMs,this.#confirmedMs])if(!Number.isSafeInteger(value)||value<1||value>300000)throw new RangeError('Invalid history attribution deadline');
 }
 get pending():boolean{return !!this.#pending&&performance.now()<this.#pending.expires;}
 #expire():void{if(this.#pending&&performance.now()>=this.#pending.expires)this.#pending.release();}
 begin(filename:string,user:AuthorizedUser|undefined,request:AbortSignal,lifetime:AbortSignal):(success:boolean)=>void{
  request.throwIfAborted();lifetime.throwIfAborted();
  if(typeof filename!=='string'||!filename||!filename.isWellFormed()||Buffer.byteLength(filename)>4096)throw new ApiError(400,'Invalid history attribution filename');
  const username=user?.username??'No User';if(typeof username!=='string'||!username||!username.isWellFormed()||username.includes('\0')||Buffer.byteLength(username)>4096)throw new ApiError(400,'Invalid history attribution user');
  this.#expire();if(this.#pending)throw new ApiError(409,'Previous print start is awaiting a job state');
  let settled=false,timer:ReturnType<typeof setTimeout>|undefined;
  const pending:Pending={expires:performance.now()+this.#pendingMs,filename,user:username,release:()=>{if(timer)clearTimeout(timer);request.removeEventListener('abort',pending.release);lifetime.removeEventListener('abort',pending.release);if(this.#pending===pending)this.#pending=undefined;}};
  this.#pending=pending;timer=setTimeout(pending.release,this.#pendingMs);timer.unref();request.addEventListener('abort',pending.release,{once:true});lifetime.addEventListener('abort',pending.release,{once:true});
  return success=>{
   if(settled)return;settled=true;this.#expire();if(this.#pending!==pending)return;
   if(!success){pending.release();return;}
   // A successful response outlives its HTTP request. Only connection death,
   // explicit clear, the next start or this short deadline revokes the claim.
   if(request!==lifetime)request.removeEventListener('abort',pending.release);if(timer)clearTimeout(timer);pending.expires=performance.now()+this.#confirmedMs;timer=setTimeout(pending.release,this.#confirmedMs);timer.unref();
  };
 }
 claim(filename:string|undefined):string|undefined{this.#expire();const pending=this.#pending;if(!pending)return;pending.release();return pending.filename===filename?pending.user:undefined;}
 clear():void{this.#pending?.release();}
}
