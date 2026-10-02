import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
export const katapultContract=JSON.parse(readFileSync(new URL('../contracts/katapult-legacy.json',import.meta.url),'utf8')) as {
 schemaVersion:number;provenance:{commit:string;sourceSha256:string;python:string};
 cases:{kind:string;inputSha256:string;result:unknown}[];
 historicalMeasurements:{ownership:{python:string;pythonTiming:{medianMs:number;p95Ms:number};report:{processes:number;descriptors:number;inaccessible:number}}};
};
if(katapultContract.schemaVersion!==1)throw new Error('Unsupported frozen Katapult contract');
const records=new Map(katapultContract.cases.map(c=>[c.kind+':'+c.inputSha256,c.result]));
if(records.size!==katapultContract.cases.length)throw new Error('Duplicate frozen Katapult reference');
/** Original Python results and historical timings, never a live interpreter run.
 * Unknown inputs fail; they are not synthesized from the implementation under test. */
export function frozenKatapultReference<T>(kind:string,input:unknown):T{
 const key=kind+':'+createHash('sha256').update(JSON.stringify(input)).digest('hex');
 if(!records.has(key))throw new Error(`Missing frozen Katapult ${kind} reference: ${key}`);
 return structuredClone(records.get(key)) as T;
}
