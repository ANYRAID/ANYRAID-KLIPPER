import {serialClock} from '../../src/protocol/serial-queue.ts';
import type {startConfiguredProductService} from '../../src/runtime/product-service.ts';
import type {productMachineFixture} from './product-machine.ts';
type Service=Awaited<ReturnType<typeof startConfiguredProductService>>;
type Fixture=Awaited<ReturnType<typeof productMachineFixture>>;
export function gridStopCause(error:unknown,depth=0):unknown{
 if(error===undefined)return null;if(depth>=4)return {truncated:true};
 if(error instanceof Error)return {name:error.name,message:error.message,...'code' in error?{code:error.code}:{},cause:gridStopCause(error.cause,depth+1),...error instanceof AggregateError?{errors:error.errors.slice(0,8).map(e=>gridStopCause(e,depth+1))}:{}};
 return {value:typeof error==='string'?error.slice(0,256):String(error)};
}
/** Test-only source evidence before cleanup. Sample timestamps and MCU command
 * tails are bounded; all clock handles are borrowed while the group is ready. */
export function gridStopTrace(service:Service,f:Fixture){
 const {group,hardware,linear}=service.printer,started=serialClock.now(),clocks=['mcu','aux'].map(id=>({id,clock:group.session(id).clock}));
 let stage='service-ready',firstStop:unknown;
 const samples:{mcu:string;oid:number;nextClock:string;wireClock:number;firmwareClock:number;elapsedMs:number}[]=[],commands:{mcu:string;name:string;elapsedMs:number}[]=[],counts:Record<string,number>={};
 const elapsed=()=>(serialClock.now()-started)*1000;
 const state=()=>({stage,elapsedMs:elapsed(),port:{phase:linear.port.status.phase,fault:gridStopCause(linear.port.status.fault)},group:{state:group.status.state,fault:gridStopCause(group.status.fault),stopError:gridStopCause(group.status.stopError)},hardware:{state:hardware.status.state,fault:gridStopCause(hardware.status.fault),stopError:gridStopCause(hardware.status.stopError)},heaters:{closed:hardware.heaters.status.closed,fault:hardware.heaters.status.fault},thermal:hardware.thermal.map(({section,runtime})=>{const s=runtime.status;return {section,phase:s.phase,cause:gridStopCause(s.cause),stateFault:s.fault,received:s.received,readTime:s.lastTime,temperature:s.lastTemperature,target:s.target,outputStopConfirmed:s.outputStopConfirmed};}),clocks:clocks.map(({id,clock})=>({mcu:id,state:clock.status.state,fault:gridStopCause(clock.status.fault),stopError:gridStopCause(clock.status.stopError),inFlight:clock.status.inFlight,active:clock.sync.active})),samples:[...samples],commands:[...commands],counts:{...counts}});
 const stopped=(source:string,cause:unknown)=>{firstStop??={source,cause:gridStopCause(cause),state:state()};};
 const detach=[group.subscribeStop(cause=>stopped('mcu-group',cause)),linear.port.subscribeStop(cause=>stopped('motion-port',cause)),...hardware.thermal.map(({section,runtime})=>runtime.subscribeShutdown(cause=>stopped(section,cause)))];
 detach.push(...f.transport.firmware.map((fw,i)=>fw.observeCommands(command=>{if(!['get_clock','endstop_home','trsync_start','trsync_trigger','emergency_stop'].includes(command.name))return;const mcu=i===0?'mcu':'aux',key=mcu+':'+command.name;counts[key]=(counts[key]??0)+1;commands.push({mcu,name:command.name,elapsedMs:elapsed()});if(commands.length>32)commands.shift();})));
 return {stage(value:string){stage=value;},sample(mcu:string,oid:number,nextClock:bigint){samples.push({mcu,oid,nextClock:nextClock.toString(),wireClock:Number(BigInt.asUintN(32,nextClock)),firmwareClock:f.transport.firmware[mcu==='mcu'?0:1].currentClock(),elapsedMs:elapsed()});if(samples.length>32)samples.shift();},snapshot:()=>({firstStop,...state()}),close(){for(const off of detach)off();}};
}
