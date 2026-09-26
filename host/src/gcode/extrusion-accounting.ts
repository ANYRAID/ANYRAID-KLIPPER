/** Signed commanded filament in unscaled G-code millimetres. This is accepted
 * host motion, not an encoder measurement or proof of physical consumption. */
export class ExtrusionAccounting {
 #active=false;#sum:number|null=0;#correction=0;
 #extrusionStarted=false;#activeSince:number|undefined;#elapsed=0;
 get filamentUsed():number|null{return this.#sum;}
 /** Seconds since first net-positive extrusion, excluding acknowledged pauses.
  * Timestamp reads occur at the first extrusion, lifecycle edges and queries. */
 get printDuration():number|null{return this.#sum===null?null:(this.#elapsed+(this.#activeSince===undefined?0:Math.max(0,performance.now()-this.#activeSince)))/1000;}
 begin():void{this.reset();this.#active=true;}
 reset():void{this.#active=false;this.#sum=0;this.#correction=0;this.#extrusionStarted=false;this.#activeSince=undefined;this.#elapsed=0;}
 restoreUnknown():void{this.reset();this.#sum=null;}
 setActive(active:boolean):void{
  if(active===this.#active)return;
  if(this.#activeSince!==undefined){this.#elapsed+=Math.max(0,performance.now()-this.#activeSince);this.#activeSince=undefined;}
  this.#active=active;
  if(active&&this.#extrusionStarted&&this.#sum!==null)this.#activeSince=performance.now();
 }
 /** Never reject already accepted motion because diagnostic accounting overflowed. */
 accepted(previous:number,next:number,factor:number):void{
  if(!this.#active||this.#sum===null||previous===next)return;
  const delta=(next-previous)/factor,adjusted=delta-this.#correction,total=this.#sum+adjusted;
  this.#correction=(total-this.#sum)-adjusted;
  this.#sum=Number.isFinite(total)&&Number.isFinite(this.#correction)?total:null;
  if(this.#sum!==null&&!this.#extrusionStarted&&this.#sum>=1e-7){this.#extrusionStarted=true;this.#activeSince=performance.now();}
 }
}
