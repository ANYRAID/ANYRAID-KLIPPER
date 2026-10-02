// Digital button protocol from klippy/extras/buttons.py and src/buttons.c.
// GPL-3.0-or-later.
import type {MessageDictionary,DecodedMessage} from '../protocol/dictionary.ts';
import type {PinBinding} from '../protocol/pins.ts';
export const buttonFormats={config:'config_buttons oid=%c button_count=%c',add:'buttons_add oid=%c pos=%c pin=%u pull_up=%c',query:'buttons_query oid=%c clock=%u rest_ticks=%u retransmit_count=%c invert=%c',ack:'buttons_ack oid=%c count=%c',state:'buttons_state oid=%c ack_count=%c state=%*s'} as const;
export interface CompiledButtons {readonly oid:number;readonly count:number;readonly invert:number;readonly initialClock:bigint;readonly commands:readonly string[];readonly init:readonly string[];}
export function compileButtons<T>(chip:T,d:MessageDictionary,options:{oid:number;pins:readonly PinBinding<T>[];currentPrintTime:number},clockAt:(time:number)=>bigint):CompiledButtons{
 const {oid,pins,currentPrintTime}=options;
 if(!Number.isInteger(oid)||oid<0||oid>254||pins.length<1||pins.length>8||pins.some(p=>p.chip!==chip||!p.pin||/[\s^~!:]/u.test(p.pin)||![0,1].includes(p.invert)||![-1,0,1].includes(p.pullup))||new Set(pins.map(p=>p.pin)).size!==pins.length)throw new Error('Invalid buttons pin batch');
 const frequency=Number(d.constant('CLOCK_FREQ')),restTicks=Math.trunc(frequency*.002);
 if(!Number.isFinite(frequency)||frequency<=0||frequency>1e9||restTicks<1||!Number.isFinite(currentPrintTime)||currentPrintTime<0||currentPrintTime+1.5<=currentPrintTime)throw new Error('Invalid buttons clock');
 const initialClock=clockAt(Math.trunc(currentPrintTime+1.5))+BigInt(Math.trunc(oid*.01*frequency));if(initialClock<0n||initialClock>=0x7fffffffffffffffn)throw new Error('Invalid buttons query slot');
 for(const format of Object.values(buttonFormats))d.lookup(format);
 const invert=pins.reduce((mask,p,i)=>mask|p.invert<<i,0),commands=[`config_buttons oid=${oid} button_count=${pins.length}`],init=[...pins.map((p,i)=>`buttons_add oid=${oid} pos=${i} pin=${p.pin} pull_up=${p.pullup}`),`buttons_query oid=${oid} clock=${BigInt.asUintN(32,initialClock)} rest_ticks=${restTicks} retransmit_count=50 invert=${invert}`];
 for(const command of [...commands,...init])d.encodeCommand(command);
 return Object.freeze({oid,count:pins.length,invert,initialClock,commands:Object.freeze(commands),init:Object.freeze(init)});
}
export interface ButtonBatch {readonly ack:number;readonly samples:readonly Readonly<{state:number;changed:number}>[];}
/** Decode the MCU's overlapping 8-byte retransmit window before any callbacks.
 * Caller must send exactly ack bytes and serialize acknowledgement publication.
 * A forward gap or malformed report faults this generation; never invent input. */
export class ButtonInput {
 #oid:number;#mask:number;#invert:number;#ack=0n;#state=0;#failed=false;
 constructor(config:Pick<CompiledButtons,'oid'|'count'|'invert'>){
  if(!Number.isInteger(config.oid)||config.oid<0||config.oid>254||!Number.isInteger(config.count)||config.count<1||config.count>8||!Number.isInteger(config.invert)||config.invert<0||config.invert>=2**config.count)throw new Error('Invalid buttons decoder configuration');
  this.#oid=config.oid;this.#mask=(1<<config.count)-1;this.#invert=config.invert;
 }
 get status(){return {acknowledged:this.#ack,state:this.#state,failed:this.#failed};}
 receive(message:DecodedMessage):ButtonBatch|undefined{
  const p=message.parameters;if(message.name!=='buttons_state'||p.oid!==this.#oid)return;
  if(this.#failed)throw new Error('Buttons input is faulted');
  try{
   if(typeof p.ack_count!=='number'||!Number.isInteger(p.ack_count)||p.ack_count<0||p.ack_count>255||!(p.state instanceof Uint8Array)||p.state.length<1||p.state.length>8||p.state.some(value=>(value&~this.#mask)!==0))throw new Error('Invalid buttons report');
   let diff=(p.ack_count-Number(this.#ack&255n))&255;diff-=(diff&128)<<1;
   if(diff>0)throw new Error('Buttons acknowledgement gap');
   const count=p.state.length+diff;if(count<=0)return;
   let state=this.#state;const samples=[];
   for(let i=-diff;i<p.state.length;i++){const value=p.state[i]^this.#invert;samples.push(Object.freeze({state:value,changed:state^value}));state=value;}
   this.#ack+=BigInt(count);this.#state=state;return Object.freeze({ack:count,samples:Object.freeze(samples)});
  }catch(error){this.#failed=true;throw error;}
 }
}
