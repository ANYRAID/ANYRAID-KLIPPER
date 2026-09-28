import {isHtu21d} from './htu21d.ts';
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
export function isI2cTemperature(type:string):boolean{return isHtu21d(type)||['AHT10','AHT1X','AHT2X','AHT3X','SHT3X','LM75'].includes(type);}
export function i2cTemperatureModel(type:string){
 if(!isI2cTemperature(type))throw new Error('Unsupported I2C temperature model');
 if(isHtu21d(type))return {address:64,reportOption:'htu21d_report_time',reportDefault:30,reportMinimum:5,statusPrefix:'htu21d',humidity:'fractional'};
 if(type==='LM75')return {address:72,reportOption:'lm75_report_time',reportDefault:.8,reportMinimum:.5,statusPrefix:'lm75',humidity:'none'};
 return type==='SHT3X'?{address:68,reportOption:'sht3x_report_time',reportDefault:1,reportMinimum:1,statusPrefix:'sht3x',humidity:'fractional'}:{address:56,reportOption:'aht10_report_time',reportDefault:30,reportMinimum:5,statusPrefix:'aht10',humidity:'integer'};
}
export function i2cTemperaturePeriod(reader:ConfigurationReader,section:string):number{
 const c=reader.section(section),model=i2cTemperatureModel(c.get('sensor_type'));
 const bounds={defaultValue:model.reportDefault,minval:model.reportMinimum,maxval:86400};
 return model.statusPrefix==='lm75'?c.getFloat(model.reportOption,bounds):c.getInt(model.reportOption,bounds);
}
