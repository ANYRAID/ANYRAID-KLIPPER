/** Local trusted process control. Coalesce repeated reinitialization requests;
 * the owner resolves only after the next generation is ready, never on dispatch. */
export class ProductHostControl {
 #handler:(()=>Promise<void>)|undefined;#pending:Promise<void>|undefined;
 attach(handler:()=>Promise<void>):()=>void{
  if(this.#handler)throw new Error('Product host control already owned');this.#handler=handler;
  return ()=>{if(this.#handler===handler)this.#handler=undefined;};
 }
 reinitialize():Promise<void>{
  if(this.#pending)return this.#pending;
  if(!this.#handler)return Promise.reject(new Error('Product host is not ready for reinitialization'));
  let work:Promise<void>;try{work=this.#handler();}catch(error){return Promise.reject(error);}
  const pending=work.finally(()=>{if(this.#pending===pending)this.#pending=undefined;});this.#pending=pending;return pending;
 }
}
