import {readMCUConnections} from '../config/mcu-connections.ts';
import {uartMCU,type MCUConnection} from './mcu-group.ts';
import {connectCAN,canIdentity} from '../protocol/can.ts';
import {connectPipe} from '../protocol/pipe.ts';
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
export type MCUStartupPolicy={transport:'uart';rts:boolean;leaveBootloader:boolean}|{transport:'pipe'}|{transport:'can';nodeId:number;timeoutMs:number};
export type MCUMachinePolicy=MCUStartupPolicy&{stopDevice:MCUConnection['stopDevice']};
/** Pure transport preflight; no connector or substitute safety callback. */
export function planMCUConnections<P extends MCUStartupPolicy>(reader:ConfigurationReader,policies:ReadonlyMap<string,P>){
 const plans=readMCUConnections(reader),nodes=new Set<string>();
 if(policies.size!==plans.length||plans.some(p=>!policies.has(p.id)))throw new Error('MCU policy must cover every configured MCU exactly');
 return plans.map(plan=>{
  const policy=policies.get(plan.id)!;
  if(!policy||policy.transport!==plan.transport)throw new Error('MCU transport and machine policy differ');
  if(policy.transport==='uart'&&(typeof policy.rts!=='boolean'||typeof policy.leaveBootloader!=='boolean'))throw new Error('UART requires explicit startup policy');
  if(plan.transport==='can'&&policy.transport==='can'){
   if(!Number.isInteger(policy.nodeId))throw new Error('CAN requires an explicit node ID');canIdentity(plan.uuid,policy.nodeId);if(!Number.isInteger(policy.timeoutMs)||policy.timeoutMs<1||policy.timeoutMs>60000)throw new Error('Invalid CAN connection timeout');
   const key=`${plan.interface}:${policy.nodeId}`;if(nodes.has(key))throw new Error('Duplicate CAN node ID on one interface');nodes.add(key);
  }
  return {plan,policy:{...policy}};
 });
}
/** All transports require independent physical safety callbacks. CAN assignment
 * is single-use startup work; policies must not target an active printer bus. */
export function configuredMCUConnections(reader:ConfigurationReader,policies:ReadonlyMap<string,MCUMachinePolicy>):readonly MCUConnection[]{
 const bindings=planMCUConnections(reader,policies);
 for(const {policy} of bindings)if(typeof policy.stopDevice!=='function')throw new Error('MCU transport and machine policy differ');
 return Object.freeze(bindings.map(({plan,policy}):MCUConnection=>{
  const stopDevice=policy.stopDevice;
  if(plan.transport==='uart'&&policy.transport==='uart')return Object.freeze(uartMCU(plan.id,plan.path,{baud:plan.baud,rts:policy.rts,leaveBootloader:policy.leaveBootloader,stopDevice}));
  if(plan.transport==='can'&&policy.transport==='can')return Object.freeze({id:plan.id,stopDevice,connect:(signal:AbortSignal,stop:MCUConnection['stopDevice'])=>connectCAN(plan.interface,plan.uuid,{nodeId:policy.nodeId,timeoutMs:policy.timeoutMs,stopDevice:stop},signal)});
  if(plan.transport==='pipe')return Object.freeze({id:plan.id,stopDevice,connect:(signal:AbortSignal,stop:MCUConnection['stopDevice'])=>connectPipe(plan.path,{stopDevice:stop},signal)});
  throw new Error('Unsupported MCU transport');
 }));
}
