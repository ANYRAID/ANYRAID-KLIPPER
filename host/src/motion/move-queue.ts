import type {StepPacket} from './step-compressor.ts';
const MAX_CLOCK=0x7fffffffffffffffn;
export interface EmitterPackets {id:string;messages:readonly StepPacket[]}
export interface ScheduledPacket extends StepPacket {id:string}
/** MCU move-slot scheduling. minClock on input is the slot-release clock (zero
 * means no slot); on output it is the earliest allowed transmission clock.
 * Per-emitter order and registration-order ties match steppersync.c. */
export class MoveQueueScheduler {
 #ids:readonly string[];#index:Map<string,number>;#queues:StepPacket[][];#heads:number[];
 #slots:bigint[];#pending=0;#bytes=0;#maxBytes:number;#lastClock=0n;
 constructor(ids:readonly string[],moveSlots:number,maxBytes=16*1024*1024){
  if(!ids.length||ids.length>128||new Set(ids).size!==ids.length||ids.some(id=>!/^[A-Za-z0-9_.:-]{1,128}$/.test(id))||!Number.isSafeInteger(moveSlots)||moveSlots<1||moveSlots>65536||!Number.isSafeInteger(maxBytes)||maxBytes<1)throw new RangeError('Invalid move queue configuration');
  this.#ids=[...ids];this.#index=new Map(ids.map((id,i)=>[id,i]));this.#queues=ids.map(()=>[]);this.#heads=ids.map(()=>0);this.#slots=Array<bigint>(moveSlots).fill(0n);this.#maxBytes=maxBytes;
 }
 get pending(){return this.#pending;}
 append(outputs:readonly EmitterPackets[]):void{
  const staged:{index:number;messages:StepPacket[]}[]=[];let count=0,bytes=0;const seen=new Set<string>();
  for(const out of outputs){const index=this.#index.get(out.id);if(index===undefined||seen.has(out.id))throw new Error('Unknown or duplicate move emitter');seen.add(out.id);
   const messages:StepPacket[]=[];
   for(const p of out.messages){
    if(!Buffer.isBuffer(p.data)||p.data.length<1||p.data.length>64||typeof p.minClock!=='bigint'||typeof p.reqClock!=='bigint'||p.minClock<0n||p.minClock>=MAX_CLOCK||p.reqClock<0n||p.reqClock>=MAX_CLOCK)throw new RangeError('Invalid move message');
    count++;bytes+=p.data.length+32;if(this.#pending+count>200000||this.#bytes+bytes>this.#maxBytes)throw new RangeError('Pending move messages exceed budget');
    messages.push({data:Buffer.from(p.data),minClock:p.minClock,reqClock:p.reqClock});
   }
   staged.push({index,messages});
  }
  for(const s of staged)for(const p of s.messages)this.#queues[s.index].push(p);
  this.#pending+=count;this.#bytes+=bytes;
 }
 #replaceSlot(clock:bigint):void{
  let pos=0;const heap=this.#slots;
  for(;;){const a=pos*2+1,b=a+1,ac=heap[a]??MAX_CLOCK,bc=heap[b]??MAX_CLOCK;
   if(clock<=ac&&clock<=bc){heap[pos]=clock;return;}
   const child=ac<bc?a:b;heap[pos]=heap[child];pos=child;
  }
 }
 flush(moveClock:bigint):ScheduledPacket[]{
  if(typeof moveClock!=='bigint'||moveClock<this.#lastClock||moveClock>=MAX_CLOCK)throw new RangeError('Invalid or rewound move flush clock');
  const result:ScheduledPacket[]=[];
  // One candidate per emitter; registration order breaks equal-clock ties.
  const candidates:{index:number;clock:bigint}[]=[];
  const less=(a:{index:number;clock:bigint},b:{index:number;clock:bigint})=>a.clock<b.clock||(a.clock===b.clock&&a.index<b.index);
  const down=(pos:number)=>{for(;;){let child=pos*2+1;if(child>=candidates.length)return;if(child+1<candidates.length&&less(candidates[child+1],candidates[child]))child++;if(!less(candidates[child],candidates[pos]))return;const swap=candidates[pos];candidates[pos]=candidates[child];candidates[child]=swap;pos=child;}};
  for(let i=0;i<this.#queues.length;i++){const p=this.#queues[i][this.#heads[i]];if(p)candidates.push({index:i,clock:p.reqClock});}
  for(let i=(candidates.length>>1)-1;i>=0;i--)down(i);
  for(;;){const selected=candidates[0]?.index??-1;
   if(selected<0)break;const packet=this.#queues[selected][this.#heads[selected]];
   if(packet.minClock!==0n&&packet.reqClock>moveClock)break;
   const available=this.#slots[0];if(packet.minClock!==0n)this.#replaceSlot(packet.minClock);
   result.push({id:this.#ids[selected],data:packet.data,minClock:available,reqClock:packet.reqClock});
   this.#heads[selected]++;this.#pending--;this.#bytes-=packet.data.length+32;
   const next=this.#queues[selected][this.#heads[selected]];
   if(next)candidates[0].clock=next.reqClock;else {const last=candidates.pop()!;if(candidates.length)candidates[0]=last;}
   if(candidates.length)down(0);
  }
  this.#lastClock=moveClock;
  for(let i=0;i<this.#queues.length;i++)if(this.#heads[i]){this.#queues[i]=this.#queues[i].slice(this.#heads[i]);this.#heads[i]=0;}
  return result;
 }
}
