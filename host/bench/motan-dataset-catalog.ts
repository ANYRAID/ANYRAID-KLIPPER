import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {motanCsvReference,csvReferenceMetadata} from '../test/helpers/motan-csv-reference.ts';
const cli=fileURLToPath(new URL('../../scripts/motan/data_export.ts',import.meta.url)),expected=motanCsvReference().catalog,samples:number[]=[];
for(let run=0;run<9;run++){
 const start=performance.now(),output=execFileSync(process.execPath,[cli,'--list-datasets'],{encoding:'utf8',timeout:10000,env:{...process.env,PATH:'/no-external-programs'}}),elapsed=performance.now()-start;
 assert.equal(output,expected);if(run>=2)samples.push(elapsed);
}
samples.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,warmups:2,runs:7,bytes:Buffer.byteLength(expected),historicalPython:csvReferenceMetadata.catalogPython,current:{medianMs:samples[3],p95Ms:samples[6]},scope:'Complete CLI startup and listing, fixed original stdout comparison; historical Python captured separately. No capture analysis or printer timing.'},null,2));
