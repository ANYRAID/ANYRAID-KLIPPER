// Integer history reconstruction for homing/probing. GPL-3.0-or-later.
// Row layout originates in klippy/chelper/stepcompress.c.
import type {CompressedSteps} from './step-compressor.ts';
const limit=0x7fffffffffffffffn;
function clock(value:bigint){if(typeof value!=='bigint'||value<0n||value>limit)throw new RangeError('Invalid history clock');}
function position(value:bigint){if(typeof value!=='bigint'||value< -limit-1n||value>limit)throw new RangeError('Invalid history position');}
interface Row {first:bigint;last:bigint;start:bigint;count:bigint;interval:bigint;add:bigint;}
/** A bounded copy of the planned pulses exported (and released) by native flush.
 * This is planned history, not evidence that any pulse physically executed.
 * Keep it through stop readback; resolve the hit clock before discarding it.
 * throughClock is the caller's completed generation frontier, not a stop ACK. */
export class StepHistory {
 #rows:Row[]=[];#head=0;#pins=0;#from:bigint;#through:bigint;#initial:bigint;#last:bigint;#capacity:number;
 constructor(fromClock:bigint,initialPosition:bigint,maxRows=65536){
  clock(fromClock);position(initialPosition);if(!Number.isInteger(maxRows)||maxRows<1||maxRows>200000)throw new RangeError('Invalid history capacity');
  this.#from=this.#through=fromClock;this.#initial=this.#last=initialPosition;this.#capacity=maxRows;
 }
 get status(){return {fromClock:this.#from,throughClock:this.#through,rows:this.#rows.length-this.#head,lastPlannedPosition:this.#last};}
 /** Each native flush yields newest-first rows. Validate the complete extension
  * before publishing it, including continuity and the exact final pulse clock. */
 append(batch:Pick<CompressedSteps,'history'|'position'>,throughClock:bigint):void{
  clock(throughClock);position(batch.position);
  const data=batch.history;
  if(!(data instanceof BigInt64Array)||!(data.buffer instanceof ArrayBuffer)||data.length%6||this.#rows.length-this.#head+data.length/6>this.#capacity||throughClock<this.#through)throw new RangeError('Invalid or over-capacity history extension');
  let previous=this.#head<this.#rows.length?this.#rows.at(-1)!.last:this.#from,current=this.#last;const added:Row[]=[];
  for(let i=data.length-6;i>=0;i-=6){
   const [first,last,start,count,interval,add]=data.subarray(i,i+6);clock(first);clock(last);position(start);
   const n=count<0n?-count:count;
   if(n>65535n||last<first||first<previous||n>0n&&first===previous||start!==current||interval<0n||interval>0xffffffffn||add< -32768n||add>32767n)throw new RangeError('Invalid or discontinuous step history');
   if(n===0n){if(last!==first||interval!==0n||add!==0n)throw new RangeError('Invalid position marker');}
   else{
    const duration=(n-1n)*interval+add*n*(n-1n)/2n;
    const minimumGap=interval+add*(add<0n?n-1n:1n);
    if(last-first!==duration||duration>0xffffffffn||n>1n&&minimumGap<=0n)throw new RangeError('Invalid history pulse timing');
   }
   current=start+count;position(current);previous=last;added.push({first,last,start,count,interval,add});
  }
  if(current!==batch.position)throw new RangeError('History final position mismatch');
  for(const row of added)this.#rows.push(row);this.#last=current;this.#through=throughClock;
 }
 /** Preserve the current baseline through homing/probe readback. Idempotent
  * releases support nested owners; capacity remains enforced while pinned. */
 pin():()=>void{if(this.#pins>=128)throw new RangeError('Too many history pins');this.#pins++;let released=false;return ()=>{if(!released){released=true;this.#pins--;}};}
 /** Discard only completed rows at/before cutoff. A row crossing the cutoff
  * remains intact: its integer pulse polynomial must never be re-rounded.
  * Caller establishes the safe retention horizon in this MCU's clock domain.
  * This method makes no claim that any planned pulse physically executed. */
 pruneBefore(cutoff:bigint):number{
  clock(cutoff);if(cutoff<this.#from||cutoff>this.#through)throw new RangeError('Prune cutoff is outside retained history');
  if(this.#pins||cutoff===this.#from)return 0;
  const initial=this.at(cutoff);let low=this.#head,high=this.#rows.length;
  while(low<high){const mid=(low+high)>>>1;if(this.#rows[mid].last<=cutoff)low=mid+1;else high=mid;}
  const removed=low-this.#head;this.#head=low;this.#from=cutoff;this.#initial=initial;
  // Amortized compaction, instead of shifting the full array for every batch.
  if(this.#head===this.#rows.length){this.#rows=[];this.#head=0;}
  else if(this.#head>=1024&&this.#head*2>=this.#rows.length){this.#rows=this.#rows.slice(this.#head);this.#head=0;}
  return removed;
 }
 at(atClock:bigint):bigint{
  clock(atClock);if(atClock<this.#from||atClock>this.#through)throw new RangeError('Clock is outside retained history');
  let low=this.#head,high=this.#rows.length;
  while(low<high){const mid=(low+high)>>>1;if(this.#rows[mid].first<=atClock)low=mid+1;else high=mid;}
  if(low===this.#head)return this.#initial;
  const row=this.#rows[low-1];if(atClock>=row.last)return row.start+row.count;
  const elapsed=atClock-row.first,n=row.count<0n?-row.count:row.count;
  let steps:bigint;
  if(row.add===0n)steps=elapsed/row.interval+1n;
  else{
   // Binary inversion avoids cancellation in the quadratic formula at exact
   // pulse boundaries. Only the bounded step index uses Number arithmetic.
   let a=1,b=Number(n);
   while(a<b){const m=Math.ceil((a+b)/2),k=BigInt(m),ticks=(k-1n)*row.interval+row.add*k*(k-1n)/2n;if(ticks<=elapsed)a=m;else b=m-1;}
   steps=BigInt(a);
  }
  return row.start+(row.count<0n?-steps:steps);
 }
}
