// Calibration and double-precision compensation from klippy/extras/bme280.py.
// Copyright (C) 2020 Eric Callahan; GPL-3.0-or-later.
export interface Bme280Calibration {
 readonly T1:number;readonly T2:number;readonly T3:number;
 readonly P1:number;readonly P2:number;readonly P3:number;readonly P4:number;readonly P5:number;readonly P6:number;readonly P7:number;readonly P8:number;readonly P9:number;
 readonly H1?:number;readonly H2?:number;readonly H3?:number;readonly H4?:number;readonly H5?:number;readonly H6?:number;
}
const signed=(value:number,bits:number)=>value>=2**(bits-1)?value-2**bits:value;
export class Bme280Compensation {
 readonly calibration:Readonly<Bme280Calibration>;readonly humidity:boolean;
 constructor(first:Uint8Array,second?:Uint8Array){
  if(!(first instanceof Uint8Array)||![24,26].includes(first.length)||second!==undefined&&(!(second instanceof Uint8Array)||![7,16].includes(second.length)||first.length!==26))throw new Error('Malformed BME280 calibration');
  if(first.every(b=>b===0)||first.every(b=>b===255))throw new Error('Empty BME280 calibration');
  const u=(i:number)=>first[i]+first[i+1]*256,s=(i:number)=>signed(u(i),16);
  const calibration={T1:u(0),T2:s(2),T3:s(4),P1:u(6),P2:s(8),P3:s(10),P4:s(12),P5:s(14),P6:s(16),P7:s(18),P8:s(20),P9:s(22),...second?{H1:first[25],H2:signed(second[0]+second[1]*256,16),H3:second[2],H4:signed(second[3]*16+(second[4]&15),12),H5:signed(second[5]*16+(second[4]>>>4),12),H6:signed(second[6],8)}:{}};
  if(calibration.P1===0)throw new Error('Invalid BME280 pressure calibration');
  this.calibration=Object.freeze(calibration);this.humidity=second!==undefined;Object.freeze(this);
 }
 decode(data:Uint8Array){
  if(!(data instanceof Uint8Array)||data.length!==(this.humidity?8:6))throw new Error('Malformed BME280 measurement');
  const rawPressure=data[0]*4096+data[1]*16+(data[2]>>>4),rawTemperature=data[3]*4096+data[4]*16+(data[5]>>>4),d=this.calibration;
  const t1=(rawTemperature/16384-d.T1/1024)*d.T2,t2=(rawTemperature/131072-d.T1/8192)*(rawTemperature/131072-d.T1/8192)*d.T3,tFine=t1+t2,temperature=tFine/5120;
  let v1=tFine/2-64000,v2=v1*v1*d.P6/32768;
  v2=v2+v1*d.P5*2;v2=v2/4+d.P4*65536;
  v1=(d.P3*v1*v1/524288+d.P2*v1)/524288;v1=(1+v1/32768)*d.P1;
  if(v1===0)throw new Error('Invalid BME280 pressure divisor');
  let pressure=1048576-rawPressure;pressure=((pressure-v2/4096)*6250)/v1;
  v1=d.P9*pressure*pressure/2147483648;v2=pressure*d.P8/32768;pressure=(pressure+(v1+v2+d.P7)/16)/100;
  if(!Number.isFinite(temperature)||!Number.isFinite(pressure))throw new Error('Non-finite BME280 compensation');
  if(!this.humidity)return {temperature,pressure};
  let humidity=tFine-76800;const h1=data[6]*256+data[7]-(d.H4!*64+d.H5!/16384*humidity),h2=d.H2!/65536*(1+d.H6!/67108864*humidity*(1+d.H3!/67108864*humidity));
  humidity=h1*h2;humidity=humidity*(1-d.H1!*humidity/524288);
  if(!Number.isFinite(humidity))throw new Error('Non-finite BME280 humidity');
  return {temperature,pressure,humidity:Math.min(100,Math.max(0,humidity))};
 }
}
