// Thermistor equations from klippy/extras/thermistor.py; GPL-3.0-or-later.
// Copyright (C) 2016-2019 Kevin O'Connor.
export type CalibrationPoint=readonly [temperature:number,resistance:number];
export type ThermistorModel={point:CalibrationPoint;beta:number}|{points:readonly [CalibrationPoint,CalibrationPoint,CalibrationPoint]};
const absoluteZero=-273.15;
function point(p:CalibrationPoint):void {if(p.length!==2||!p.every(Number.isFinite)||p[0]<=absoluteZero||p[1]<=0)throw new RangeError('Invalid thermistor calibration point');}
export class Thermistor {
 #pullup:number;#inline:number;#c1=0;#c2=0;#c3=0;#fallback=false;
 constructor(pullup:number,inline:number,model:ThermistorModel) {
  if(!Number.isFinite(pullup)||pullup<=0||!Number.isFinite(inline)||inline<0)throw new RangeError('Invalid thermistor resistors');this.#pullup=pullup;this.#inline=inline;
  if('beta' in model){point(model.point);this.#beta(model.point,model.beta);}
  else {
   if(model.points.length!==3)throw new RangeError('Three calibration points required');model.points.forEach(point);
   const [p1,p2,p3]=[...model.points].sort((a,b)=>a[0]-b[0]);
   if(p1[0]===p2[0]||p2[0]===p3[0])throw new RangeError('Duplicate calibration temperatures');
   const t1=1/(p1[0]-absoluteZero),t2=1/(p2[0]-absoluteZero),t3=1/(p3[0]-absoluteZero);
   const r1=Math.log(p1[1]),r2=Math.log(p2[1]),r3=Math.log(p3[1]),q1=r1**3,q2=r2**3,q3=r3**3;
   const t12=t1-t2,t13=t1-t3,r12=r1-r2,r13=r1-r3,q12=q1-q2,q13=q1-q3;
   this.#c3=(t12-t13*r12/r13)/(q12-q13*r12/r13);
   if(this.#c3<=0){this.#fallback=true;this.#beta(p1,r13/t13);}
   else {this.#c2=(t12-this.#c3*q12)/r12;this.#c1=t1-this.#c2*r1-this.#c3*q1;}
  }
  if(![this.#c1,this.#c2,this.#c3].every(Number.isFinite)||this.#c2<=0||this.#c3<0)throw new RangeError('Invalid thermistor coefficients');
 }
 #beta(p:CalibrationPoint,beta:number):void {
  if(!Number.isFinite(beta)||beta<=0)throw new RangeError('Invalid thermistor beta');this.#c3=0;this.#c2=1/beta;this.#c1=1/(p[0]-absoluteZero)-this.#c2*Math.log(p[1]);
 }
 get coefficients(){return {c1:this.#c1,c2:this.#c2,c3:this.#c3,betaFallback:this.#fallback};}
 temperature(adc:number):number {
  if(!Number.isFinite(adc)||adc<0||adc>1)throw new RangeError('Invalid thermistor ADC');
  adc=Math.max(.00001,Math.min(.99999,adc));const resistance=this.#pullup*adc/(1-adc)-this.#inline;
  if(resistance<=0||!Number.isFinite(resistance))throw new RangeError('Invalid thermistor resistance');
  const log=Math.log(resistance),inverse=this.#c1+this.#c2*log+this.#c3*log**3,temp=1/inverse+absoluteZero;
  if(inverse<=0||!Number.isFinite(temp))throw new RangeError('Invalid thermistor temperature');return temp;
 }
 adc(temp:number):number {
  if(!Number.isFinite(temp))throw new RangeError('Invalid thermistor temperature');if(temp<=absoluteZero)return 1;
  const inverse=1/(temp-absoluteZero);let log:number;
  if(this.#c3){const y=(this.#c1-inverse)/(2*this.#c3),x=Math.sqrt((this.#c2/(3*this.#c3))**3+y*y);log=Math.pow(x-y,1/3)-Math.pow(x+y,1/3);}
  else log=(inverse-this.#c1)/this.#c2;
  const resistance=Math.exp(log)+this.#inline,adc=resistance/(this.#pullup+resistance);
  if(!Number.isFinite(adc)||adc<0||adc>1)throw new RangeError('Thermistor inversion overflow');return adc;
 }
}
