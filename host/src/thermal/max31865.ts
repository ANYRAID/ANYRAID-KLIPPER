// MAX31865 Rev 3, page 10: IEC 751 platinum Callendar-Van Dusen model.
// https://www.analog.com/media/en/technical-documentation/data-sheets/max31865.pdf
const A=3.90830e-3,B=-5.77500e-7,C=-4.18301e-12;
function resistanceRatio(t:number){return 1+t*(A+t*(B+(t<0?C*(t-100)*t:0)));}
const lowerRatio=resistanceRatio(-200),upperRatio=resistanceRatio(850);
/** Numerical model domain is -200..850 C, not permission to operate a particular
 * probe at those temperatures. Reject unsupported readings instead of clamping.
 * D0 is the fault flag; the remaining 15 bits encode Rrtd/Rref *32768. */
export class Max31865 {
 readonly #scale:number;
 readonly minimumCode:number;
 readonly maximumCode:number;
 constructor(nominalResistance=100,referenceResistance=430){
  if(!Number.isFinite(nominalResistance)||nominalResistance<=0||!Number.isFinite(referenceResistance)||referenceResistance<=0)throw new RangeError('Invalid MAX31865 resistors');
  this.#scale=referenceResistance/nominalResistance/32768;
  if(!Number.isFinite(this.#scale)||this.#scale<=0)throw new RangeError('Unrepresentable MAX31865 resistance ratio');
  this.minimumCode=Math.max(0,Math.ceil(lowerRatio/this.#scale));this.maximumCode=Math.min(32767,Math.floor(upperRatio/this.#scale));
  if(this.minimumCode>this.maximumCode)throw new RangeError('MAX31865 has no representable temperature in the RTD model domain');
 }
 temperature(raw:number):number{
  if(!Number.isInteger(raw)||raw<0||raw>65535||(raw&1))throw new Error('MAX31865 invalid wire value or fault');
  const code=raw>>>1;if(code<this.minimumCode||code>this.maximumCode)throw new RangeError('MAX31865 reading outside RTD model domain');
  const ratio=code*this.#scale,delta=ratio-1;
  // Rationalized quadratic avoids subtracting almost equal values near 0 C.
  let t=2*delta/(A+Math.sqrt(A*A+4*B*delta));
  if(ratio>=1)return t;
  // Negative-temperature quartic is monotone on this domain. Starting from
  // the quadratic solution converges rapidly; bounded iteration and residual
  // verification prevent an unconverged result reaching thermal control.
  for(let i=0;i<8;i++){
   const residual=resistanceRatio(t)-ratio;
   if(Math.abs(residual)<=2e-15)return t;
   t-=residual/(A+2*B*t+C*t*t*(4*t-300));
  }
  throw new Error('MAX31865 negative temperature inversion did not converge');
 }
 range(minimum:number,maximum:number){
  if(!Number.isFinite(minimum)||!Number.isFinite(maximum)||minimum< -273.15||maximum<=minimum)throw new RangeError('Invalid MAX31865 temperature range');
  const low=Math.max(-200,minimum),high=Math.min(850,maximum);
  if(low>high)throw new RangeError('MAX31865 range outside RTD model domain');
  let first=Math.max(this.minimumCode,Math.floor(resistanceRatio(low)/this.#scale)),last=Math.min(this.maximumCode,Math.ceil(resistanceRatio(high)/this.#scale));
  // Resolve one-ULP rounding at exactly representable user boundaries against
  // the same decoder used by the host so MCU and host admission agree.
  while(first<=last&&this.temperature(first*2)<minimum)first++;
  while(last>=first&&this.temperature(last*2)>maximum)last--;
  if(first>last)throw new RangeError('MAX31865 range contains no representable temperature');
  return Object.freeze({minimum:first*2,maximum:last*2});
 }
}
