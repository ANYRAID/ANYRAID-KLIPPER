import {GCodeDispatch,GCodeError} from './dispatch.ts';
import {parseConfigurationFloat} from '../moonraker/config-reader.ts';
/** Fixed-value product action. Arbitrary template execution is not admitted. */
export function bindOutputPinCommands(dispatch:GCodeDispatch,names:readonly string[],queue:(name:string,value:number,signal:AbortSignal)=>Promise<void>):void{
 const known=new Set(names);
 if(!names.length||known.size!==names.length||dispatch.hasCommand('SET_PIN'))throw new Error('Invalid output pin command ownership');
 dispatch.register('SET_PIN',command=>{
  const {PIN,VALUE}=command.params;
  if(Object.keys(command.params).some(k=>k!=='PIN'&&k!=='VALUE')||!known.has(PIN)||VALUE===undefined)throw new GCodeError('SET_PIN requires a configured PIN and fixed VALUE');
  let value:number;try{value=parseConfigurationFloat(VALUE);}catch{throw new GCodeError('Invalid output pin value');}
  return queue(PIN,value,command.signal);
 });
}
