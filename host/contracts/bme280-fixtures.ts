// Deterministic calibration/raw vectors; expected values come from the original
// Python module, not from the TypeScript compensation implementation.
export function bme280Fixtures(){
 return Array.from({length:32},(_,c)=>{
  const first=Buffer.alloc(26);[27504,26435,-1000,36477,-10685,3024,2855,140,-7,15500,-14600,6000].forEach((v,i)=>first.writeUInt16LE((v+(c-16)*(i*7+1))&65535,i*2));first[25]=60+c;
  const second=Buffer.alloc(7),h4=(c%2?-c*8:325+c)&4095,h5=(-50+c*4)&4095;second.writeInt16LE(300+c*3);second[2]=c;second[3]=h4>>>4;second[4]=(h4&15)|((h5&15)<<4);second[5]=h5>>>4;second.writeInt8(c-16,6);
  const frames=Array.from({length:64},(_,i)=>{const t=i===0?0:i===1?1048575:(c*7919+i*15401)&1048575,p=i===0?0:i===1?1048575:(c*7919+i*31013)&1048575,h=i===0?0:i===1?65535:(c*1093+i*5077)&65535;return Uint8Array.of(p>>>12,p>>>4&255,(p&15)<<4,t>>>12,t>>>4&255,(t&15)<<4,h>>>8,h&255).subarray(0,c%2?6:8);});
  return {first,second:c%2?undefined:second,frames};
 });
}
