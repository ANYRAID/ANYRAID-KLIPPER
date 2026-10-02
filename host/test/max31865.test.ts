import test from 'node:test';
import assert from 'node:assert/strict';
import {Max31865} from '../src/thermal/max31865.ts';

// Independent fixed-point oracle: decimal coefficients are exact integers,
// 30 decimal digits and interval bisection; no binary sqrt/Newton from product.
const scale=10n**30n;
function oracle(code:number,nominal:number,reference:number){
 const target=BigInt(code)*BigInt(reference)*scale/(32768n*BigInt(nominal));
 const ratio=(t:bigint)=>scale+390830n*t/100000000n-5775n*t*t/(10000000000n*scale)+(t<0n?-418301n*(t-100n*scale)*t*t*t/(100000000000000000n*scale**3n):0n);
 let lo=-200n*scale,hi=850n*scale;
 for(let i=0;i<115;i++){const mid=(lo+hi)/2n;if(ratio(mid)<target)lo=mid;else hi=mid;}
 return Number(lo+hi)/2/Number(scale);
}
for(const [nominal,reference] of [[100,400],[100,430],[1000,4300],[100,1000]])test(`MAX31865 ${nominal}/${reference} exhaustive ADC monotonicity and independent precision`,()=>{
 const model=new Max31865(nominal,reference);let previous=-Infinity,worst=0;
 for(let code=0;code<32768;code++){
  if(code<model.minimumCode||code>model.maximumCode){assert.throws(()=>model.temperature(code*2),/domain/);continue;}
  const value=model.temperature(code*2);assert(value>=-200&&value<=850);assert(value>previous);previous=value;
  if(value>=0){const r=code*reference/(32768*nominal),legacy=(-.0039083+Math.sqrt(.0039083**2-4*(-.0000005775)*(1-r)))/(2*(-.0000005775));assert(Math.abs(value-legacy)<2e-10);}
  // Every valid code receives an independently evaluated forward residual.
  const predicted=1+0.0039083*value-0.0000005775*value**2+(value<0?-0.00000000000418301*(value-100)*value**3:0);
  assert(Math.abs(predicted-code*reference/(32768*nominal))<5e-15);
  if(code%31===0||code===model.minimumCode||code===model.maximumCode){const error=Math.abs(value-oracle(code,nominal,reference));worst=Math.max(worst,error);assert(error<2e-10,JSON.stringify({code,value,error}));}
 }
 assert(worst<2e-10);
});
test('MAX31865 range admission agrees with decoded temperature and excludes fault bit',()=>{
 const m=new Max31865();for(const [min,max] of [[-273.15,99999999],[-150,-20],[-1,1],[0,300],[25,25.1]]){
  const r=m.range(min,max);
  for(let code=m.minimumCode;code<=m.maximumCode;code++){
   const t=m.temperature(code*2);assert.equal(code*2>=r.minimum&&code*2<=r.maximum,t>=min&&t<=max);
  }
 }
 for(let code=m.minimumCode;code<=m.maximumCode;code++){const t=m.temperature(code*2);assert.equal(m.range(t,t+.01).minimum,code*2);assert.equal(m.range(t-.01,t).maximum,code*2);}
 for(let raw=1;raw<65536;raw+=2)assert.throws(()=>m.temperature(raw),/fault/);
 for(const raw of [-1,65536,1.5,NaN,Infinity])assert.throws(()=>m.temperature(raw));
 for(const [min,max] of [[1,1],[2,1],[-300,0],[900,1000],[-250,-201],[NaN,100],[1,Infinity],[25.001,25.002]])assert.throws(()=>m.range(min,max));
 for(const [nominal,reference] of [[0,430],[100,0],[NaN,430],[100,Infinity],[Number.MIN_VALUE,Number.MAX_VALUE],[Number.MAX_VALUE,Number.MIN_VALUE],[100,1e-9]])assert.throws(()=>new Max31865(nominal,reference));
});
test('MAX31865 reference point preserves zero and corrects old negative-temperature approximation',()=>{
 const m=new Max31865(100,400);assert.equal(m.temperature(8192*2),0);
 const code=m.minimumCode,t=m.temperature(code*2),ratio=code*400/(32768*100),old=(-.0039083+Math.sqrt(.0039083**2-4*(-.0000005775)*(1-ratio)))/(2*(-.0000005775));
 assert(Math.abs(t+200)<.04);assert(Math.abs(old-t)>2);
});
