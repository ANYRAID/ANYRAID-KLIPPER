// Python 3.12 JSON value repr for structured Motan CSV cells. Unicode 15.0
// printability is pinned to the same reference as the migrated diagnostics.
import {controlCodePoint} from '../diagnostics/whitespace.ts';
import {motanObjectKeys,motanNumberToken,motanTypedValue} from './number-types.ts';
export function motanFloatRepr(value:number):string{
 if(!Number.isFinite(value))throw new Error('Motan repr requires finite floats');
 if(value===0)return Object.is(value,-0)?'-0.0':'0.0';
 const sign=value<0?'-':'',[mantissa,power='0']=Math.abs(value).toString().split('e');
 let digits=mantissa.replace('.',''),exponent=Number(power)+(mantissa.includes('.')?mantissa.indexOf('.'):mantissa.length)-1;
 while(digits.startsWith('0')){digits=digits.slice(1);exponent--;}
 digits=digits.replace(/0+$/,'');
 if(exponent < -4||exponent>=16)return sign+digits[0]+(digits.length>1?'.'+digits.slice(1):'')+'e'+(exponent<0?'-':'+')+String(Math.abs(exponent)).padStart(2,'0');
 if(exponent<0)return sign+'0.'+'0'.repeat(-exponent-1)+digits;
 const point=exponent+1;return sign+(digits.length<=point?digits.padEnd(point,'0')+'.0':digits.slice(0,point)+'.'+digits.slice(point));
}
const integerLimit=10n**4300n;
const nonprintable=(point:number)=>controlCodePoint(point)||point===0xa0||point===0x1680||point>=0x2000&&point<=0x200a||point===0x2028||point===0x2029||point===0x202f||point===0x205f||point===0x3000;
/** Only typed JSON trees: no coercions, getters, custom classes or cycles.
 * Bounds apply before returning any text; callers budget the cell separately. */
export function motanPythonRepr(value:unknown,maxBytes=1024**2):string{
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>4*1024**2)throw new Error('Invalid Motan repr budget');
 const chunks:string[]=[],active=new Set<object>();let bytes=0,nodes=0;
 const append=(text:string)=>{bytes+=Buffer.byteLength(text);if(bytes>maxBytes)throw new Error('Motan repr output limit');chunks.push(text);};
 const string=(text:string)=>{
  if(text.length>maxBytes-bytes)throw new Error('Motan repr output limit');
  const quote=text.includes("'")&&!text.includes('"')?'"':"'";append(quote);let start=0,pos=0;
  for(const char of text){const point=char.codePointAt(0)!;let escape:string|undefined;
   if(char===quote||char==='\\')escape='\\'+char;
   else if(point===9)escape='\\t';else if(point===10)escape='\\n';else if(point===13)escape='\\r';
   else if(nonprintable(point))escape='\\'+(point<=255?'x':point<=65535?'u':'U')+point.toString(16).padStart(point<=255?2:point<=65535?4:8,'0');
   if(escape!==undefined){append(text.slice(start,pos));append(escape);start=pos+char.length;}pos+=char.length;
  }
  append(text.slice(start));append(quote);
 };
 const field=(container:Record<string,unknown>,key:string,depth:number)=>{
  const descriptor=Object.getOwnPropertyDescriptor(container,key);if(!descriptor||!('value' in descriptor))throw new Error('Motan repr requires JSON data properties');
  const value=descriptor.value;
  if(typeof value==='number'&&motanNumberToken(container,key,value)===undefined)throw new Error('Motan repr requires typed JSON numbers');
  visit(motanTypedValue(container,key),depth);
 };
 const visit=(current:unknown,depth:number):void=>{
  if(depth>64||++nodes>65536)throw new Error('Motan repr depth or node limit');
  if(current===null){append('None');return;}
  if(typeof current==='boolean'){append(current?'True':'False');return;}
  if(typeof current==='string'){string(current);return;}
  if(typeof current==='number'){append(motanFloatRepr(current));return;}
  if(typeof current==='bigint'){if(current<=-integerLimit||current>=integerLimit)throw new Error('Motan repr integer digit limit');append(String(current));return;}
  if(typeof current!=='object')throw new Error('Motan repr requires JSON values');
  if(active.has(current))throw new Error('Motan repr rejects cycles');active.add(current);
  try{
   const array=Array.isArray(current),prototype=Object.getPrototypeOf(current);
   if(!array&&prototype!==Object.prototype&&prototype!==null)throw new Error('Motan repr requires plain JSON objects');
   const keys=array?undefined:motanObjectKeys(current),length=array?current.length:keys!.length;
   if(length>65536-nodes)throw new Error('Motan repr node limit');append(array?'[':'{');
   for(let i=0;i<length;i++){if(i)append(', ');const key=array?String(i):keys![i];if(!array){string(key);append(': ');}field(current as Record<string,unknown>,key,depth+1);}
   append(array?']':'}');
  }finally{active.delete(current);}
 };
 visit(value,0);return chunks.join('');
}
