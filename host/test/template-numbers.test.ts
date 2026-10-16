import {test} from 'node:test';
import {templateRoundCases} from './helpers/template-round-cases.ts';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {templateNumericReference,decodeTemplateNumericReference} from './helpers/template-numeric-reference.ts';
import {parseConfigurationFloat} from '../src/moonraker/config-reader.ts';
import {templateFloat,templateRoundFloat} from '../src/moonraker/template-numbers.ts';
const encode=(value:unknown):unknown=>typeof value==='number'?(Number.isNaN(value)?'nan':value===Infinity?'inf':value===-Infinity?'-inf':Object.is(value,-0)?'-zero':value):value;
test('frozen template reference rejects corruption and retains captured negative zero',()=>{
 const bytes=readFileSync(new URL('../contracts/template-numeric-reference.json.gz',import.meta.url)),{results}=decodeTemplateNumericReference(bytes);
 assert(Object.is(results.nativeCases[2].find(row=>row.name==='z')!.numberValue,-0));
 const corrupt=Buffer.from(bytes);corrupt[corrupt.length-1]^=1;
 assert.throws(()=>decodeTemplateNumericReference(corrupt),/reference hash mismatch/);
 assert.throws(()=>decodeTemplateNumericReference(Buffer.alloc(0)),/reference hash mismatch/);
});
test('template float preserves Python conversion, fallbacks and nonfinite results without weakening config bounds',()=>{
 const cases:unknown[]=['١_٢.５',' １.２e２ ','1_0.5','1e999','-inf','NaN','Infinity','-0','0x10','12junk','\u001c2',true,false,null,[],{},''];
 const {reference,results}=templateNumericReference();assert.deepEqual(cases,reference.datasets.conversions.inputs);assert.deepEqual(cases.map(v=>encode(templateFloat(v,'fallback'))),results.conversions);assert.throws(()=>templateFloat(10n**1000n),/overflow/);for(const token of ['inf','nan','1e999'])assert.throws(()=>parseConfigurationFloat(token));
});
test('template floating round matches Python bit patterns across ties, extreme scales and all three methods',()=>{
 const cases=templateRoundCases();
 const {reference,results}=templateNumericReference();assert.deepEqual(cases,reference.datasets.rounds.inputs);const expected=results.rounds,bits=Buffer.alloc(8);
 cases.forEach((c,i)=>{let actual;try{bits.writeDoubleBE(templateRoundFloat(Number(c.value),c.precision,c.method));actual=bits.toString('hex');}catch{actual='error';}assert.equal(actual,expected[i],JSON.stringify(c));});
 assert.throws(()=>templateRoundFloat(1,0,'invalid'));assert.throws(()=>templateRoundFloat(1,.5));assert.equal(templateRoundFloat(Infinity,2),Infinity);
});
