import {HistoryFields} from './history-fields.ts';
import type {PrintController} from '../operations/print.ts';
/** One registry for the process; device controllers borrow it sequentially.
 * Reads the synchronous acknowledged controller gate, never an asynchronous
 * network notification or a sampled printer status. */
export class NativeHistoryFields {
 #controller:PrintController|undefined;
 readonly fields=new HistoryFields(exclude=>this.#controller?.historyTrackingEnabled(exclude)??false);
 bind(controller:PrintController):void{if(this.fields.configuration.length)controller.bindHistoryFields(this.fields);this.#controller=controller;}
}
