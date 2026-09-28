import type {ConfigurationReader} from '../moonraker/config-reader.ts';
export function isI2cTemperature(type:string):boolean{return ['AHT10','AHT1X','AHT2X','AHT3X','SHT3X'].includes(type);}
export function i2cTemperatureModel(type:string){
 if(!isI2cTemperature(type))throw new Error('Unsupported I2C temperature model');
 return type==='SHT3X'?{address:68,reportOption:'sht3x_report_time',reportDefault:1,reportMinimum:1,statusPrefix:'sht3x'}:{address:56,reportOption:'aht10_report_time',reportDefault:30,reportMinimum:5,statusPrefix:'aht10'};
}
export function i2cTemperaturePeriod(reader:ConfigurationReader,section:string):number{
 const c=reader.section(section),model=i2cTemperatureModel(c.get('sensor_type'));
 return c.getInt(model.reportOption,{defaultValue:model.reportDefault,minval:model.reportMinimum,maxval:86400});
}
