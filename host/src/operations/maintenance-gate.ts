export type MaintenanceConflictReason='producer_busy'|'maintenance_active'|'admission_closed'|'activity_capacity';
export class MaintenanceBusyError extends Error {
 readonly reason:MaintenanceConflictReason;
 constructor(message:string,reason:MaintenanceConflictReason='producer_busy'){super(message);this.reason=reason;}
}
/** One service generation, one JS event loop. Probes must be synchronous and
 * side-effect free. Registration is retained while old producer references can
 * still be called; construct a fresh gate when rebuilding the service. */
/** Opaque runtime identity. Copies and previously transferred leases have no ownership. */
export interface MaintenanceLease {readonly release:()=>void;}
export class MaintenanceGate {
 #activities=0;#maintenance=false;#closed=false;#lease:MaintenanceLease|undefined;readonly #idle=new Set<()=>boolean>();
 get status(){return {activities:this.#activities,maintenance:this.#maintenance,closed:this.#closed,owners:this.#idle.size};}
 /** Read-only readiness hint; acquire() remains the authoritative admission. */
 get available():boolean{
  if(this.#closed||this.#maintenance||this.#activities)return false;
  try{for(const idle of this.#idle)if(idle()!==true)return false;}catch{return false;}
  return true;
 }
 registerIdle(probe:()=>boolean):()=>void{if(typeof probe!=='function')throw new TypeError('Invalid maintenance probe');if(this.#closed||this.#maintenance||this.#idle.size>=64)throw new MaintenanceBusyError('Cannot register a producer during maintenance');this.#idle.add(probe);let released=false;return ()=>{if(!released){released=true;this.#idle.delete(probe);}};}
 activity():()=>void{if(this.#closed||this.#maintenance)throw new MaintenanceBusyError('Maintenance blocks new printer activity',this.#closed?'admission_closed':'maintenance_active');if(this.#activities>=65536)throw new MaintenanceBusyError('Printer activity capacity exceeded','activity_capacity');this.#activities++;let released=false;return ()=>{if(!released){released=true;this.#activities--;}};}
 acquire():()=>void{const lease=this.acquireLease();return ()=>lease.release();}
 acquireLease():MaintenanceLease{
  if(this.#closed||this.#maintenance||this.#activities)throw new MaintenanceBusyError('Printer activity blocks maintenance');this.#maintenance=true;
  try{for(const idle of this.#idle)if(idle()!==true)throw new MaintenanceBusyError('A printer producer is not idle');}catch(error){this.#maintenance=false;throw error;}
  return this.#replaceLease();
 }
 /** Transfer in one synchronous stack; producers never see maintenance=false. */
 transfer(lease:MaintenanceLease):MaintenanceLease{if(!this.owns(lease))throw new MaintenanceBusyError('Maintenance lease is stale or foreign');return this.#replaceLease();}
 owns(lease:MaintenanceLease|undefined):boolean{return !!lease&&this.#lease===lease&&this.#maintenance&&!this.#closed;}
 #replaceLease():MaintenanceLease{const gate=this,lease:MaintenanceLease=Object.freeze({release(){if(this===lease&&gate.#lease===lease){gate.#lease=undefined;gate.#maintenance=false;}}});this.#lease=lease;return lease;}
 invalidate():void{this.#closed=true;}
}
