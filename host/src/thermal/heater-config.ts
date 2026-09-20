import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {AnalogSensorRegistry} from './sensor-config.ts';
import {ADCTemperature} from './adc.ts';
import {PIDControl,BangBangControl} from './control.ts';
import {HeaterRuntime,type HeaterOutput,type ThermalClock,type ThermalTimer} from './runtime.ts';
export interface ConfiguredHeaterOutput extends HeaterOutput { configureCycleTime(seconds:number):void; }
/** Configuration composition only: the caller binds and authenticates MCU pins. */
export function createConfiguredHeater(reader:ConfigurationReader,name:string,output:ConfiguredHeaterOutput,clock:()=>ThermalClock,timer?:ThermalTimer,registry=new AnalogSensorRegistry(reader)) {
 const section=reader.section(name),minimum=section.getFloat('min_temp',{minval:-273.15}),maximum=section.getFloat('max_temp',{above:minimum});
 const minimumExtrude=section.getFloat('min_extrude_temp',{defaultValue:170,minval:minimum,maxval:maximum});
 const smoothTime=section.getFloat('smooth_time',{defaultValue:1,above:0}),maxPower=section.getFloat('max_power',{defaultValue:1,above:0,maxval:1});
 const algorithm=section.get('control'),reportDelay=.3;
 const control=algorithm==='pid'?new PIDControl({kp:section.getFloat('pid_Kp',{minval:0}),ki:section.getFloat('pid_Ki',{minval:0}),kd:section.getFloat('pid_Kd',{minval:0}),smoothTime,maxPower}):algorithm==='watermark'?new BangBangControl(maxPower,section.getFloat('max_delta',{defaultValue:2,above:0})):undefined;
 if(!control)throw new Error('Unsupported heater control algorithm');
 const cycle=section.getFloat('pwm_cycle_time',{defaultValue:.1,above:0,maxval:reportDelay});
 const shortName=name.trim().split(/\s+/).at(-1)!;
 const verification=reader.section('verify_heater '+shortName);
 const check={hysteresis:verification.getFloat('hysteresis',{defaultValue:5,minval:0}),maxError:verification.getFloat('max_error',{defaultValue:120,minval:0}),heatingGain:verification.getFloat('heating_gain',{defaultValue:2,above:0}),checkGainTime:verification.getFloat('check_gain_time',{defaultValue:shortName==='heater_bed'?60:20,minval:1})};
 for(const method of ['configureCycleTime','configureMaximumDuration','schedule','turnOff'] as const)if(typeof output?.[method]!=='function')throw new TypeError('Incomplete heater output adapter');
 const converter=registry.create(section);
 const settings=Object.freeze({minimum,maximum,minimumExtrude,smoothTime,maxPower,reportDelay});
 const runtime=new HeaterRuntime(settings,control,{
  configureMaximumDuration(seconds){output.configureCycleTime(cycle);output.configureMaximumDuration(seconds);},
  schedule(time,power){output.schedule(time,power);},turnOff(){output.turnOff();},
 },clock,check,timer);
 const adc=new ADCTemperature(converter,minimum,maximum,(time,temp)=>runtime.sample(time,temp),reason=>runtime.shutdown(reason));
 return Object.freeze({runtime,adc,converter,settings,pwmCycleTime:cycle,verification:Object.freeze(check)});
}
