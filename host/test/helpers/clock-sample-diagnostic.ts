import type {MockTracker} from 'node:test';
import {ClockSync, type ClockSample, type ClockEstimate, type ReleaseEstimate} from '../../src/timing/clock-sync.ts';

type Sample = {sample:ClockSample;warmup:boolean;revision:number;before:ClockEstimate;after:ClockEstimate;release:ReleaseEstimate|null};
type Capture = {initial:{frequency:number;uptimeClock:bigint;sentTime:number};count:number;warmup:Sample[];recent:Sample[]};
/** Test-only observation at the existing estimator call. The original method
 * runs exactly once with unchanged operands; returned values/errors propagate.
 * Retain every initial warmup plus 32 recent replies per physical estimator.
 * No production observer, timer, calibration, motion or deadline is added. */
export function captureClockSamples(mock:MockTracker){
 const captures=new Map<ClockSync,Capture>(),original=ClockSync.prototype.accept;
 mock.method(ClockSync.prototype,'accept',function(this:ClockSync,sample:ClockSample,warmup=false){
  const before=this.estimate;
  let capture=captures.get(this);
  if(!capture){capture={initial:{frequency:this.nominalFrequency,uptimeClock:before.origin,sentTime:before.sampleTime},count:0,warmup:[],recent:[]};captures.set(this,capture);}
  const input={...sample},release=original.call(this,sample,warmup);
  const row={sample:input,warmup,revision:this.revision,before,after:this.estimate,release:release?{...release}:null};capture.count++;
  if(warmup&&capture.warmup.length<8)capture.warmup.push(row);
  else{capture.recent.push(row);if(capture.recent.length>32)capture.recent.shift();}
  return release;
 });
 return {snapshot(bindings:readonly {id:string;sync:ClockSync}[]){return structuredClone(bindings.map(({id,sync})=>({id,...captures.get(sync)})));}};
}
