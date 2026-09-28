export function bmp180Fixtures(){
 let seed=123456789;const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
 return Array.from({length:32},(_,i)=>{
  const base=[408,-72,-14383,32741,32757,23153,6190,4,-32768,-8711,2868],bytes=Buffer.alloc(22);
  base.forEach((v,j)=>bytes.writeUInt16BE((v+(i?next()%161-80:0))&65535,j*2));
  const samples=Array.from({length:256},(_,j)=>{const oss=j%4;return {t:j<8?(j<4?0:65535):18000+next()%24000,p:j<8?(j<4?0:2**(16+oss)-1):(15000+next()%30000)*2**oss+(next()%2**oss),oss};});
  return {bytes,samples};
 });
}
