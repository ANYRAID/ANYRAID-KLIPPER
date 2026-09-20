import unicode from '../../contracts/unicode-numeric-space-15.json' with {type:'json'};
import {metadataPattern} from './slicer-identification.ts';
const cache=new Map<string,RegExp>();
export function metadataRegex(pattern:string,global=false):RegExp{
 const key=String(global)+pattern;let regex=cache.get(key);
 if(!regex){regex=metadataPattern(pattern.replaceAll('(%F)','([0-9]*\\.?[0-9]+)').replaceAll('(%D)','([0-9]+)').replaceAll('(%S)','(.*)'),global?'g':'');cache.set(key,regex);}
 regex.lastIndex=0;return regex;
}
export function metadataNumber(value:string):number{const normalized=/^[\x00-\x7f]*$/.test(value)?value:Array.from(value,char=>{const cp=char.codePointAt(0)!,range=unicode.decimal.find(([a,b])=>cp>=a&&cp<=b);return range?String((cp-range[0])%10):char;}).join('');const number=Number(normalized);if(!Number.isFinite(number))throw new RangeError('Nonfinite metadata number');return number;}
export function findFloat(pattern:string,data:string):number|undefined{const match=metadataRegex(pattern).exec(data);return match?metadataNumber(match[1]):undefined;}
export function findFloats(pattern:string,data:string):number[]{return Array.from(data.matchAll(metadataRegex(pattern,true)),m=>metadataNumber(m[1]));}
export function findString(pattern:string,data:string):string|undefined{const match=metadataRegex(pattern).exec(data);return match?.[1].replace(/^"+|"+$/g,'');}
const spaces=new Set(unicode.space.flatMap(([a,b])=>Array.from({length:b-a+1},(_,i)=>a+i)));
export function pythonStrip(value:string):string{let a=0,b=value.length;while(a<b&&spaces.has(value.charCodeAt(a)))a++;while(b>a&&spaces.has(value.charCodeAt(b-1)))b--;return value.slice(a,b);}
export function findStrings(pattern:string,data:string):string[]{
 const match=metadataRegex(pattern).exec(data);if(!match?.[1])return [];
 const result:string[]=[];for(const token of match[1].matchAll(metadataRegex(String.raw`\s*(")(?:\\"|[^"])*"\s*|[^,;]+`,true))){let value=pythonStrip(token[0]);if(token[1])value=pythonStrip(value.slice(1,-1).replaceAll('\\"','"'));if(value)result.push(value);}return result;
}
const integerPattern=metadataPattern(String.raw`^[+-]?\d(?:_?\d)*$`);
/** Python int decimal syntax; reject precision loss instead of silently rounding JSON integers. */
export function metadataInteger(value:string):number|undefined{
 value=pythonStrip(value);if(!integerPattern.test(value))return undefined;
 let ascii='';for(const char of value){const cp=char.codePointAt(0)!;if(char==='_')continue;const range=unicode.decimal.find(([a,b])=>cp>=a&&cp<=b);ascii+=range?String((cp-range[0])%10):char;}
 const number=Number(ascii);if(!Number.isSafeInteger(number))throw new RangeError('Unsafe metadata integer');return number===0?0:number;
}
export function findInteger(pattern:string,data:string):number|undefined{const match=metadataRegex(pattern).exec(data);return match?metadataInteger(match[1]):undefined;}
export function pythonJsonStrings(values:string[]):string{return '['+values.map(value=>JSON.stringify(value).replace(/[\x7f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'))).join(', ')+']';}
/** CPython 3.12 finite-float sum uses Neumaier compensation. */
export function metadataSum(values:number[]):number{let high=0,low=0;for(const value of values){const next=high+value;low+=Math.abs(high)>=Math.abs(value)?(high-next)+value:(value-next)+high;high=next;}const result=high+low;if(!Number.isFinite(result))throw new RangeError('Nonfinite metadata sum');return result;}
/** Round the exact IEEE-754 value to six decimal places, ties to even. */
export function roundMetadataHeight(value:number):number{
 if(!Number.isFinite(value))throw new RangeError('Nonfinite metadata height');
 const buffer=new ArrayBuffer(8),view=new DataView(buffer);view.setFloat64(0,value);const bits=view.getBigUint64(0),exponent=Number((bits>>52n)&2047n),negative=(bits>>63n)!==0n;
 let numerator=(bits&((1n<<52n)-1n))+(exponent?1n<<52n:0n),denominator=1n;const power=exponent?exponent-1075:-1074;
 if(power>=0)numerator<<=BigInt(power);else denominator<<=BigInt(-power);numerator*=1000000n;
 let quotient=numerator/denominator;const remainder=numerator%denominator;if(remainder*2n>denominator||(remainder*2n===denominator&&(quotient&1n)!==0n))quotient++;
 return Number(`${negative?'-':''}${quotient}e-6`);
}
