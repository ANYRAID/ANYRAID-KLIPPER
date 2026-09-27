import type {KExpression} from './expression.ts';

export type KTristate = 0 | 1 | 2;
export type KValueType = 'unknown' | 'bool' | 'tristate' | 'string' | 'int' | 'hex';
/** Resolved symbol value. Dependency/default/choice resolution belongs to the model. */
export interface KValue {type:KValueType; text:string; tri:KTristate;}
export type KLookup = (name:string)=>KValue | undefined;

const constants:Readonly<Record<string,KTristate>>=Object.freeze({n:0,m:1,y:2});
export function kconfigAtom(expression:KExpression,lookup:KLookup):KValue {
 if(expression.kind!=='symbol'&&expression.kind!=='literal')throw new Error('Kconfig relation requires atomic operands');
 const text=expression.value;
 if(Object.hasOwn(constants,text))return {type:'tristate',text,tri:constants[text]};
 return (expression.kind==='symbol'?lookup(text):undefined)??{type:'unknown',text,tri:0};
}

/** Python int semantics used by Kconfiglib comparisons, with exact integers. */
export function kconfigInteger(text:string,base:0|10|16):bigint | undefined {
 // Python accepts Unicode decimal digits, including in explicit-base numbers.
 const decimal=(char:string)=>{
  if(!/\p{Decimal_Number}/u.test(char))return char;
  const code=char.codePointAt(0)!;let start=code;
  while(start>0&&/\p{Decimal_Number}/u.test(String.fromCodePoint(start-1)))start--;
  return String((code-start)%10);
 };
 // Unicode White_Space matches int() here; JS trim additionally strips BOM.
 let value=Array.from(text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu,''),decimal).join('');
 let sign=1n;
 if(value[0]==='-'||value[0]==='+'){if(value[0]==='-')sign=-1n;value=value.slice(1);}
 let radix:number=base;
 const prefix=/^0([xob])/i.exec(value);
 if(prefix){
  const detected={x:16,o:8,b:2}[prefix[1].toLowerCase() as 'x'|'o'|'b'];
  if(base===0||base===detected){radix=detected;value=value.slice(2);if(value.startsWith('_'))value=value.slice(1);}
 }
 if(radix===0)radix=10;
 const digit=radix===16?'[0-9a-fA-F]':radix===8?'[0-7]':radix===2?'[01]':'[0-9]';
 if(!new RegExp('^'+digit+'(?:_?'+digit+')*$').test(value))return undefined;
 value=value.replaceAll('_','');
 // int(s, 0) rejects nonzero decimal values with leading zeroes.
 if(base===0&&!prefix&&value.length>1&&value[0]==='0'&&/[1-9]/.test(value))return undefined;
 return sign*BigInt((radix===16?'0x':radix===8?'0o':radix===2?'0b':'')+value);
}

function compareText(a:string,b:string):number {
 // Python compares Unicode code points, not JavaScript UTF-16 code units.
 const left=Array.from(a),right=Array.from(b);
 for(let i=0;i<Math.min(left.length,right.length);i++){
  const difference=left[i].codePointAt(0)!-right[i].codePointAt(0)!;
  if(difference)return difference;
 }
 return left.length-right.length;
}
function numeric(value:KValue):bigint | undefined {
 return value.type==='bool'||value.type==='tristate'?BigInt(value.tri):kconfigInteger(value.text,value.type==='int'?10:value.type==='hex'?16:0);
}
function compare(left:KValue,right:KValue):number {
 if(left.type!=='string'||right.type!=='string'){
  const a=numeric(left),b=numeric(right);
  if(a!==undefined&&b!==undefined)return a<b?-1:a>b?1:0;
 }
 return compareText(left.text,right.text);
}

/** Kconfiglib expr_value semantics. Strings and integers alone are false. */
export function evaluateKconfig(expression:KExpression,lookup:KLookup):KTristate {
 if(expression.kind==='symbol'||expression.kind==='literal')return kconfigAtom(expression,lookup).tri;
 if(expression.kind==='not')return (2-evaluateKconfig(expression.value,lookup)) as KTristate;
 if(expression.kind!=='binary')throw new Error('Invalid Kconfig expression');
 const {operator,left,right}=expression;
 if(operator==='&&'){
  const a=evaluateKconfig(left,lookup);
  return a===0?0:Math.min(a,evaluateKconfig(right,lookup)) as KTristate;
 }
 if(operator==='||'){
  const a=evaluateKconfig(left,lookup);
  return a===2?2:Math.max(a,evaluateKconfig(right,lookup)) as KTristate;
 }
 const difference=compare(kconfigAtom(left,lookup),kconfigAtom(right,lookup));
 switch(operator){
  case '=':return difference===0?2:0;
  case '!=':return difference!==0?2:0;
  case '<':return difference<0?2:0;
  case '<=':return difference<=0?2:0;
  case '>':return difference>0?2:0;
  case '>=':return difference>=0?2:0;
  default:throw new Error('Invalid Kconfig relation '+operator);
 }
}
