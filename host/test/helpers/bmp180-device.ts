export const bmp180Calibration=(linear=false)=>{const bytes=Buffer.alloc(22);(linear?[0,0,0,32768,32768,0,0,0,-32768,0,1]:[408,-72,-14383,32741,32757,23153,6190,4,-32768,-8711,2868]).forEach((v,i)=>bytes.writeUInt16BE(v&65535,i*2));return bytes;};
export function bmp180Device(now=()=>performance.now(),linear=false){
 const state={rawTemperature:27898,rawPressure:23843,fault:false,stuck:false,ignoreWrites:false,reads:0,conversions:0,temperatureReads:0};let control=0,deadline=0;
 const exchange=(_oid:number,b:Uint8Array,n:number):{data:Uint8Array;status?:string}=>{
  if(state.fault)return {data:Buffer.alloc(n),status:'NACK'};
  if(b.length===2){if(b[0]===224){control=0;deadline=now()+500;return {data:Buffer.alloc(0)};}if(b[0]===244){if(!state.ignoreWrites)control=b[1];deadline=now()+(b[1]===46?4.5:[4.5,7.5,13.5,25.5][b[1]>>>6]);state.conversions++;return {data:Buffer.alloc(0)};}throw Error('Unexpected BMP180 write');}
  if(b[0]===208)return {data:Uint8Array.of(85)};
  if(b[0]===170){if(now()<deadline)throw Error('Premature BMP180 calibration');return {data:bmp180Calibration(linear)};}
  if(b[0]===244){if(!state.stuck&&now()>=deadline)control&=~32;return {data:Uint8Array.of(control)};}
  if(b[0]===246){if(state.stuck||now()<deadline||control&32)throw Error('Premature BMP180 measurement');state.reads++;if(n===2){state.temperatureReads++;return {data:Uint8Array.of(state.rawTemperature>>>8,state.rawTemperature&255)};}const raw=state.rawPressure*256;return {data:Uint8Array.of(raw>>>16,raw>>>8&255,raw&255)};}
  throw Error('Unexpected BMP180 read');
 };
 return {state,exchange};
}
