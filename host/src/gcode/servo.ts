import {GCodeDispatch,GCodeError} from './dispatch.ts';
import {parseConfigurationFloat} from '../moonraker/config-reader.ts';
import {servoAngleValue,servoWidthValue,type ServoSettings} from '../config/servo.ts';
export function bindServoCommands(dispatch:GCodeDispatch,settings:readonly ServoSettings[],queue:(name:string,value:number,signal:AbortSignal)=>Promise<void>):void{
 const servos=new Map(settings.map(s=>[s.name,s]));
 if(!settings.length||servos.size!==settings.length||dispatch.hasCommand('SET_SERVO'))throw new Error('Invalid servo command ownership');
 dispatch.register('SET_SERVO',command=>{
  const {SERVO,ANGLE,WIDTH}=command.params,servo=servos.get(SERVO);
  if(!servo||Object.keys(command.params).some(k=>!['SERVO','ANGLE','WIDTH'].includes(k))||(ANGLE===undefined)===(WIDTH===undefined))throw new GCodeError('SET_SERVO requires a configured SERVO and one ANGLE or WIDTH');
  let value:number;try{value=WIDTH===undefined?servoAngleValue(servo,parseConfigurationFloat(ANGLE)):servoWidthValue(servo,parseConfigurationFloat(WIDTH));}catch{throw new GCodeError('Invalid servo value');}
  return queue(SERVO,value,command.signal);
 });
}
