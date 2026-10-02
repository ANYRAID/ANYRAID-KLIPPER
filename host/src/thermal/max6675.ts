// MAX6675 wire format: Analog Devices data sheet Rev. 3, serial interface.
// MCU protocol derived from klippy/extras/spi_temperature.py, GPL-3.0-or-later.
export const thermocoupleFormats={config:'config_thermocouple oid=%c spi_oid=%c thermocouple_type=%c',query:'query_thermocouple oid=%c clock=%u rest_ticks=%u min_value=%u max_value=%u max_invalid_count=%c',response:'thermocouple_result oid=%c next_clock=%u value=%u fault=%c'} as const;
export function max6675Temperature(raw:number):number{
 if(!Number.isInteger(raw)||raw<0||raw>65535||(raw&0x8006))throw new Error('MAX6675 invalid frame or thermocouple fault');
 return (raw>>>3)*.25;
}
/** Firmware compares the complete unsigned wire word, including status bits.
 * D0 is tri-state, not temperature. Include it at the upper boundary. */
export function max6675Range(minimum:number,maximum:number){
 if(!Number.isFinite(minimum)||!Number.isFinite(maximum)||minimum<-273.15||maximum<=minimum||minimum>1023.75||maximum<0)throw new RangeError('Invalid MAX6675 temperature range');
 const low=Math.max(0,Math.ceil(minimum*4)),high=Math.min(4095,Math.floor(maximum*4));
 if(low>high)throw new RangeError('MAX6675 range contains no representable temperature');
 return {minimum:low*8,maximum:high*8+1};
}
