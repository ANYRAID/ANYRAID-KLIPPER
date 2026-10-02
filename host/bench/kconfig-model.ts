import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {parseKconfig} from '../src/kconfig/parser.ts';
import {KconfigModel} from '../src/kconfig/model.ts';
const tree=await parseKconfig(fileURLToPath(new URL('../../',import.meta.url)));
const reference=JSON.parse(await readFile(new URL('../contracts/kconfig-model-reference.json',import.meta.url),'utf8'));
const cases=reference.cases.map((c:{assignments:Record<string,string>})=>new Map(Object.entries(c.assignments)));
const expected=reference.cases.reduce((sum:number,c:{expected:[string,number,number,boolean][]})=>sum+c.expected.reduce((a,v)=>a+v[0].length+v[1]+v[2]+Number(v[3]),0),0);
const samples:number[]=[];let checksum=0;
for(let run=0;run<18;run++){
 const start=performance.now();let sum=0;
 for(const assignments of cases){
  const model=new KconfigModel(tree,assignments);
  for(const value of Object.values(model.resolve()))sum+=value.text.length+value.tri+value.visibility+Number(value.write);
 }
 const elapsed=performance.now()-start;assert.equal(sum,expected);checksum=sum;if(run>=3)samples.push(elapsed);
}
samples.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,configurations:cases.length,symbolsPerConfiguration:363,warmups:3,runs:samples.length,medianMs:samples[7],p95Ms:samples[14],checksum,scope:'Model construction, assignments, full symbol/visibility/write-flag resolution on an already parsed tree. No parsing, config-file IO, export, compiler or motion processing.'},null,2));
