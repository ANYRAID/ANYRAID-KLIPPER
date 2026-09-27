export interface SafeZHoming {readonly position:readonly [number,number];readonly hop:number;readonly hopSpeed:number;readonly speed:number;readonly moveToPrevious:boolean;}
/** Validate the complete configured path before permitting even the initial hop. */
export function safeZHomingSettings(value:SafeZHoming,limits:{axisMinimum:readonly number[];axisMaximum:readonly number[]}):Readonly<SafeZHoming>{
 if(value.position.length!==2||![...value.position,value.hop,value.hopSpeed,value.speed].every(Number.isFinite)||value.hop<0||value.hopSpeed<=0||value.speed<=0||typeof value.moveToPrevious!=='boolean'||value.position.some((v,i)=>v<limits.axisMinimum[i]||v>limits.axisMaximum[i])||value.hop>limits.axisMaximum[2]||value.hop>0&&value.hop<limits.axisMinimum[2])throw new RangeError('Invalid safe Z homing path');
 return Object.freeze({...value,position:Object.freeze([...value.position]) as readonly [number,number]});
}
