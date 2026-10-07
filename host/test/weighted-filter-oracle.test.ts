import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {deserialize} from 'node:v8';import {gunzipSync} from 'node:zlib';
import {binary64Bits,binary64Integer,roundBinary64Rational,inspectWeighted4Window} from '../scripts/diagnostics/weighted-filter-oracle.ts';
const scale=1n<<1074n;
test('exact dyadic round trips include normal extremes and subnormals',()=>{
 for(const value of [0,1,-1,2**-1022,-(2**-1022),Number.MIN_VALUE,-Number.MIN_VALUE,Number.MAX_VALUE,-Number.MAX_VALUE,26.28547759748226,119.86758495826422])assert(Object.is(roundBinary64Rational(binary64Integer(value),scale),value));
 assert.equal(binary64Integer(-0),0n);assert(Object.is(roundBinary64Rational(0n,1n),0));
});
test('ties to even and signed underflow are decided by integer remainders',()=>{
 assert.equal(roundBinary64Rational((1n<<53n)+1n,1n<<53n),1);
 assert.equal(roundBinary64Rational((1n<<53n)+3n,1n<<53n),1+2**-51);
 assert.equal(roundBinary64Rational(-((1n<<53n)+3n),1n<<53n),-(1+2**-51));
 assert.equal(roundBinary64Rational(1n,1n<<1075n),0);assert(Object.is(roundBinary64Rational(-1n,1n<<1075n),-0));
 assert.equal(roundBinary64Rational(3n,1n<<1075n),2*Number.MIN_VALUE);
 assert.equal(roundBinary64Rational((1n<<53n)-1n,1n<<1075n),2**-1022);
});
test('invalid or overflowing diagnostic operands are rejected',()=>{
 for(const v of [NaN,Infinity,-Infinity])assert.throws(()=>binary64Integer(v),RangeError);
 assert.throws(()=>roundBinary64Rational(1n,0n),RangeError);assert.throws(()=>roundBinary64Rational(1n,-1n),RangeError);
 assert.throws(()=>roundBinary64Rational(1n<<1024n,1n),RangeError);
 assert.throws(()=>roundBinary64Rational((1n<<1024n)-(1n<<970n),1n),RangeError);
 assert.throws(()=>inspectWeighted4Window(Array(2000).fill(1),1,500,501),RangeError);
 assert.throws(()=>inspectWeighted4Window(Array(2000).fill(1),1,499),RangeError);
 const nonfinite=Array(2000).fill(1);nonfinite[500]=NaN;assert.throws(()=>inspectWeighted4Window(nonfinite,1,500),RangeError);
});
test('same-invocation archival operands distinguish saved filter corruption from rounding',()=>{
 const c=deserialize(gunzipSync(readFileSync(new URL('../../docs/diagnostics/node26-motion-capture-20260928/motion-mismatch-351330-12.bin.gz',import.meta.url))));
 const observed=[4896,4897,4898].map(i=>inspectWeighted4Window(c.stages.nominal,c.stages.updated[i],i));
 assert.deepEqual(observed.map(i=>i.ulpDistanceFromIdeal),['0','220614','-1']);
 for(const o of observed){assert.equal(o.taps.length,166);assert.equal(o.taps[0].kernelInteger,'0');assert.equal(o.compensated,o.stepwise);}
 assert.equal(observed[0].saved,observed[0].stepwise);assert.equal(observed[2].saved,observed[2].stepwise);assert.notEqual(observed[1].saved,observed[1].stepwise);
 const corrected=inspectWeighted4Window(c.stages.nominal,observed[1].stepwise,4897);assert.equal(corrected.ulpDistanceFromIdeal,'-1');
 assert.equal(binary64Bits(corrected.saved),binary64Bits(26.28547759748226));
});

test('ULP distance follows numeric order for negative outputs',()=>{
 const input=Array(2000).fill(-1),ideal=inspectWeighted4Window(input,-1,500).ideal;const bytes=new DataView(new ArrayBuffer(8));bytes.setBigUint64(0,binary64Bits(ideal)+1n,true);const lower=bytes.getFloat64(0,true);assert(lower<ideal);assert.equal(inspectWeighted4Window(input,lower,500).ulpDistanceFromIdeal,'-1');
});
