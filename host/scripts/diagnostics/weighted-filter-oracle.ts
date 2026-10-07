// Diagnostic-only exact arithmetic over saved binary64 operands. This does not
// replace filterMotion or certify the process which originally computed them.
const scale=1n<<1074n,fractionMask=(1n<<52n)-1n;
const orderedBits=(bits:bigint)=>bits>>63n?((1n<<64n)-1n)^bits:bits|(1n<<63n);
export function binary64Bits(value:number):bigint{const bytes=new DataView(new ArrayBuffer(8));bytes.setFloat64(0,value,true);return bytes.getBigUint64(0,true);}
function fromBits(value:bigint):number{const bytes=new DataView(new ArrayBuffer(8));bytes.setBigUint64(0,value,true);return bytes.getFloat64(0,true);}
/** Exact multiple of 2^-1074. Mathematical zero loses the sign of IEEE zero. */
export function binary64Integer(value:number):bigint{
 if(!Number.isFinite(value))throw new RangeError('Expected finite saved operand');
 const bits=binary64Bits(value),exponent=Number((bits>>52n)&2047n),fraction=bits&fractionMask;
 const magnitude=exponent?((1n<<52n)|fraction)<<BigInt(exponent-1):fraction;
 return bits>>63n?-magnitude:magnitude;
}
/** Round an exact rational to binary64 using quotient/remainder ties-to-even.
 * Exact zero yields +0; a negative nonzero underflow may yield -0. */
export function roundBinary64Rational(numerator:bigint,denominator:bigint):number{
 if(denominator<=0n)throw new RangeError('Expected positive denominator');
 const sign=numerator<0n?1n<<63n:0n;let n=numerator<0n?-numerator:numerator;
 if(!n)return 0;
 let exponent=n.toString(2).length-denominator.toString(2).length;
 if(exponent>=0?n<(denominator<<BigInt(exponent)):(n<<BigInt(-exponent))<denominator)exponent--;
 if(exponent>1023)throw new RangeError('Diagnostic result exceeds finite binary64');
 const subnormal=exponent< -1022,shift=subnormal?1074:52-exponent;
 const scaled=shift>=0?n<<BigInt(shift):n,d=shift>=0?denominator:denominator<<BigInt(-shift);
 let q=scaled/d;const remainder=scaled%d;
 if(2n*remainder>d||(2n*remainder===d&&(q&1n)))q++;
 if(subnormal)return fromBits(sign|q);
 if(q===(1n<<53n)){q>>=1n;exponent++;}
 if(exponent>1023)throw new RangeError('Diagnostic result rounds beyond finite binary64');
 return fromBits(sign|(BigInt(exponent+1023)<<52n)|(q-(1n<<52n)));
}
/** Original weighted4 half-open window. All positions come from the captured
 * invocation; no motion regeneration. Exact and stepwise models stay separate. */
export function inspectWeighted4Window(nominal:readonly number[],saved:number,index:number,n=83){
 if(!Array.isArray(nominal)||nominal.length>100000||!Number.isSafeInteger(n)||n<1||n>500||!Number.isSafeInteger(index)||index<500||index>=nominal.length-500||!Number.isFinite(saved))throw new RangeError('Invalid diagnostic window');
 let exact=0n,products=0n,high=0,low=0;
 const weight=15/(16*n**5),taps:{index:number;inputBits:string;kernelInteger:string;productBits:string}[]=[];
 for(let j=index-n;j<index+n;j++){
  const input=nominal[j],delta=j-index,kernel=BigInt((n*n-delta*delta)**2);
  const product=input*Number(kernel),next=high+product;
  exact+=binary64Integer(input)*kernel;products+=binary64Integer(product);
  low+=Math.abs(high)>=Math.abs(product)?(high-next)+product:(product-next)+high;high=next;
  taps.push({index:j,inputBits:binary64Bits(input).toString(16),kernelInteger:kernel.toString(),productBits:binary64Bits(product).toString(16)});
 }
 const ideal=roundBinary64Rational(exact*15n,scale*16n*BigInt(n)**5n);
 const roundedProductSum=roundBinary64Rational(products,scale);
 const stepwise=roundBinary64Rational(binary64Integer(roundedProductSum)*binary64Integer(weight),scale*scale),compensated=(high+low)*weight;
 return {index,halfWindow:n,saved,savedBits:binary64Bits(saved).toString(16),ideal,idealBits:binary64Bits(ideal).toString(16),stepwise,compensated,ulpDistanceFromIdeal:(orderedBits(binary64Bits(saved))-orderedBits(binary64Bits(ideal))).toString(),differenceFromIdeal:saved-ideal,differenceFromCompensated:saved-compensated,high,low,weight,taps};
}
