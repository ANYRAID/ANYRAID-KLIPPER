// Encoder runout distance policy derived from klippy/extras/filament_motion_sensor.py.
// GPL-3.0-or-later.
/** Supply the extruder position at the observation clock (including pressure
 * advance), never the G-code admission endpoint. This state owns no hardware. */
export class FilamentMotionState {
 #length:number;#limit:number|undefined;#time=-Infinity;#present=false;
 constructor(detectionLength=7){if(!Number.isFinite(detectionLength)||detectionLength<=0)throw new RangeError('Invalid filament detection length');this.#length=detectionLength;}
 get status(){return {initialized:this.#limit!==undefined,filamentDetected:this.#present,runoutPosition:this.#limit};}
 #validate(time:number,position:number):void{if(!Number.isFinite(time)||time<0||time<this.#time||!Number.isFinite(position))throw new RangeError('Invalid filament motion observation');}
 /** Initial allowance and every encoder edge reset the expected forward travel.
  * Retraction alone does not reset the allowance. Validate before mutation. */
 pulse(time:number,position:number):void{
  this.#validate(time,position);const limit=position+this.#length;
  if(!Number.isFinite(limit)||limit<=position)throw new RangeError('Filament detection length is below position resolution');
  this.#time=time;this.#limit=limit;this.#present=true;
 }
 check(time:number,position:number):boolean{
  this.#validate(time,position);if(this.#limit===undefined)throw new Error('Filament motion baseline is not initialized');
  this.#time=time;return this.#present=position<this.#limit;
 }
}
