import type {ClockScheduler} from '../../src/timing/clock-runtime.ts';
export async function settle(){for(let i=0;i<20;i++)await Promise.resolve();}
export class FakeClock implements ClockScheduler {
 time=10;#next=0;#jobs=new Map<number,{time:number;callback:()=>void}>();
 now=()=>this.time;
 schedule(callback:()=>void,seconds:number){const id=this.#next++;this.#jobs.set(id,{time:this.time+seconds,callback});return ()=>{this.#jobs.delete(id);};}
 get pending(){return this.#jobs.size;}
 async advance(seconds:number){const end=this.time+seconds;for(let n=0;n<10000;n++){await settle();let choice:number|undefined,at=Infinity;for(const [id,j] of this.#jobs)if(j.time<=end&&j.time<at){choice=id;at=j.time;}if(choice===undefined){this.time=end;await settle();return;}const job=this.#jobs.get(choice)!;this.#jobs.delete(choice);this.time=at;job.callback();}throw new Error('Fake timer loop did not settle');}
}
