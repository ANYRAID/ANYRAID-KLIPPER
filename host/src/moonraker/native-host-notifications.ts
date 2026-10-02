import {readNativeHostStatus,type NativeHostStatusSource} from './native-host-status.ts';
import {nativePrinterState} from './native-printer-info.ts';
import type {KlippyNotification} from './klippy-notifications.ts';
/** Observe one native service generation. No device actions or network awaits.
 * New clients query current state; transitions are not replayed on connection. */
export class NativeHostNotifications {
 readonly #source:NativeHostStatusSource;readonly #emit:(method:KlippyNotification)=>void;
 #last:string|undefined;#timer:ReturnType<typeof setInterval>|undefined;#closed=false;#started=false;#samples=0;#failures=0;
 constructor(source:NativeHostStatusSource,emit:(method:KlippyNotification)=>void){this.#source=source;this.#emit=emit;}
 get status(){return {started:this.#started,closed:this.#closed,samples:this.#samples,failures:this.#failures,state:this.#last??null};}
 start(){if(this.#closed)throw new Error('Native lifecycle observer closed');if(this.#started)return;this.#started=true;this.sample();if(!this.#closed)this.#timer=setInterval(()=>this.sample(),250).unref();}
 sample(){
  if(!this.#started||this.#closed)return;this.#samples++;let state:string;
  try{const snapshot=readNativeHostStatus(this.#source);state=snapshot.closing?'disconnected':nativePrinterState(snapshot).state;}catch{this.#failures++;state='disconnected';}
  const previous=this.#last;if(state===previous)return;this.#last=state;
  const method=state==='ready'?'notify_klippy_ready':state==='shutdown'?'notify_klippy_shutdown':state==='disconnected'&&previous!==undefined?'notify_klippy_disconnected':undefined;
  if(method)try{this.#emit(method);}catch{this.#failures++;}
 }
 close(){this.#closed=true;clearInterval(this.#timer);this.#timer=undefined;}
}
