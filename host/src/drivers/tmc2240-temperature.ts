// TMC2240 ADC conversion from TMCErrorCheck.get_status (tmc.py).
// GPL-3.0-or-later. For 13-bit input the decimal result never lands on a
// half-cent tie; exhaustive reference testing preserves Python round(..., 2).
export function tmc2240Temperature(raw:number):number{
 if(!Number.isInteger(raw)||raw<0||raw>0x1fff)throw new RangeError('Invalid TMC2240 temperature ADC');
 return Math.round(((raw-2038)/7.7)*100)/100;
}
