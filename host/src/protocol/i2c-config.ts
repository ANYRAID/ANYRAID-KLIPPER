import type {MessageDictionary} from './dictionary.ts';
import type {PinBinding} from './pins.ts';
export const i2cFormats={config:'config_i2c oid=%c',bus:'i2c_set_bus oid=%c i2c_bus=%u rate=%u address=%u',software:'i2c_set_sw_bus oid=%c scl_pin=%u sda_pin=%u pulse_ticks=%u address=%u',transfer:'i2c_transfer oid=%c write=%*s read_len=%u',response:'i2c_response oid=%c i2c_bus_status=%c response=%*s'} as const;
function validate(d:MessageDictionary,oid:number,address:number,rate:number){
 if(!Number.isInteger(oid)||oid<0||oid>254||!Number.isInteger(address)||address<0||address>127||!Number.isInteger(rate)||rate<100000||rate>0xffffffff)throw new RangeError('Invalid I2C configuration');
 for(const key of ['config','transfer','response'] as const)d.lookup(i2cFormats[key]);
}
/** Caller owns bus pin reservations and device address uniqueness. */
export function compileI2c(d:MessageDictionary,oid:number,address:number,bus:string,rate=100000){
 validate(d,oid,address,rate);if(!bus||/[\s=]/u.test(bus))throw new Error('Explicit I2C bus required');d.lookup(i2cFormats.bus);
 const config=`config_i2c oid=${oid}`,configureBus=`i2c_set_bus oid=${oid} i2c_bus=${bus} rate=${rate} address=${address}`;d.encodeCommand(config);d.encodeCommand(configureBus);
 return Object.freeze({oid,address,rate,config,configureBus});
}
export function compileSoftwareI2c<T>(chip:T,d:MessageDictionary,oid:number,address:number,scl:PinBinding<T>,sda:PinBinding<T>,rate=100000){
 validate(d,oid,address,rate);d.lookup(i2cFormats.software);
 if([scl,sda].some(p=>p.chip!==chip||!p.pin||/[\s^~!:]/u.test(p.pin)||p.invert!==0||p.pullup!==0))throw new Error('Invalid software I2C pins');
 const pins=d.pinEnumeration;if(pins[scl.pin]===undefined||pins[sda.pin]===undefined||pins[scl.pin]===pins[sda.pin])throw new Error('Invalid software I2C pin identity');
 const frequency=Number(d.constant('CLOCK_FREQ')),pulseTicks=Math.trunc(frequency/rate/2);
 if(!Number.isFinite(frequency)||frequency<=0||frequency>1e9||pulseTicks<1||pulseTicks>0xffffffff)throw new RangeError('Unrepresentable software I2C clock');
 const config=`config_i2c oid=${oid}`,configureBus=`i2c_set_sw_bus oid=${oid} scl_pin=${scl.pin} sda_pin=${sda.pin} pulse_ticks=${pulseTicks} address=${address}`;d.encodeCommand(config);d.encodeCommand(configureBus);
 return Object.freeze({oid,address,rate,config,configureBus});
}
