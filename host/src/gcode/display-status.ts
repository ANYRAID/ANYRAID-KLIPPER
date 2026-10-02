// Display command semantics from klippy/extras/display_status.py.
// Copyright (C) 2018-2020 Kevin O'Connor, 2018 Eric Callahan; GPL-3.0-or-later.
import {GCodeError,type GCodeDispatch} from './dispatch.ts';
import {parseConfigurationFloat} from '../moonraker/config-reader.ts';
import {serialClock} from '../protocol/serial-queue.ts';
/** Slicer-supplied display metadata, never a completion or motion authority.
 * Expiry uses an injected monotonic clock and an explicit lifecycle predicate. */
export class DisplayStatus {
 #progress:number|null=null;#expires=0;#message:string|null=null;#clock:()=>number;
 constructor(clock:()=>number=serialClock.now){this.#clock=clock;}
 reset():void{this.#progress=null;this.#expires=0;this.#message=null;}
 updateProgress(params:Readonly<Record<string,string>>):void{
  if(!Object.hasOwn(params,'P'))return;
  let value:number;try{value=parseConfigurationFloat(params.P);if(!Number.isFinite(value))throw new Error();}catch{throw new GCodeError('Invalid P');}
  const now=this.#clock();if(!Number.isFinite(now)||now<0||!Number.isFinite(now+5))throw new Error('Invalid display clock');
  this.#progress=Math.min(1,Math.max(0,value/100));this.#expires=now+5;
 }
 setMessage(message:string|null):void{if(message!==null&&(typeof message!=='string'||message.length>65536||message.includes('\0')))throw new GCodeError('Invalid display message');this.#message=message;}
 status(eventtime:number,printing:boolean,fileProgress:number){
  if(!Number.isFinite(eventtime)||eventtime<0||!Number.isFinite(fileProgress)||fileProgress<0||fileProgress>1)throw new RangeError('Invalid display status input');
  if(this.#progress!==null&&eventtime>this.#expires&&!printing)this.#progress=null;
  return {progress:this.#progress??fileProgress,message:this.#message};
 }
 register(dispatch:GCodeDispatch):void{
  dispatch.register('M73',c=>this.updateProgress(c.params));
  dispatch.register('M117',c=>this.setMessage(c.rawParameters()||null));
  dispatch.register('SET_DISPLAY_TEXT',c=>this.setMessage(c.params.MSG??null));
 }
}
