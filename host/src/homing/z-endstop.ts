/** Configured frame offset minus the motor-resolved nozzle contact height.
 * Keep binary64 precision through persistence instead of display rounding. */
export function calibrateZEndstop(current:number,contact:number,minimum:number,maximum:number):number{
 if(![current,contact,minimum,maximum].every(Number.isFinite)||minimum>=maximum||current<minimum||current>maximum||contact<minimum||contact>maximum)throw new RangeError('Invalid Z endstop calibration inputs');
 const value=current-contact;
 if(!Number.isFinite(value)||value<minimum||value>maximum)throw new RangeError('Calibrated Z endstop outside machine limits');
 return value;
}
