import type {ConfigurationReader} from '../moonraker/config-reader.ts';
export interface SensorlessEndstop {readonly section:string;readonly diag:0|1|undefined;}
/** Resolve only virtual TMC endstops; GPIO polarity belongs to the physical DIAG
 * option. This function does not claim a pin or permit motion. */
export function readHomingPin(reader:ConfigurationReader,section:string):{description:string;sensorless?:SensorlessEndstop}{
 const description=reader.section(section).get(section==='probe'?'pin':section==='bltouch'?'sensor_pin':'endstop_pin');
 if(/^[!^~]*probe:/.test(description)){if(section!=='stepper_z'||description!=='probe:z_virtual_endstop'||!reader.hasSection('probe'))throw new Error('Probe virtual endstop requires stepper_z and an unmodified probe:z_virtual_endstop pin');return {description:reader.section('probe').get('pin')};}
 if(!/^[!^~]*tmc\d+_/.test(description))return {description};
 const match=/^(tmc2209|tmc2130|tmc5160|tmc2240)_(\w+):virtual_endstop$/.exec(description);
 if(!match||section==='probe'||section==='bltouch')throw new Error('Invalid sensorless virtual endstop');
 const name=match[1]+' '+match[2];if(!reader.hasSection(name)||!reader.hasSection(match[2]))throw new Error('Missing sensorless driver or stepper');
 const driver=reader.section(name),diag=match[1]==='tmc2209'?undefined:driver.hasOption('diag0_pin')?0:1;
 const pin=driver.get(diag===undefined?'diag_pin':`diag${diag}_pin`);
 if(!pin||/^[!^~]*tmc\d+_/.test(pin))throw new Error('Sensorless DIAG requires a physical pin');
 return {description:pin,sensorless:Object.freeze({section:name,diag})};
}
