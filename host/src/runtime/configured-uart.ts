import {readMCUUARTConfiguration} from '../config/mcu-uart.ts';
import {uartMCU,type MCUConnection} from './mcu-group.ts';
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
export interface UARTMachinePolicy {
 /** Actual independent physical stop/watchdog acknowledgement, not a no-op. */
 stopDevice:MCUConnection['stopDevice'];
 rts:boolean;leaveBootloader:boolean;
}
/** Compile all declarations and policy coverage before acquiring any device.
 * The returned connectors plug into connectProductPrinter/startProductService. */
export function configuredUARTConnections(reader:ConfigurationReader,policies:ReadonlyMap<string,UARTMachinePolicy>):readonly MCUConnection[]{
 const plans=readMCUUARTConfiguration(reader);
 if(policies.size!==plans.length||plans.some(p=>!policies.has(p.id)))throw new Error('UART machine policy must cover every configured MCU exactly');
 const bindings=plans.map(plan=>{
  const policy=policies.get(plan.id)!;
  if(!policy||typeof policy.stopDevice!=='function'||typeof policy.rts!=='boolean'||typeof policy.leaveBootloader!=='boolean')throw new Error('UART requires explicit startup and safety policy');
  return {plan,policy:{...policy}};
 });
 return Object.freeze(bindings.map(({plan,policy})=>Object.freeze(uartMCU(plan.id,plan.path,{...policy,baud:plan.baud}))));
}
