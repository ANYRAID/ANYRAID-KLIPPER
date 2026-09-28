// Register-level simulator with independent oversampling lookup and busy state.
export function bme280Device(humidity=true,now=()=>performance.now()){
 const first=Buffer.alloc(26),second=Buffer.alloc(7);first.writeInt16LE(16384,2);first.writeUInt16LE(32768,6);second.writeInt16LE(100);
 const registers=new Map<number,number>(),ready=new Map<number,number>();
 const state={temperature:25,fault:false,stuck:false,ignoreWrites:false,reads:0,conversions:0,configurationReads:0};
 const exchange=(_oid:number,b:Uint8Array,n:number):{data:Uint8Array;status?:string}=>{
  if(state.fault)return {data:Buffer.alloc(n),status:'NACK'};
  const register=b[0];
  if(b.length===2){if(!state.ignoreWrites)registers.set(register,b[1]);if(register===224){registers.clear();ready.clear();}if(register===244&&(b[1]&3)){const values=[0,1,2,4,8,16],t=values[b[1]>>>5],p=values[(b[1]>>>2)&7],h=humidity?values[registers.get(242)??0]:0;ready.set(244,now()+(1.25+2.3*t+(p?2.3*p+.575:0)+(h?2.3*h+.575:0)));state.conversions++;}return {data:Buffer.alloc(0)};}
  if(register===208)return {data:Uint8Array.of(humidity?96:88)};
  if(register===243){state.configurationReads++;return {data:Uint8Array.of(state.stuck?9:now()<(ready.get(244)??0)?8:0)};}
  if(register===136)return {data:first.subarray(0,n)};
  if(register===225){if(!humidity)throw Error('BMP280 has no humidity calibration');return {data:second};}
  if(register===247){if(now()<(ready.get(244)??0))throw Error('Premature BME data read');state.reads++;const t=Math.round(state.temperature*5120);return {data:Uint8Array.of(128,0,0,t>>>12,t>>>4&255,(t&15)<<4,128,0).subarray(0,n)};}
  if(register===244&&now()>=(ready.get(244)??0))registers.set(244,(registers.get(244)??0)&252);
  return {data:Uint8Array.of(registers.get(register)??0)};
 };
 return {state,exchange};
}
