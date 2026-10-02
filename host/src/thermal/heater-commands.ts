import {GCodeDispatch,GCodeError} from '../gcode/dispatch.ts';
import type {StandardHeaterCommands} from './heaters.ts';
export interface HeaterCommandOwner {
 report():string;
 setTarget(name:string,target:number,signal:AbortSignal):Promise<void>;
 setTemperature(name:string,target:number,wait:boolean,signal:AbortSignal,report:()=>void):Promise<void>;
 turnOffAll():void|Promise<void>;
 wait(name:string,minimum:number|undefined,maximum:number|undefined,signal:AbortSignal,report:()=>void):Promise<void>;
}
/** Validate the entire command mapping before registering any command. */
export function bindHeaterCommands(owner:HeaterCommandOwner,hasHeater:(name:string)=>boolean,dispatch:GCodeDispatch,standard:StandardHeaterCommands):void{
  const bed=standard.bed,extruders=standard.extruders?[...standard.extruders]:undefined,active=standard.activeExtruder;
  if(bed!==undefined&&!hasHeater(bed))throw new Error('Bed heater is not registered');
  if(extruders&&(extruders.length===0||extruders.length>64||new Set(extruders).size!==extruders.length||extruders.some(name=>!hasHeater(name))||extruders.length>1&&typeof active!=='function'))throw new Error('Invalid extruder heater mapping');
  const extra=[...(bed!==undefined?['M140','M190']:[]),...(extruders?['M104','M109']:[])];
  for(const name of ['M105','SET_HEATER_TEMPERATURE','TURN_OFF_HEATERS','TEMPERATURE_WAIT',...extra])if(dispatch.hasCommand(name))throw new Error(`Duplicate command '${name}'`);
  const temperature=(raw:string|undefined)=>{const text=raw??'0';if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)||!Number.isFinite(Number(text)))throw new GCodeError('Invalid heater temperature');return Number(text);};
  if(bed!==undefined)for(const name of ['M140','M190'])dispatch.register(name,command=>owner.setTemperature(bed,temperature(command.params.S),name==='M190',command.signal,()=>command.respondRaw(owner.report())));
  if(extruders)for(const name of ['M104','M109'])dispatch.register(name,command=>{
   const target=temperature(command.params.S),raw=command.params.T;let selected:string|undefined;
   if(raw!==undefined){
    if(!/^[+-]?\d+$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)<0)throw new GCodeError('Invalid extruder index');
    selected=extruders[Number(raw)];if(selected===undefined){if(target<=0)return;throw new GCodeError('Extruder not configured');}
   }else{selected=active?active():extruders[0];if(!extruders.includes(selected))throw new GCodeError('Active extruder is not configured');}
   return owner.setTemperature(selected,target,name==='M109',command.signal,()=>command.respondRaw(owner.report()));
  });
  dispatch.register('M105',command=>{const message=owner.report();if(!command.ack(message))command.respondRaw(message);},{whenNotReady:true});
  dispatch.register('SET_HEATER_TEMPERATURE',command=>{
   const name=command.params.HEATER;if(name===undefined)throw new GCodeError('Missing HEATER');
   const raw=command.params.TARGET??'0';
   if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw))throw new GCodeError('Invalid TARGET');
   return owner.setTarget(name,Number(raw),command.signal);
  });
  dispatch.register('TURN_OFF_HEATERS',()=>owner.turnOffAll());
  dispatch.register('TEMPERATURE_WAIT',command=>{
   const name=command.params.SENSOR;if(name===undefined)throw new GCodeError('Missing SENSOR');
   const bound=(key:string)=>{const raw=command.params[key];if(raw===undefined)return undefined;if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw))throw new GCodeError(`Invalid ${key}`);return Number(raw);};
   return owner.wait(name,bound('MINIMUM'),bound('MAXIMUM'),command.signal,()=>command.respondRaw(owner.report()));
  });
}
