import {serialClock} from '../../src/protocol/serial-queue.ts';
import type {hardwareStartupFixture} from './hardware-startup.ts';
type Fixture=Awaited<ReturnType<typeof hardwareStartupFixture>>;
/** Test-only first-stop evidence. Fixed fields, bounded command tail and the
 * same monotonic domain as serial IO; never intercepts or consumes a failure. */
export function stopCause(error:unknown,depth=0):unknown{
 if(error===undefined)return null;if(depth>=4)return {truncated:true};
 if(error instanceof Error)return {name:error.name,message:error.message,...'code' in error?{code:error.code}:{},cause:stopCause(error.cause,depth+1),...error instanceof AggregateError?{errors:error.errors.slice(0,8).map(e=>stopCause(e,depth+1))}:{}};
 return {value:typeof error==='string'?error.slice(0,256):String(error)};
}
export function heaterStopTrace(f:Fixture){
 const started=serialClock.now();let stage='fixture-ready',firstStop:{stage:string;elapsedMs:number;cause:unknown;commands:{mcu:string;name:string;elapsedMs:number}[]}|undefined;const commands:{mcu:string;name:string;elapsedMs:number}[]=[],counts:Record<string,number>={};
 const clocks=['mcu','aux'].map(id=>({id,clock:f.group.session(id).clock}));
 const snapshot=()=>({stage,elapsedMs:(serialClock.now()-started)*1000,firstStop,group:{state:f.group.status.state,fault:stopCause(f.group.status.fault),stopError:stopCause(f.group.status.stopError)},clocks:clocks.map(({id,clock})=>({mcu:id,...clock.status,fault:stopCause(clock.status.fault),stopError:stopCause(clock.status.stopError),active:clock.sync.active})),counts:{...counts},commands:[...commands]});
 const detach=f.firmware.map((fw,i)=>fw.observeCommands(command=>{if(!['get_clock','i2c_transfer','queue_digital_out_generation','emergency_stop'].includes(command.name))return;const mcu=i===0?'mcu':'aux',key=mcu+':'+command.name;counts[key]=(counts[key]??0)+1;commands.push({mcu,name:command.name,elapsedMs:(serialClock.now()-started)*1000});if(commands.length>32)commands.shift();}));
 detach.push(f.group.subscribeStop(cause=>{firstStop??={stage,elapsedMs:(serialClock.now()-started)*1000,cause:stopCause(cause),commands:[...commands]};}));
 return {stage(value:string){stage=value;},snapshot,close(){for(const off of detach)off();}};
}
