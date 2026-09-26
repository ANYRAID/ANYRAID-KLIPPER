// Fixed original CPython reference; integer text and Float64 bits are retained.
import {motanMathReference} from './motan-math-reference.ts';
import type {MotanScalarSeries} from '../../src/motan/scalar-math.ts';
export function scalarOracle(kind:string,first:MotanScalarSeries,second:MotanScalarSeries|undefined,segment=.01,bench=false,third?:MotanScalarSeries,parameters:readonly string[]=[]):{values:[string,string][];ms:number[]}{
 const encode=(values:MotanScalarSeries)=>Array.from(values,v=>[typeof v,Object.is(v,-0)?'-0':String(v)]);
 const payload={kind,first:encode(first),...(second===undefined?{}:{second:encode(second)}),...(third===undefined?{}:{third:encode(third)}),segment,parameters};
 return motanMathReference('scalar',{payload,bench});
}
export function scalarBits(values:MotanScalarSeries):[string,string][]{return Array.from(values,v=>{
 if(typeof v==='bigint')return ['int',v.toString()];
 if(typeof v!=='number')throw new Error('Expected arithmetic output');const b=Buffer.alloc(8);b.writeDoubleBE(v);return ['float',b.toString('hex')];
});}
