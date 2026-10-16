// Exact integer boundary for trusted Moonraker component JSON. This does not
// extend the public RPC Json type or grant values entry into motion commands.
import {JsonNumberError} from './json.ts';
export type ExactJson=null|boolean|string|number|bigint|ExactJson[]|{[name:string]:ExactJson};
export interface ExactJsonOptions {integerDigits?:number;}
const needsSource=/(?:^|[\s,:\[])-?\d{16}|[eE][+-]?\d{3,}|(?:^|[\s,:\[])-0(?=[\s,}\]]|$)/;
const capacity=(options:ExactJsonOptions)=>{const digits=options.integerDigits??4096;if(!Number.isSafeInteger(digits)||digits<1)throw new JsonNumberError('Invalid JSON integer capacity');return digits;};
// A dispatch hint, not a second JSON grammar: native JSON.parse still validates
// the whole input. Escaped strings are skipped before inspecting number tokens.
function needsReviver(text:string,digits:number):boolean{
 for(let i=0;i<text.length;){const code=text.charCodeAt(i);
  if(code===34){let end=text.indexOf('"',i+1);for(;;){if(end<0)return true;let previous=end-1;while(text.charCodeAt(previous)===92)previous--;if((end-previous-1)%2===0)break;end=text.indexOf('"',end+1);}i=end+1;continue;}
  if(code===45||code>=48&&code<=57){const start=i;let integer=true;i++;
   for(;i<text.length;i++){const next=text.charCodeAt(i);if(next>=48&&next<=57||next===45||next===43)continue;if(next===46||next===69||next===101){integer=false;continue;}break;}
   const token=text.slice(start,i),value=Number(token);
   if(integer&&(token.length>digits+Number(token.startsWith('-'))||!Number.isSafeInteger(value)||token==='-0')||!integer&&!Number.isFinite(value))return true;
   continue;
  }i++;
 }return false;
}
/** Ordinary responses use native JSON.parse without a reviver. When needed,
 * Node 26's lexical context recovers integers before rounded values escape.
 * Decimal/exponent tokens keep binary64 semantics; integer -0 becomes 0. */
export function parseExactJson(text:string,options:ExactJsonOptions={}):ExactJson{
 const digits=capacity(options);
 if(digits>=16&&!needsSource.test(text)||!needsReviver(text,digits))return JSON.parse(text) as ExactJson;
 return JSON.parse(text,(_key:string,value:unknown,context?:{source?:string})=>{
  if(typeof value!=='number')return value;
  const token=context?.source;if(!token)throw new JsonNumberError('JSON numeric source is unavailable');
  if(/^-?\d+$/.test(token)){
   if(token.length>digits+Number(token.startsWith('-')))throw new JsonNumberError('JSON integer exceeds digit capacity');
   if(Number.isSafeInteger(value))return value===0?0:value;
   return BigInt(token);
  }
  if(!Number.isFinite(value))throw new JsonNumberError('JSON number exceeds finite floating-point range');
  return value;
 }) as ExactJson;
}
/** BigInt crosses this component wire as an integer token, never a string or
 * rounded Number. Large integral Numbers remain explicit floating-point tokens.
 * Plain ordinary trees retain native JSON.stringify's fast path. */
export function stringifyExactJson(value:ExactJson,options:ExactJsonOptions={}):string{
 const digits=capacity(options),ancestors=new Set<object>();let items=0,special=false;
 const visit=(item:unknown,depth:number):void=>{
  if(++items>100000||depth>64)throw new TypeError('JSON structure limit');
  if(item===null||typeof item==='boolean'||typeof item==='string')return;
  if(typeof item==='number'){if(!Number.isFinite(item))throw new JsonNumberError('JSON number exceeds finite floating-point range');if(Object.is(item,-0)||Number.isInteger(item)&&!Number.isSafeInteger(item))special=true;return;}
  if(typeof item==='bigint'){const token=item.toString();if(token.length>digits+Number(item<0n))throw new JsonNumberError('JSON integer exceeds digit capacity');special=true;return;}
  if(typeof item!=='object'||!item||!Array.isArray(item)&&![Object.prototype,null].includes(Object.getPrototypeOf(item)))throw new TypeError('Non-JSON value');
  if(ancestors.has(item))throw new TypeError('Cyclic JSON value');ancestors.add(item);for(const child of Object.values(item))visit(child,depth+1);ancestors.delete(item);
 };
 visit(value,0);if(!special)return JSON.stringify(value);
 const raw=(JSON as typeof JSON&{rawJSON(value:string):object}).rawJSON;
 return JSON.stringify(value,(_key,item:unknown)=>typeof item==='bigint'?raw(item.toString()):typeof item==='number'&&Object.is(item,-0)?raw('-0.0'):typeof item==='number'&&Number.isInteger(item)&&!Number.isSafeInteger(item)?raw(item.toExponential()):item);
}
