import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {parseKconfigExpression,tokenizeKconfig,kconfigCondition} from '../src/kconfig/expression.ts';
import {evaluateKconfig,kconfigInteger,type KValue} from '../src/kconfig/evaluate.ts';
const parse=(text:string)=>parseKconfigExpression(tokenizeKconfig(text));
test('all architecture expressions and numeric boundaries match frozen Kconfiglib',async()=>{
 const reference=JSON.parse(await readFile(new URL('../contracts/kconfig-expression-reference.json',import.meta.url),'utf8'));
 assert.equal(createHash('sha256').update(await readFile(new URL('../../lib/kconfiglib/kconfiglib.py',import.meta.url))).digest('hex'),reference.sourceSha256);
 for(const [file,digest] of Object.entries(reference.files))assert.equal(createHash('sha256').update(await readFile(new URL('../../'+file,import.meta.url))).digest('hex'),digest,file);
 const expressions=reference.expressions.map(parse);
 for(const scenario of reference.scenarios){
  const values:Record<string,KValue>=scenario.values;
  assert.deepEqual(expressions.map((expression:ReturnType<typeof parse>)=>evaluateKconfig(expression,name=>values[name])),scenario.expected,scenario.architecture);
 }
 const values:Record<string,KValue>=reference.syntheticValues;
 for(const [expression,expected] of reference.synthetic)assert.equal(evaluateKconfig(parse(expression),name=>values[name]),expected,expression);
 assert.equal(expressions.length,412);
 assert.equal(reference.scenarios.length,11);
 assert.equal(reference.synthetic.length,8256);
});
test('logical short circuit does not resolve unused symbols',()=>{
 const unavailable=()=>{throw new Error('Must not resolve');};
 assert.equal(evaluateKconfig(parse('n && UNUSED'),unavailable),0);
 assert.equal(evaluateKconfig(parse('y || UNUSED'),unavailable),2);
 assert.equal(evaluateKconfig(parse('!m'),unavailable),1);
});
test('integers reject partial parses and preserve values beyond binary64',()=>{
 assert.equal(kconfigInteger('9007199254740993',10),9007199254740993n);
 assert.equal(kconfigInteger('-0x_ff',0),-255n);
 assert.equal(kconfigInteger('１２',10),12n);
 assert.equal(kconfigInteger('10',16),16n);
 assert.equal(kconfigInteger('001',10),1n);
 assert.equal(kconfigInteger('\u008510\u0085',10),10n);
 assert.equal(kconfigInteger('\ufeff10',10),undefined);
 for(const value of ['001','1__0','1_','0x','0x__f','1.0','12oops','--1','+ 1'])assert.equal(kconfigInteger(value,0),undefined,value);
});
test('conditional m depends on MODULES but relation operands and raw defaults do not',()=>{
 for(const enabled of [0,2] as const){
  const lookup=(name:string):KValue|undefined=>name==='MODULES'?{type:'bool',text:enabled?'y':'n',tri:enabled}:undefined;
  assert.equal(evaluateKconfig(kconfigCondition(parse('m')),lookup),enabled?1:0);
  assert.equal(evaluateKconfig(kconfigCondition(parse('!"m"')),lookup),enabled?1:2);
  assert.equal(evaluateKconfig(kconfigCondition(parse('m = m')),lookup),2);
  assert.equal(evaluateKconfig(parse('m'),lookup),1);
 }
});
