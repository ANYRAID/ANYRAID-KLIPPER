import {Thermistor} from '../../src/thermal/thermistor.ts';
const converter=new Thermistor(4700,0,{points:[[25,100000],[150,1770],[250,230]]});
interface ClientFirmware {
 outputs:{name:string;parameters:Record<string,unknown>}[];
 currentClock():number;
 emit(name:string,parameters:{oid:number;next_clock:number;values:Buffer}):void;
}
/** Interactive UI fixture only. A stopped MCU no longer has a host reader;
 * continuing to emit would fill its PTY and make a later write fail EAGAIN. */
export function emitClientTemperatures(devices:readonly ClientFirmware[],stops:readonly number[],temperature:(device:number,oid:number)=>number=()=>25):void{
 for(const [index,device] of devices.entries()){
  if(stops[index])continue;
  for(const entry of device.outputs.filter(e=>e.name==='query_analog_in')){
   const p=entry.parameters,raw=Math.round(converter.adc(temperature(index,Number(p.oid)))*4095*Number(p.sample_count)),next=device.currentClock()+Number(p.rest_ticks)-Number(p.sample_ticks)*Number(p.sample_count);
   device.emit('analog_in_state',{oid:Number(p.oid),next_clock:next>>>0,values:Buffer.from([raw&255,raw>>8])});
  }
 }
}
