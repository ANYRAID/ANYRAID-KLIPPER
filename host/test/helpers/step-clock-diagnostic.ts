import {StepCompressor,type CompressedSteps} from '../../src/motion/step-compressor.ts';
/** Test-only bounded observations. Original calls, arguments, results and
 * exceptions are preserved. Emit only on failure; this is not a benchmark. */
export function captureStepClockDiagnostics(emit:(value:unknown)=>void){
 const identities=new WeakMap<StepCompressor,number>();let sequence=0;
 const recent:unknown[]=[];
 const identity=(owner:StepCompressor)=>{let id=identities.get(owner);if(id===undefined){id=++sequence;identities.set(owner,id);}return id;};
 const record=(event:unknown)=>{recent.push(event);if(recent.length>64)recent.shift();};
 const read=(work:()=>unknown)=>{try{return work();}catch(error){return {unavailable:String(error)};}};
 const validate=StepCompressor.prototype.validateClockCalibration,generate=StepCompressor.prototype.generate,flush=StepCompressor.prototype.flush,flushThrough=StepCompressor.prototype.flushThrough;
 StepCompressor.prototype.validateClockCalibration=function(offset:number,frequency:number){
  try{return validate.call(this,offset,frequency);}catch(error){
   const generated=read(()=>this.generatedTime);
   // Observed returned history does not include the compressor's pending
   // future pulse; label it explicitly rather than inventing that frontier.
   try{emit({stepClockFailure:{owner:identity(this),error:String(error),nativeCode:read(()=>error&&typeof error==='object'&&'code' in error?error.code:null),nativeBoundary:read(()=>error&&typeof error==='object'&&'calibrationBoundary' in error?error.calibrationBoundary:null),generated,previous:read(()=>this.calibration),candidate:{offset,frequency},previousClock:read(()=>this.clockAt(this.generatedTime)),candidateRaw:typeof generated==='number'?(generated-offset)*frequency:null,candidateRounded:typeof generated==='number'?Math.floor((generated-offset)*frequency+.5):null,scan:read(()=>this.scanWindow),recent,pendingNativeFrontier:'Use actual nativeBoundary when present; returned history remains incomplete'}});}catch{}
   throw error;
  }
 };
 StepCompressor.prototype.generate=function(until:number){const result=generate.call(this,until);record({kind:'generate',owner:identity(this),until});return result;};
 const observed=(owner:StepCompressor,result:CompressedSteps,boundary:number|null)=>{record({kind:'flush',owner:identity(owner),boundary,maximumReturnedRequestClock:result.messages.reduce((maximum,message)=>message.reqClock>maximum?message.reqClock:maximum,0n).toString(),latestReturnedHistoryClock:result.history.length?result.history[1].toString():null});return result;};
 StepCompressor.prototype.flush=function(){return observed(this,flush.call(this),null);};
 StepCompressor.prototype.flushThrough=function(until:number){return observed(this,flushThrough.call(this,until),until);};
 return ()=>{StepCompressor.prototype.validateClockCalibration=validate;StepCompressor.prototype.generate=generate;StepCompressor.prototype.flush=flush;StepCompressor.prototype.flushThrough=flushThrough;};
}
