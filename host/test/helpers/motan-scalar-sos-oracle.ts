import type {MotanScalarSeries} from '../../src/motan/scalar-math.ts';
import type {MotanSOS,MotanSOSMode} from '../../src/motan/sos-filter.ts';
import {motanSOSReference} from './motan-sos-reference.ts';
export function scalarSOSOracle(source:MotanScalarSeries,sos:MotanSOS,mode:MotanSOSMode,bench=false):{dtype:string;bits?:string[];ms?:number[];error?:string} {
  const request={source:Array.from(source,v=>[typeof v,Object.is(v,-0)?'-0':String(v)]),sos,mode,bench};
  return motanSOSReference('scalar',request);
}
