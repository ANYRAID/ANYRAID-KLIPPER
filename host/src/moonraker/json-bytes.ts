// Moonraker's pinned stdlib JSON fallback detects UTF-8/16/32 independently
// of HttpResponse.encoding. Preserve surrogate code units without replacement;
// the component's existing exact-number parser still owns JSON validation.
function utf8(bytes:Buffer):string{
 const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
 try{return decoder.decode(bytes);}catch(error){
  // CPython's surrogatepass accepts ED A0..BF 80..BF as a lone UTF-16 unit.
  // All other runs still pass the fatal decoder, including truncated/overlong
  // sequences and invalid bytes before or after a surrogate.
  const parts:string[]=[];let start=0;
  for(let i=bytes.indexOf(0xed);i>=0;i=bytes.indexOf(0xed,i+3)){
   if(i+2>=bytes.length||bytes[i+1]<0xa0||bytes[i+1]>0xbf||bytes[i+2]<0x80||bytes[i+2]>0xbf)continue;
   parts.push(decoder.decode(bytes.subarray(start,i)),String.fromCharCode((bytes[i]&15)<<12|(bytes[i+1]&63)<<6|bytes[i+2]&63));start=i+3;
  }
  if(start===0)throw error;
  parts.push(decoder.decode(bytes.subarray(start)));return parts.join('');
 }
}
function utf16(bytes:Buffer,littleEndian:boolean):string{
 if(bytes.length%2)throw new TypeError('Truncated UTF-16 JSON response');
 return (littleEndian?bytes:Buffer.from(bytes).swap16()).toString('utf16le');
}
function utf32(bytes:Buffer,littleEndian:boolean):string{
 if(bytes.length%4)throw new TypeError('Truncated UTF-32 JSON response');
 const parts:string[]=[];let points:number[]=[];
 for(let offset=0;offset<bytes.length;offset+=4){
  const point=littleEndian?bytes.readUInt32LE(offset):bytes.readUInt32BE(offset);
  if(point>0x10ffff)throw new TypeError('Invalid UTF-32 JSON code point');
  points.push(point);
  if(points.length===4096){parts.push(String.fromCodePoint(...points));points=[];}
 }
 if(points.length)parts.push(String.fromCodePoint(...points));return parts.join('');
}
/** Decode exactly one leading BOM or infer byte order from the JSON prefix.
 * UTF-32 BOM detection must precede UTF-16 (FF FE is shared). No charset header,
 * content mutation, numeric conversion or public RPC/motion extension. */
export function decodeJsonBytes(bytes:Buffer):string{
 if(bytes.length>=4){
  if(bytes[0]===0&&bytes[1]===0&&bytes[2]===0xfe&&bytes[3]===0xff)return utf32(bytes.subarray(4),false);
  if(bytes[0]===0xff&&bytes[1]===0xfe&&bytes[2]===0&&bytes[3]===0)return utf32(bytes.subarray(4),true);
 }
 if(bytes.length>=2){
  if(bytes[0]===0xfe&&bytes[1]===0xff)return utf16(bytes.subarray(2),false);
  if(bytes[0]===0xff&&bytes[1]===0xfe)return utf16(bytes.subarray(2),true);
 }
 if(bytes.length>=3&&bytes[0]===0xef&&bytes[1]===0xbb&&bytes[2]===0xbf)return utf8(bytes.subarray(3));
 if(bytes.length>=4){
  if(bytes[0]===0)return bytes[1]===0?utf32(bytes,false):utf16(bytes,false);
  if(bytes[1]===0)return bytes[2]===0&&bytes[3]===0?utf32(bytes,true):utf16(bytes,true);
 }else if(bytes.length===2){
  if(bytes[0]===0)return utf16(bytes,false);
  if(bytes[1]===0)return utf16(bytes,true);
 }
 return utf8(bytes);
}
