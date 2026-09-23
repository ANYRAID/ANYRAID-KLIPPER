import {ConfigurationReader} from '../../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../../src/moonraker/config-source.ts';
export const heaterReader=(values:Record<string,string>={})=>new ConfigurationReader(new ConfigurationSource('/heater.cfg',{extruder:{heater_pin:'PA2',sensor_pin:'PA0',sensor_type:'Generic 3950',min_temp:'0',max_temp:'300',control:'watermark',...values}},[]),null);
export const heaterClocks=()=>new Map([['mcu',{currentPrintTime:1,calibration:{offset:0,frequency:1e6}}],['aux',{currentPrintTime:3,calibration:{offset:2,frequency:1e6}}]]);
