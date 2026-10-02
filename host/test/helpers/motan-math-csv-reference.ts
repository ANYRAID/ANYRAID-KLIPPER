// Original Python CSV bytes keyed by both capture files and exact CLI arguments.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {motanMathReference} from './motan-math-reference.ts';
export function motanMathCsvReference(prefix:string,args:string[]):string{
 const captures=Object.fromEntries(['.json.gz','.index.gz'].map(suffix=>[suffix,createHash('sha256').update(readFileSync(prefix+suffix)).digest('hex')]));
 return motanMathReference<{values:string}>('csv',{captures,args}).values;
}
