import {test} from 'node:test';
import {templateRoundCases} from './helpers/template-round-cases.ts';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {templateNumberOracle} from './helpers/template-number-oracle.ts';
import {parseConfigurationFloat} from '../src/moonraker/config-reader.ts';
import {templateFloat,templateRoundFloat} from '../src/moonraker/template-numbers.ts';
const encode=(value:unknown):unknown=>typeof value==='number'?(Number.isNaN(value)?'nan':value===Infinity?'inf':value===-Infinity?'-inf':Object.is(value,-0)?'-zero':value):value;
test('template float preserves Python conversion, fallbacks and nonfinite results without weakening config bounds',()=>{
 const cases:unknown[]=['١_٢.５',' １.２e２ ','1_0.5','1e999','-inf','NaN','Infinity','-0','0x10','12junk','\u001c2',true,false,null,[],{},''];
 const child=spawnSync('python3',['-c',templateNumberOracle()+`\ndef encode(v):\n if isinstance(v,float):\n  if math.isnan(v):return 'nan'\n  if math.isinf(v):return 'inf' if v>0 else '-inf'\n  if v==0 and math.copysign(1,v)<0:return '-zero'\n return v\nprint(json.dumps([encode(do_float(v,'fallback')) for v in json.loads(sys.stdin.read())]))`],{input:JSON.stringify(cases),encoding:'utf8',timeout:20000});assert.equal(child.status,0,child.stderr);assert.deepEqual(cases.map(v=>encode(templateFloat(v,'fallback'))),JSON.parse(child.stdout));assert.throws(()=>templateFloat(10n**1000n),/overflow/);for(const token of ['inf','nan','1e999'])assert.throws(()=>parseConfigurationFloat(token));
});
test('template floating round matches Python bit patterns across ties, extreme scales and all three methods',()=>{
 const cases=templateRoundCases();
 const child=spawnSync('python3',['-c',templateNumberOracle()+`\nout=[]\nfor c in json.loads(sys.stdin.read()):\n try:out.append(struct.pack('>d',do_round(float(c['value']),c['precision'],c['method'])).hex())\n except (OverflowError,ZeroDivisionError,ValueError):out.append('error')\nprint(json.dumps(out))`],{input:JSON.stringify(cases),encoding:'utf8',timeout:20000,maxBuffer:4000000});assert.equal(child.status,0,child.stderr);const expected=JSON.parse(child.stdout),bits=Buffer.alloc(8);
 cases.forEach((c,i)=>{let actual;try{bits.writeDoubleBE(templateRoundFloat(Number(c.value),c.precision,c.method));actual=bits.toString('hex');}catch{actual='error';}assert.equal(actual,expected[i],JSON.stringify(c));});
 assert.throws(()=>templateRoundFloat(1,0,'invalid'));assert.throws(()=>templateRoundFloat(1,.5));assert.equal(templateRoundFloat(Infinity,2),Infinity);
});
