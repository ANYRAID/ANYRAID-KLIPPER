import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {parseKconfig,type KNode} from '../src/kconfig/parser.ts';
const root=fileURLToPath(new URL('../../',import.meta.url));
const samples:number[]=[];
let count=0;
for(let run=0;run<35;run++){
 const start=performance.now();
 const tree=await parseKconfig(root);
 const elapsed=performance.now()-start;
 count=0;
 const visit=(node:KNode)=>{count++;node.children.forEach(visit);};
 visit(tree.root);
 assert.equal(tree.files.length,12);
 assert.equal(count,499);
 if(run>=5)samples.push(elapsed);
}
samples.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,files:12,nodes:count,warmups:5,runs:samples.length,medianMs:(samples[14]+samples[15])/2,p95Ms:samples[28],maximumMs:samples.at(-1),scope:'Warm filesystem full-tree parsing including file reads; excludes evaluation, configuration export, menu and process startup. Not a print hot path.'},null,2));
