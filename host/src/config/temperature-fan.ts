import {isI2cTemperature,i2cTemperaturePeriod} from '../thermal/i2c-temperature-model.ts';
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {TemperatureFanControl,type TemperatureFanAlgorithm} from '../thermal/temperature-fan.ts';
export function readTemperatureFan(reader:ConfigurationReader,section:string){
 if(!/^temperature_fan \S(?:.*\S)?$/.test(section))throw new Error('Invalid temperature fan section');
 const c=reader.section(section),minimumTemperature=c.getFloat('min_temp',{minval:-273.15}),maximumTemperature=c.getFloat('max_temp',{above:minimumTemperature});
 const settings={minimumTemperature,maximumTemperature,target:c.getFloat('target_temp',{defaultValue:Math.min(40,maximumTemperature),minval:minimumTemperature,maxval:maximumTemperature}),minimumSpeed:c.getFloat('min_speed',{defaultValue:.3,minval:0,maxval:1}),maximumSpeed:c.getFloat('max_speed',{defaultValue:1,above:0,maxval:1})};
 const kind=c.getChoice('control',['watermark','pid']);
 const algorithm:TemperatureFanAlgorithm=kind==='watermark'?{kind,delta:c.getFloat('max_delta',{defaultValue:2,above:0})}:{kind:'pid',kp:c.getFloat('pid_Kp',{minval:0}),ki:c.getFloat('pid_Ki',{minval:0}),kd:c.getFloat('pid_Kd',{minval:0}),derivativeTime:c.getFloat('pid_deriv_time',{defaultValue:2,above:0})};
 const sensorType=c.get('sensor_type'),reportDelay=sensorType==='temperature_host'?1:.3;
 // Keep PWM scheduling short even when the physical sensor reports slowly.
 const sensorTimeout=isI2cTemperature(sensorType)?i2cTemperaturePeriod(reader,section)+6:3;
 new TemperatureFanControl(settings,algorithm,reportDelay);
 return Object.freeze({section,settings:Object.freeze(settings),algorithm:Object.freeze(algorithm),reportDelay,sensorTimeout});
}
