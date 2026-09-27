// Endstop phase correction and calibration from klippy/extras/endstop_phase.py.
// GPL-3.0-or-later. Pure arithmetic/state: does not grant homing or move motors.
export interface EndstopPhaseOptions {stepDistance:number;microsteps:number;triggerPhase?:{phase:number;phases:number};accuracy?:number;alignZero?:boolean;}
function period(phases:number){if(!Number.isInteger(phases)||phases<4||phases>1024||(phases&(phases-1)))throw new RangeError('Invalid endstop phase period');}
function modulo(value:bigint,phases:number){const p=BigInt(phases);return Number((value%p+p)%p);}
export class EndstopPhaseAlignment {
 #statistics:ReturnType<typeof endstopPhaseStatistics>|null=null;
 #step:number;#phases:number;#phase:number|null;#accuracy:number;#align:boolean;#history:bigint[];#last:{phase:number;mcuPosition:bigint}|null=null;
 constructor(options:EndstopPhaseOptions){
  const {stepDistance,microsteps,triggerPhase,accuracy,alignZero=false}=options,phases=microsteps*4;period(phases);
  if(!Number.isFinite(stepDistance)||stepDistance<=0||typeof alignZero!=='boolean'||accuracy!==undefined&&(!Number.isFinite(accuracy)||accuracy<=0))throw new RangeError('Invalid endstop phase settings');
  if(triggerPhase&&(!Number.isSafeInteger(triggerPhase.phase)||!Number.isSafeInteger(triggerPhase.phases)||triggerPhase.phase<0||triggerPhase.phases<=0||triggerPhase.phase>=triggerPhase.phases))throw new RangeError('Invalid configured trigger phase');
  // Preserve upstream Float64 operation order when converting user ratios.
  this.#phase=triggerPhase?Math.trunc(triggerPhase.phase/triggerPhase.phases*phases+.5)%phases:null;
  this.#accuracy=accuracy===undefined?phases/2-1:Math.ceil(accuracy*(this.#phase===null?1:.5)/stepDistance);
  if(!Number.isFinite(this.#accuracy)||this.#accuracy>=phases/2)throw new RangeError('Endstop accuracy is insufficient for phase correction');
  if(!Number.isFinite(microsteps*stepDistance)||microsteps*stepDistance===0)throw new RangeError('Unrepresentable full step distance');
  this.#step=stepDistance;this.#phases=phases;this.#align=alignZero;this.#history=Array<bigint>(phases).fill(0n);
 }
 get status(){return Object.freeze({triggerPhase:this.#phase,phases:this.#phases,accuracy:this.#accuracy,last:this.#last});}
 get statistics(){return this.#last?(this.#statistics??=endstopPhaseStatistics(this.#history)):null;}
 get history(){return Object.freeze([...this.#history]);}
 observe(triggerPosition:bigint,offset:number|null):number{
  if(typeof triggerPosition!=='bigint'||offset===null||!Number.isInteger(offset)||offset<0||offset>=this.#phases)throw new RangeError('Unknown or invalid endstop phase observation');
  const phase=modulo(triggerPosition+BigInt(offset),this.#phases);this.#history[phase]++;this.#statistics=null;this.#last=Object.freeze({phase,mcuPosition:triggerPosition});return phase;
 }
 /** offset is a confirmed TMC phase offset; explicitly use 0 for a non-TMC
  * stepper. A trigger counter, not the final halted counter, is required. */
 adjust(triggerPosition:bigint,offset:number|null,endstopPosition:number):number{
  if(typeof triggerPosition!=='bigint'||offset===null||!Number.isInteger(offset)||offset<0||offset>=this.#phases||!Number.isFinite(endstopPosition))throw new RangeError('Unknown or invalid endstop phase observation');
  let align=0;
  // Alignment precedes auto-learning, matching the first-home behavior.
  if(this.#align&&this.#phase!==null){const microsteps=this.#phases/4,half=Math.floor(microsteps/2),phaseOffset=((this.#phase+half)%microsteps-half)*this.#step,full=microsteps*this.#step;align=Math.trunc(endstopPosition/full+.5)*full-endstopPosition+phaseOffset;if(!Number.isFinite(align))throw new RangeError('Endstop alignment overflow');}
  const phase=this.observe(triggerPosition,offset);
  if(this.#phase===null){this.#phase=phase;return 0;}
  let delta=(phase-this.#phase+this.#phases)%this.#phases;
  if(delta>=this.#phases-this.#accuracy)delta-=this.#phases;
  else if(delta>this.#accuracy)throw new Error('Endstop trigger phase exceeds configured accuracy');
  const correction=align+delta*this.#step;if(!Number.isFinite(correction))throw new RangeError('Endstop correction overflow');return correction;
 }
}
/** Original circular median cost and tie order, with O(N) sliding sums instead
 * of O(N²). Integer counts/costs remain exact beyond Number's safe range. */
export function endstopPhaseStatistics(history:readonly bigint[]){
 const phases=history.length;period(phases);if(history.some(n=>typeof n!=='bigint'||n<0n))throw new RangeError('Invalid phase histogram');
 const total=history.reduce((sum,n)=>sum+n,0n);if(total===0n)throw new Error('No endstop phase samples');
 const half=phases/2;let cost=0n,window=0n;
 for(let j=0;j<phases;j++)cost+=history[j]*BigInt(Math.abs(j-half));
 for(let j=1;j<=half;j++)window+=history[j];
 let bestCost=cost,best=half;
 for(let i=0;i<phases-1;i++){
  cost+=2n*window-total;
  window+=history[(i+half+1)%phases]-history[i+1];
  if(cost<bestCost){bestCost=cost;best=i+1+half;}
 }
 let low:number|undefined,high:number|undefined;
 for(let j=best-half;j<best+half;j++)if(history[j%phases]){low??=j%phases;high=j%phases;}
 return Object.freeze({phase:best%phases,phases,low:low!,high:high!,cost:bestCost,samples:total});
}
