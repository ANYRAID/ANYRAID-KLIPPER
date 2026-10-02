import type {calculateScrewTilt} from './screws-tilt.ts';
/** One service-generation result; a new measurement invalidates old advice. */
export class ScrewsCalibrationStatus {
 #state:'idle'|'measuring'|'completed'|'failed'='idle';#limit:number|null=null;
 #result:ReturnType<typeof calculateScrewTilt>|undefined;
 begin(limit?:number){this.#state='measuring';this.#limit=limit??null;this.#result=undefined;}
 complete(result:ReturnType<typeof calculateScrewTilt>){this.#result=structuredClone(result);this.#state='completed';}
 fail(){this.#state='failed';this.#result=undefined;}
 get status(){return {state:this.#state,error:this.#state==='failed'||(this.#result?.error??false),max_deviation:this.#limit,results:Object.fromEntries((this.#result?.results??[]).map(({turns,...r},i)=>['screw'+(i+1),r]))};}
}
