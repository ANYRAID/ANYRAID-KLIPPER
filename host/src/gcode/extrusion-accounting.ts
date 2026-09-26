/** Signed commanded filament in unscaled G-code millimetres. This is accepted
 * host motion, not an encoder measurement or proof of physical consumption. */
export class ExtrusionAccounting {
 #active=false;#sum:number|null=0;#correction=0;
 get filamentUsed():number|null{return this.#sum;}
 begin():void{this.reset();this.#active=true;}
 reset():void{this.#active=false;this.#sum=0;this.#correction=0;}
 restoreUnknown():void{this.#active=false;this.#sum=null;this.#correction=0;}
 setActive(active:boolean):void{this.#active=active;}
 /** Never reject already accepted motion because diagnostic accounting overflowed. */
 accepted(previous:number,next:number,factor:number):void{
  if(!this.#active||this.#sum===null||previous===next)return;
  const delta=(next-previous)/factor,adjusted=delta-this.#correction,total=this.#sum+adjusted;
  this.#correction=(total-this.#sum)-adjusted;
  this.#sum=Number.isFinite(total)&&Number.isFinite(this.#correction)?total:null;
 }
}
