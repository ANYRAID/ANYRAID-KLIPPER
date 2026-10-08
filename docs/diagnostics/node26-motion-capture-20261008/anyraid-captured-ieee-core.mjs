import assert from "node:assert/strict";
const abs=n=>n<0n?-n:n, length=n=>n.toString(2).length;
function decode(bits){
 const exponent=Number(bits>>52n&2047n),fraction=bits&((1n<<52n)-1n);
 assert(exponent!==2047);
 return {m:(bits>>63n?-1n:1n)*(fraction+(exponent?1n<<52n:0n)),e:exponent?exponent-1075:-1074,bits};
}
const fromSaved=value=>{const b=Buffer.alloc(8);b.writeDoubleLE(value);return decode(b.readBigUInt64LE());};
const zero=decode(0n), hex=v=>'0x'+v.bits.toString(16).padStart(16,'0');
// Correct round-to-nearest, ties-to-even using integer quotient/remainder.
// This bounded scalar analysis rejects subnormal/overflow results rather than
// pretending to implement IEEE cases that the selected saved samples do not use.
function round(num,den=1n,exponent=0){
 assert(den>0n);if(num===0n)return zero;
 const sign=num<0n?1n:0n;num=abs(num);
 let power=length(num)-length(den);
 if(power>=0?num<(den<<BigInt(power)):(num<<BigInt(-power))<den)power--;
 power+=exponent;assert(power>=-1022&&power<=1023);
 const shift=exponent+52-power;
 const numerator=shift>=0?num<<BigInt(shift):num;
 const denominator=shift>=0?den:den<<BigInt(-shift);
 let mantissa=numerator/denominator;const remainder=numerator%denominator;
 if(2n*remainder>denominator||(2n*remainder===denominator&&(mantissa&1n)))mantissa++;
 if(mantissa===1n<<53n){mantissa>>=1n;power++;}
 assert(power<=1023&&mantissa>=1n<<52n&&mantissa<1n<<53n);
 return decode((sign<<63n)|(BigInt(power+1023)<<52n)|(mantissa-(1n<<52n)));
}
function add(a,b){if(!a.m)return b;if(!b.m)return a;const e=Math.min(a.e,b.e);return round((a.m<<BigInt(a.e-e))+(b.m<<BigInt(b.e-e)),1n,e);}
const negate=a=>({...a,m:-a.m,bits:a.bits^(1n<<63n)});
const sub=(a,b)=>add(a,negate(b));
const mul=(a,b)=>round(a.m*b.m,1n,a.e+b.e);
const magnitudeAtLeast=(a,b)=>{const e=Math.min(a.e,b.e);return (abs(a.m)<<BigInt(a.e-e))>=(abs(b.m)<<BigInt(b.e-e));};
const controls=[];
for(const [name,num,den,e,bits] of [
 ['one',1n,1n,0,0x3ff0000000000000n],
 ['third',1n,3n,0,0x3fd5555555555555n],
 ['negative third',-1n,3n,0,0xbfd5555555555555n],
 ['even tie down',(1n<<53n)+1n,1n,-53,0x3ff0000000000000n],
 ['odd tie up',(1n<<53n)+3n,1n,-53,0x3ff0000000000002n],
 ['carry tie',(1n<<54n)-1n,1n,-53,0x4000000000000000n],
 ]){assert.equal(round(num,den,e).bits,bits,name);controls.push(name);}
assert.equal(add(round(1n),round(1n,1n,-53)).bits,0x3ff0000000000000n);controls.push('rounded addition');
assert.equal(sub(round(1n),round(1n)).bits,0n);controls.push('cancellation');
assert.equal(mul(round(3n),round(1n,1n,-1)).bits,0x3ff8000000000000n);controls.push('rounded multiplication');

export {decode,fromSaved,zero,hex,round,add,sub,mul,magnitudeAtLeast,controls};
