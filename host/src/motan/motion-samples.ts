// GPL-3.0-or-later. Offline Motan formulas from scripts/motan/readlog.py.
// Original formulas copyright (C) 2021 Kevin O'Connor.
export interface StepBlock {first_clock:number|bigint;last_clock:number|bigint;first_step_time:number;last_step_time:number;step_distance:number;start_position:number;start_mcu_position:number|bigint;data:readonly (readonly [number,number,number])[];}
export interface DecodedSteps {times:Float64Array;halfPositions:Float64Array;positions:Float64Array;mcuDeltas:Int32Array;startMcuPosition:bigint;startPosition:number;}
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const integer=(value:unknown):bigint=>{if(typeof value==='bigint')return value;if(typeof value==='number'&&Number.isSafeInteger(value))return BigInt(value);throw new Error('Motan clock or MCU position must be an exact integer');};
/** Absolute clocks never pass through Number before subtraction. The fast
 * relative-clock loop is used only after exact endpoint bounds prove safety. */
export function decodeStepBlock(block:StepBlock,maxSteps=1000000):DecodedSteps{
 if(!block||!Number.isSafeInteger(maxSteps)||maxSteps<1||maxSteps>2000000||!Array.isArray(block.data)||!block.data.length||block.data.length>16384||![block.first_step_time,block.last_step_time,block.step_distance,block.start_position].every(finite)||block.last_step_time<block.first_step_time)throw new Error('Invalid Motan step block');
 const first=integer(block.first_clock),last=integer(block.last_clock),startMcu=integer(block.start_mcu_position),span=last-first;if(first<0n||last<first||last>0xffffffffffffffffn)throw new Error('Invalid Motan clock span');
 let count=0,relative=0n,firstInterval=0n;
 for(const [index,row] of block.data.entries()){
  if(!Array.isArray(row)||row.length!==3)throw new Error('Invalid queue_step tuple');const [interval,rawCount,add]=row;
  if(!Number.isSafeInteger(interval)||interval<0||interval>0xffffffff||!Number.isSafeInteger(rawCount)||Math.abs(rawCount)>65535||!Number.isSafeInteger(add)||add< -2147483648||add>2147483647)throw new Error('Invalid queue_step integers');
  const n=Math.abs(rawCount);if(n&&(interval<1||interval+(n-1)*add<1||interval+(n-1)*add>0xffffffff))throw new Error('Invalid queue_step interval progression');if((count+=n)>maxSteps)throw new Error('Motan expanded step limit exceeded');
  if(index===0){firstInterval=BigInt(interval);relative=-firstInterval;}
  relative+=BigInt(n)*BigInt(interval)+BigInt(n)*BigInt(n-1)/2n*BigInt(add);
 }
 const times=new Float64Array(count),halfPositions=new Float64Array(count),positions=new Float64Array(count),mcuDeltas=new Int32Array(count),invFreq=span? (block.last_step_time-block.first_step_time)/Number(span):0;
 const fast=relative<=BigInt(Number.MAX_SAFE_INTEGER),clockBase=-Number(firstInterval);let clock=clockBase,wideClock=-firstInterval,pos=block.start_position,mcuDelta=0,index=0;
 for(const [initial,rawCount,add] of block.data){let interval=initial;const n=Math.abs(rawCount),direction=rawCount<0?-1:1,dist=direction*block.step_distance;
  for(let i=0;i<n;i++){let elapsed:number;if(fast){clock+=interval;elapsed=clock;}else{wideClock+=BigInt(interval);elapsed=Number(wideClock);}interval+=add;const time=block.first_step_time+elapsed*invFreq,half=pos+.5*dist;pos+=dist;mcuDelta+=direction;if(!Number.isFinite(time)||!Number.isFinite(pos)||!Number.isFinite(half))throw new Error('Motan step calculation exceeds finite range');times[index]=time;halfPositions[index]=half;positions[index]=pos;mcuDeltas[index++]=mcuDelta;}
 }
 return {times,halfPositions,positions,mcuDeltas,startMcuPosition:startMcu,startPosition:block.start_position};
}
export function stepPhase(steps:DecodedSteps,index:number,phaseOffset:number|bigint,phases:number):number{
 if(!Number.isInteger(index)||index<0||index>=steps.times.length||!Number.isSafeInteger(phases)||phases<1||phases>2147483647)throw new Error('Invalid Motan phase selection');const p=BigInt(phases),base=Number(((steps.startMcuPosition+integer(phaseOffset))%p+p)%p);return ((base+steps.mcuDeltas[index])%phases+phases)%phases;
}
export type TrapMove=readonly [number,number,number,number,readonly [number,number,number],readonly [number,number,number]];
export type TrapSelection='velocity'|'accel'|'x'|'y'|'z'|'x_velocity'|'y_velocity'|'z_velocity'|'x_accel'|'y_accel'|'z_accel';
export function validateTrapMoves(moves:readonly TrapMove[]):void{
 if(!Array.isArray(moves)||!moves.length||moves.length>65536)throw new Error('Invalid Motan trapq block');for(const move of moves){if(!Array.isArray(move)||move.length!==6||!move.slice(0,4).every(finite)||move[1]<0||!Array.isArray(move[4])||move[4].length!==3||!move[4].every(finite)||!Array.isArray(move[5])||move[5].length!==3||!move[5].every(finite))throw new Error('Invalid Motan trapq move');}
}
const zero:TrapMove=[0,0,0,0,[0,0,0],[0,0,0]];
export class MotanTrapSampler {
 #moves:readonly TrapMove[]=[zero];#at=0;#last=-Infinity;#busy=false;#failure:unknown;
 readonly #source:(time:number)=>Promise<readonly TrapMove[]|null>;readonly #selection:TrapSelection;
 constructor(selection:TrapSelection,source:(time:number)=>Promise<readonly TrapMove[]|null>){if(!/^(velocity|accel|[xyz](_velocity|_accel)?)$/.test(selection))throw new Error('Invalid Motan trapq selection');this.#selection=selection;this.#source=source;}
 async sample(time:number):Promise<number>{
  if(this.#failure)throw this.#failure;if(!finite(time)||time<this.#last||this.#busy)throw new Error('Motan samples require sequential nondecreasing times');this.#busy=true;this.#last=time;
  try{let reads=0;let move:TrapMove,inRange=false;for(;;){move=this.#moves[this.#at];if(time<=move[0]+move[1]){inRange=time>=move[0];break;}if(this.#at+1<this.#moves.length){this.#at++;continue;}if(++reads>4096)throw new Error('Motan source block limit exceeded');const next=await this.#source(time);if(next===null)break;validateTrapMoves(next);this.#moves=next;this.#at=0;}
   const [start,duration,velocity,accel,position,direction]=move,axis='xyz'.indexOf(this.#selection[0]);let result:number;
   if(this.#selection==='velocity')result=inRange?velocity+accel*(time-start):0;
   else if(this.#selection==='accel')result=inRange?accel:0;
   else if(this.#selection.endsWith('_velocity'))result=inRange?(velocity+accel*(time-start))*direction[axis]:0;
   else if(this.#selection.endsWith('_accel'))result=inRange?accel*direction[axis]:0;
   else{const elapsed=Math.max(0,Math.min(duration,time-start)),distance=(velocity+.5*accel*elapsed)*elapsed;result=position[axis]+direction[axis]*distance;}
   if(!Number.isFinite(result))throw new Error('Motan trapq result exceeds finite range');return result;
  }catch(error){this.#failure=error instanceof Error?error:new Error(String(error));throw this.#failure;}finally{this.#busy=false;}
 }
}
interface Point {time:number;half:number;position:number;}
export class MotanStepSampler {
 readonly #source:(time:number)=>Promise<StepBlock|null>;readonly #smooth:number;readonly #maxSteps:number;
 #previous:Point={time:0,half:0,position:0};#next:Point={time:0,half:0,position:0};#steps:DecodedSteps|undefined;#at=0;#last=-Infinity;#busy=false;#failure:unknown;
 constructor(source:(time:number)=>Promise<StepBlock|null>,smoothTime=.010,maxSteps=1000000){if(!finite(smoothTime)||smoothTime<0||!Number.isSafeInteger(maxSteps)||maxSteps<1||maxSteps>2000000)throw new Error('Invalid Motan step smoothing limits');this.#source=source;this.#smooth=smoothTime;this.#maxSteps=maxSteps;}
 async #advance(time:number,budget:{reads:number}):Promise<void>{
  this.#previous=this.#next;
  for(;;){if(this.#steps&&this.#at<this.#steps.times.length){const i=this.#at++;this.#next={time:this.#steps.times[i],half:this.#steps.halfPositions[i],position:this.#steps.positions[i]};return;}
   if(++budget.reads>4096)throw new Error('Motan source block limit exceeded');const block=await this.#source(time);if(block===null){const next=time+.1;if(!(next>time))throw new Error('Motan time cannot represent EOF lookahead');this.#next={time:next,half:this.#previous.position,position:this.#previous.position};return;}
   if(!finite(block.last_step_time))throw new Error('Invalid Motan step block time');if(time>block.last_step_time)continue;
   this.#steps=decodeStepBlock(block,this.#maxSteps);this.#at=0;if(!this.#previous.time)this.#previous={time:0,half:block.start_position,position:block.start_position};
  }
 }
 async sample(time:number):Promise<number>{
  if(this.#failure)throw this.#failure;if(!finite(time)||time<this.#last||this.#busy)throw new Error('Motan samples require sequential nondecreasing times');this.#busy=true;this.#last=time;
  try{const budget={reads:0};while(time>=this.#next.time)await this.#advance(time,budget);const previous=this.#previous,next=this.#next,elapsed=time-previous.time;let duration=next.time-previous.time,result:number;if(!(duration>0))throw new Error('Motan smoothing interval is not positive');
   if(duration<=this.#smooth)result=previous.half+elapsed*(next.half-previous.half)/duration;
   else{duration=.5*this.#smooth;if(elapsed<duration)result=previous.half+elapsed*(previous.position-previous.half)/duration;else{const remaining=next.time-time;result=remaining<duration?next.half+remaining*(previous.position-next.half)/duration:previous.position;}}
   if(!Number.isFinite(result))throw new Error('Motan smoothed position exceeds finite range');return result;
  }catch(error){this.#failure=error instanceof Error?error:new Error(String(error));throw this.#failure;}finally{this.#busy=false;}
 }
}
