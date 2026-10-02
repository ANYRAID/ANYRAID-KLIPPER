import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseKconfigExpression,tokenizeKconfig} from '../src/kconfig/expression.ts';
import {evaluateKconfig,type KValue} from '../src/kconfig/evaluate.ts';
const reference=JSON.parse(await readFile(new URL('../contracts/kconfig-expression-reference.json',import.meta.url),'utf8'));
const expressions=reference.expressions.map((s:string)=>parseKconfigExpression(tokenizeKconfig(s)));
const scenarios=reference.scenarios as {values:Record<string,KValue>;expected:number[]}[];
const expected=scenarios.reduce((sum,scenario)=>sum+scenario.expected.reduce((a,b)=>a+b,0),0)*100;
const samples:number[]=[];let checksum=0;
for(let run=0;run<15;run++){
 let sum=0;const start=performance.now();
 for(let repeat=0;repeat<100;repeat++)for(const scenario of scenarios){
  const lookup=(name:string)=>scenario.values[name];
  for(const expression of expressions)sum+=evaluateKconfig(expression,lookup);
 }
 const elapsed=performance.now()-start;
 assert.equal(sum,expected);checksum=sum;if(run>=3)samples.push(elapsed);
}
samples.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,evaluations:expressions.length*scenarios.length*100,warmups:3,runs:samples.length,medianMs:(samples[5]+samples[6])/2,p95Ms:samples[11],checksum,scope:'Parsed expressions and resolved symbol snapshots across 11 architectures; excludes parser, dependency/default/choice resolution and output generation. Build-time work, not motion processing.'},null,2));
