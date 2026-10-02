export class MaintenanceBusyError extends Error {}
/** One service generation, one JS event loop. Probes must be synchronous and
 * side-effect free. Registration is retained while old producer references can
 * still be called; construct a fresh gate when rebuilding the service. */
export class MaintenanceGate {
 #activities=0;#maintenance=false;#closed=false;readonly #idle=new Set<()=>boolean>();
 get status(){return {activities:this.#activities,maintenance:this.#maintenance,closed:this.#closed,owners:this.#idle.size};}
 /** Read-only readiness hint; acquire() remains the authoritative admission. */
 get available():boolean{
  if(this.#closed||this.#maintenance||this.#activities)return false;
  try{for(const idle of this.#idle)if(idle()!==true)return false;}catch{return false;}
  return true;
 }
 registerIdle(probe:()=>boolean):()=>void{if(typeof probe!=='function')throw new TypeError('Invalid maintenance probe');if(this.#closed||this.#maintenance||this.#idle.size>=64)throw new MaintenanceBusyError('Cannot register a producer during maintenance');this.#idle.add(probe);let released=false;return ()=>{if(!released){released=true;this.#idle.delete(probe);}};}
 activity():()=>void{if(this.#closed||this.#maintenance)throw new MaintenanceBusyError('Maintenance blocks new printer activity');if(this.#activities>=65536)throw new MaintenanceBusyError('Printer activity capacity exceeded');this.#activities++;let released=false;return ()=>{if(!released){released=true;this.#activities--;}};}
 acquire():()=>void{
  if(this.#closed||this.#maintenance||this.#activities)throw new MaintenanceBusyError('Printer activity blocks maintenance');this.#maintenance=true;
  try{for(const idle of this.#idle)if(idle()!==true)throw new MaintenanceBusyError('A printer producer is not idle');}catch(error){this.#maintenance=false;throw error;}
  let released=false;return ()=>{if(!released){released=true;this.#maintenance=false;}};
 }
 invalidate():void{this.#closed=true;}
}
