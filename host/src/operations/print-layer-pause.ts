import {randomUUID} from 'node:crypto';
import {PrintController} from './print.ts';
import {FilePrintDevice} from './file-print-device.ts';
import {PrintLayerInfo} from '../gcode/print-layer-info.ts';
import type {FileAdmissionPause} from '../gcode/file-execution.ts';
interface Plan {requestId:string;printToken:string;target:number;expiresAt:number;}
type Outcome='none'|'armed'|'cleared'|'expired'|'invalidated'|'pause_requested'|'paused'|'failed';
/** One volatile, generation-scoped intention. Only an accepted file metadata
 * command may fire it. The durable print controller owns pause, deadlines,
 * failures and stop; restart never restores or replays this intention. */
export class PrintLayerPause implements FileAdmissionPause {
 readonly #controller:PrintController;readonly #layers:PrintLayerInfo;readonly #off:()=>void;
 #plan:Plan|undefined;#due=false;#pending=false;#closed=false;#token=randomUUID();
 #timer:ReturnType<typeof setTimeout>|undefined;
 #outcome:Outcome='none';
 constructor(controller:PrintController,file:FilePrintDevice,layers:PrintLayerInfo){
  if(!(controller instanceof PrintController)||!(file instanceof FilePrintDevice)||!(layers instanceof PrintLayerInfo))throw new TypeError('Invalid layer pause ownership');
  this.#controller=controller;this.#layers=layers;this.#off=file.bindAdmissionPause(this);
 }
 #clear(outcome:Outcome){clearTimeout(this.#timer);this.#timer=undefined;this.#plan=undefined;this.#due=false;this.#outcome=outcome;this.#token=randomUUID();}
 #validate(){
  const plan=this.#plan;if(!plan)return;
  if(Date.now()>=plan.expiresAt)this.#clear('expired');
  else if(this.#closed||this.#controller.state!=='printing'||this.#controller.currentRequest?.requestId!==plan.requestId||this.#controller.stateToken!==plan.printToken||this.#layers.requestId!==plan.requestId)this.#clear('invalidated');
 }
 get status(){
  this.#validate();const controller=this.#controller,layers=this.#layers.status;
  return {state_token:this.#token,print_state_token:controller.stateToken,request_id:controller.currentRequest?.requestId??null,current_layer:layers.current_layer,total_layer:layers.total_layer,armed:!!this.#plan,target_layer:this.#plan?.target??null,expires_at:this.#plan?.expiresAt??null,pause_pending:this.#pending,outcome:this.#outcome,persisted:false,available:!this.#closed&&!this.#pending&&controller.state==='printing'&&this.#layers.requestId===controller.currentRequest?.requestId&&layers.current_layer!==null&&layers.total_layer!==null&&!controller.safeStopPending};
 }
 arm(requestId:string,printToken:string,token:string,target:'next'|number,expiresAt:number):void{
  const state=this.status;
  if(!state.available)throw new Error('Layer pause requires a running file print');
  if(state.state_token!==token||state.print_state_token!==printToken||state.request_id!==requestId)throw new Error('Stale layer pause request or state token');
  const current=state.current_layer,total=state.total_layer;
  if(current===null||total===null||!Number.isSafeInteger(current)||!Number.isSafeInteger(total))throw new RangeError('Slicer layer metadata is unavailable');
  const layer=target==='next'?current+1:target;
  if(!Number.isSafeInteger(layer)||layer<=current||layer>total)throw new RangeError('Layer pause target must be a future known layer');
  const now=Date.now();if(!Number.isSafeInteger(expiresAt)||expiresAt<=now||expiresAt-now>86400000)throw new RangeError('Layer pause expiry must be within 24 hours');
  this.#clear('armed');this.#plan={requestId,printToken,target:layer,expiresAt};
  this.#timer=setTimeout(()=>{if(this.#plan?.expiresAt===expiresAt)this.#clear('expired');},expiresAt-now);this.#timer.unref();
 }
 clear(requestId:string,printToken:string,token:string):void{
  const state=this.status;if(this.#closed||this.#pending)throw new Error('Layer pause owner is unavailable');
  if(state.state_token!==token||state.print_state_token!==printToken||state.request_id!==requestId)throw new Error('Stale layer pause request or state token');
  this.#clear('cleared');
 }
 continue():boolean{return !this.#due&&!this.#pending;}
 accepted(command:string,params:Readonly<Record<string,string>>):void{
  if(command!=='SET_PRINT_STATS_INFO'||!this.#plan||!Object.hasOwn(params,'CURRENT_LAYER'))return;
  this.#validate();const plan=this.#plan,current=this.#layers.status.current_layer;
  if(plan&&current!==null&&current>=plan.target)this.#due=true;
 }
 blocked():void{
  if(!this.#due||this.#pending)return;
  this.#validate();if(!this.#plan||!this.#due)return;
  // Called after the file prefix released dispatch. Never await this promise
  // in the file pump: pause failure's safe stop must be able to join that pump.
  this.#clear('pause_requested');this.#pending=true;
  const paused=this.#controller.pause();
  const outcome=(success:boolean)=>{if(!this.#closed){this.#outcome=success&&this.#controller.state==='paused'?'paused':this.#controller.state==='failed'?'failed':'invalidated';this.#token=randomUUID();}};
  void paused.then(()=>outcome(true),()=>outcome(false)).finally(()=>{this.#pending=false;});
 }
 close():void{if(this.#closed)return;this.#closed=true;this.#clear('invalidated');this.#off();}
}
