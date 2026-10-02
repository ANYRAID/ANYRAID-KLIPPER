// Coordinate/step conversion from klippy/stepper.py (GPL-3.0-or-later).
const MAX_ROUNDABLE=2**52-1;
function finite(value:number){if(!Number.isFinite(value))throw new RangeError('Nonfinite stepper position');}
function distance(rotation:number,steps:number){if(!Number.isFinite(rotation)||rotation<=0||!Number.isFinite(steps)||steps<=0)throw new RangeError('Invalid rotation distance');const d=rotation/steps;if(!Number.isFinite(d)||d<=0)throw new RangeError('Unrepresentable step distance');return d;}
function rounded(commanded:number,offset:number,step:number):bigint{
 finite(commanded);const value=(commanded+offset)/step;
 // Reserve the half-step bit used by the upstream away-from-zero rounding.
 if(!Number.isFinite(value)||Math.abs(value)>MAX_ROUNDABLE)throw new RangeError('Step position exceeds half-step precision');
 return BigInt(Math.trunc(value>=0?value+.5:value-.5));
}
function alignedOffset(position:bigint,commanded:number,step:number):number{
 finite(commanded);if(position>BigInt(MAX_ROUNDABLE)||position< -BigInt(MAX_ROUNDABLE))throw new RangeError('Step position exceeds half-step precision');
 const offset=Number(position)*step-commanded;finite(offset);
 if(rounded(commanded,offset,step)!==position)throw new RangeError('Coordinate offset loses step precision');return offset;
}
/** Host coordinate model only. Caller must synchronize native solver/history
 * and ensure an idle boundary before changing distance or coordinate origin. */
export class StepperPosition {
 #rotation:number;#steps:number;#distance:number;#offset=0;
 constructor(rotationDistance:number,stepsPerRotation:number){this.#distance=distance(rotationDistance,stepsPerRotation);this.#rotation=rotationDistance;this.#steps=stepsPerRotation;}
 get state(){return {rotationDistance:this.#rotation,stepsPerRotation:this.#steps,stepDistance:this.#distance,offset:this.#offset};}
 mcuPosition(commanded:number):bigint{return rounded(commanded,this.#offset,this.#distance);}
 commandedPosition(position:bigint):number{if(position>BigInt(MAX_ROUNDABLE)||position< -BigInt(MAX_ROUNDABLE))throw new RangeError('Step position exceeds half-step precision');const value=Number(position)*this.#distance-this.#offset;finite(value);return value;}
 align(position:bigint,commanded:number):void{this.#offset=alignedOffset(position,commanded,this.#distance);}
 /** MCU reports a signed 32-bit counter in physical direction. */
 alignResponse(rawPosition:number,inverted:boolean,commanded:number,applyNative?:(position:bigint)=>void):bigint{if(!Number.isInteger(rawPosition)||rawPosition< -0x80000000||rawPosition>0x7fffffff)throw new RangeError('Invalid MCU step position');const position=BigInt(inverted?-rawPosition:rawPosition);const offset=alignedOffset(position,commanded,this.#distance);applyNative?.(position);this.#offset=offset;return position;}
 rebase(before:number,after:number):void{this.align(this.mcuPosition(before),after);}
 /** Validate the whole transition before publishing either distance or offset. */
 setRotationDistance(rotation:number,commanded:number):void{const position=this.mcuPosition(commanded),step=distance(rotation,this.#steps),offset=alignedOffset(position,commanded,step);this.#rotation=rotation;this.#distance=step;this.#offset=offset;}
}
