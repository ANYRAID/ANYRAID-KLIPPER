// MAX31855 data sheet, Analog Devices, digital output tables 2 and 3.
// https://www.analog.com/media/en/technical-documentation/data-sheets/max31855.pdf
/** D31..18 are a signed 14-bit thermocouple value in quarter degrees.
 * D15..4 are independent signed cold-junction data, never part of the value. */
export function max31855Temperature(raw:number):number{
 if(!Number.isInteger(raw)||raw<0||raw>0xffffffff||(raw&0x3000f))throw new Error('MAX31855 invalid frame or thermocouple fault');
 return (raw>>18)*.25;
}
/** Unsigned transport encodes signed 32-bit comparison bounds. The MCU must
 * advertise signed MAX31855 range support before using a negative minimum.
 * Include all cold-junction bits at the upper boundary, independently of its
 * sign. Fault/reserved bits are separately rejected by the decoder. */
export function max31855Range(minimum:number,maximum:number){
 if(!Number.isFinite(minimum)||!Number.isFinite(maximum)||minimum<-273.15||maximum<=minimum||minimum>2047.75||maximum< -273)throw new RangeError('Invalid MAX31855 temperature range');
 const low=Math.max(-1092,Math.ceil(minimum*4)),high=Math.min(8191,Math.floor(maximum*4));
 if(low>high)throw new RangeError('MAX31855 range contains no representable temperature');
 return {minimum:(low*262144)>>>0,maximum:(high*262144+262143)>>>0,signed:low<0};
}
