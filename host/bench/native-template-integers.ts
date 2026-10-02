/** Native candidate integer and boolean round differential; requires explicit build. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {NativeTemplateCandidate} from '../src/moonraker/native-template.ts';
import {templateNumberOracle} from '../test/helpers/template-number-oracle.ts';
const values:(number|boolean)[]=[true,false,0,1,-1,15,-15,145,-155,9007199254740991,-9007199254740991,4503599627370495,-4503599627370495];
let seed=271;for(let i=0;i<100;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;values.push(Math.trunc((seed/2**32-.5)*Number.MAX_SAFE_INTEGER));}
const cases=values.flatMap(v=>[-324,-309,-40,-39,-17,-16,-15,-2,-1,0,1,2,15,308,309,400].flatMap(p=>['common','ceil','floor'].map(m=>({v,p,m}))));
const oracle=spawnSync('python3',['-c',templateNumberOracle()+`
def encode(value):
 if not math.isfinite(value) or isinstance(value,int) and abs(value)>9007199254740991:return 'error'
 return dict(kind='integer' if isinstance(value,int) else 'float',bits=struct.pack('>d',value).hex())
out=[]
for c in json.loads(sys.stdin.read()):
 try:out.append(encode(do_round(c['v'],c['p'],c['m'])))
 except (ValueError,OverflowError,ZeroDivisionError):out.append('error')
print(json.dumps(out))`],{input:JSON.stringify(cases),encoding:'utf8',timeout:20000,maxBuffer:4000000});
assert.equal(oracle.status,0,oracle.stderr);const expected=JSON.parse(oracle.stdout),t=new NativeTemplateCandidate('{% set d=payload|fromjson %}{set_result("x",d.v|round(d.p,d.m))}'),bits=Buffer.alloc(8);let mismatches=0;const examples:unknown[]=[];
try{cases.forEach((c,i)=>{let actual:unknown;try{const r=t.render(JSON.stringify(c))[0];bits.writeDoubleBE(r.numberValue!);actual={kind:r.numberType,bits:bits.toString('hex')};}catch{actual='error';}if(JSON.stringify(actual)!==JSON.stringify(expected[i])){mismatches++;if(examples.length<8)examples.push({input:c,actual,expected:expected[i]});}});}finally{t.close();}
console.log(JSON.stringify({cases:cases.length,mismatches,examples},null,2));assert.equal(mismatches,0);
// Exercise float conversion independently of round so defaults and scalar types
// cannot be hidden by a later filter. Nonfinite output is rejected by the store.
const floatInputs:unknown[]=[true,false,null,[],{},0,1,-1,1.25,'','inf','-Infinity','NaN','1e999','0x10','١_٢.５',' １.２e２ '];
for(let c=0;c<256;c++)for(const token of ['1.5','١٢.٥']){floatInputs.push(String.fromCharCode(c)+token,token+String.fromCharCode(c));}
for(const a of ['','+','-','_','1','１'])for(const b of ['0','1.','1_0','.5','١.５','NaN','Infinity'])for(const c of ['','_','e2','e-2','e_2','junk'])floatInputs.push(a+b+c);
const floatOracle=spawnSync('python3',['-c',templateNumberOracle()+`
out=[]
for v in json.loads(sys.stdin.read()):
 result=do_float(v,17.0)
 out.append(struct.pack('>d',result).hex() if math.isfinite(result) else 'error')
print(json.dumps(out))`],{input:JSON.stringify(floatInputs),encoding:'utf8',timeout:20000,maxBuffer:4000000});assert.equal(floatOracle.status,0,floatOracle.stderr);
const floatExpected=JSON.parse(floatOracle.stdout),floatTemplate=new NativeTemplateCandidate('{% set d=payload|fromjson %}{set_result("x",d.v|float(17.0))}');
try{floatInputs.forEach((v,i)=>{let actual:string;try{const r=floatTemplate.render(JSON.stringify({v}))[0];bits.writeDoubleBE(r.numberValue!);actual=bits.toString('hex');assert.equal(r.numberType,'float');}catch{actual='error';}assert.equal(actual,floatExpected[i],JSON.stringify(v));});}finally{floatTemplate.close();}
console.log(JSON.stringify({floatConversions:floatInputs.length,passed:true}));
