import {test} from 'node:test';
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
 const values=[2.675,-2.675,1.005,-1.005,0,-0,Number.MIN_VALUE,Number.MAX_VALUE,1e-300,-1e-300,1e23,-1e23,1e100,-1e100];let seed=123;for(let i=0;i<150;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;values.push((seed/2**32-.5)*10**(i%40-20));}
 const adjacent=new DataView(new ArrayBuffer(8));for(let p=0;p<16;p++)for(const odd of [1,3,21,127])for(const sign of [-1,1]){const value=sign*odd/2**(p+1);adjacent.setFloat64(0,value);const bits=adjacent.getBigUint64(0);for(const offset of [-1n,0n,1n]){adjacent.setBigUint64(0,bits+offset);values.push(adjacent.getFloat64(0));}}
 const cases=values.flatMap(value=>[-324,-323,-308,-23,-2,...Array.from({length:16},(_,i)=>i),23,100,308,309,324].flatMap(precision=>['common','ceil','floor'].map(method=>({value:Object.is(value,-0)?'-0.0':String(value),precision,method}))));
 const child=spawnSync('python3',['-c',templateNumberOracle()+`\nout=[]\nfor c in json.loads(sys.stdin.read()):\n try:out.append(struct.pack('>d',do_round(float(c['value']),c['precision'],c['method'])).hex())\n except (OverflowError,ZeroDivisionError,ValueError):out.append('error')\nprint(json.dumps(out))`],{input:JSON.stringify(cases),encoding:'utf8',timeout:20000,maxBuffer:4000000});assert.equal(child.status,0,child.stderr);const expected=JSON.parse(child.stdout),bits=Buffer.alloc(8);
 cases.forEach((c,i)=>{let actual;try{bits.writeDoubleBE(templateRoundFloat(Number(c.value),c.precision,c.method));actual=bits.toString('hex');}catch{actual='error';}assert.equal(actual,expected[i],JSON.stringify(c));});
 assert.throws(()=>templateRoundFloat(1,0,'invalid'));assert.throws(()=>templateRoundFloat(1,.5));assert.equal(templateRoundFloat(Infinity,2),Infinity);
});
