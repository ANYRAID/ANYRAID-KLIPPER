// Analog Devices MAX31856 datasheet, registers 0Ch..0Eh (pages 24-25).
// https://www.analog.com/media/en/technical-documentation/data-sheets/max31856.pdf
/** Three wire bytes contain a signed 19-bit temperature in D23..5, in
 * 1/128 degrees C. D4..0 are unspecified (X), not fault or temperature bits.
 * Fault status is a separate register and must be checked by the transport. */
export function max31856Temperature(raw:number):number{
 if(!Number.isInteger(raw)||raw<0||raw>0xffffff)throw new Error('MAX31856 invalid wire value');
 return ((raw<<8)>>13)/128;
}
/** Bounds are unsigned 24-bit wire words, ordered as signed 24-bit values by
 * the MCU. Do not pass these bounds to the legacy unsigned firmware checker.
 * Quantize inward and include every unspecified low-bit pattern at the top. */
export function max31856Range(minimum:number,maximum:number){
 if(!Number.isFinite(minimum)||!Number.isFinite(maximum)||minimum< -273.15||maximum<=minimum||minimum>2047.9921875)throw new RangeError('Invalid MAX31856 temperature range');
 const low=Math.max(-34963,Math.ceil(minimum*128)),high=Math.min(262143,Math.floor(maximum*128));
 if(low>high)throw new RangeError('MAX31856 range contains no representable temperature');
 return {minimum:(low*32)&0xffffff,maximum:(high*32+31)&0xffffff,signed:low<0};
}
