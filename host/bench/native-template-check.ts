/** Separate candidate acceptance suite: requires explicit native build. */
import assert from 'node:assert/strict';
import {NativeTemplateCandidate} from '../src/moonraker/native-template.ts';
import {SensorMessages} from '../src/moonraker/sensor-messages.ts';
import {templateRoundCases} from '../test/helpers/template-round-cases.ts';
import {templateNumericReference} from '../test/helpers/template-numeric-reference.ts';
import {SensorStore} from '../src/moonraker/sensors.ts';
const cases=[
 {source:'{set_result("i",1)}{set_result("f",1.0)}{set_result("r",1.0|round(0))}{set_result("b",true)}',payload:''},
 {source:'{% set d=payload|fromjson %}{% for k,v in d.items() %}{set_result(k,v)}{% endfor %}',payload:'{"i":1,"f":1.0,"b":false}'},
 {source:'{set_result("p",2.675|round(2))}{set_result("n",(-2.675)|round(2))}{set_result("u","١_٢.５"|float)}{set_result("z",-0.0)}',payload:''},
 {source:'{set_result("big",9007199254740993-9007199254740992)}',payload:''},
 {source:'{% set d=payload|fromjson %}{set_result("big",d.a-d.b)}',payload:'{"a":9007199254740993,"b":9007199254740992}'},
 {source:'{set_result("x",145|round(-1))}{set_result("y",(-155)|round(-1))}{set_result("z",1.125|round(2,"ceil"))}',payload:''},
 {source:'{set_result("__proto__",1)}{set_result("__proto__",2.0)}{set_result("fallback","bad"|float("2.5"))}',payload:''},
];
const {reference,results}=templateNumericReference();assert.deepEqual(cases,reference.datasets.nativeCases.inputs);const expected=results.nativeCases;
cases.forEach((c,i)=>{const template=new NativeTemplateCandidate(c.source);try{assert.deepEqual(template.render(c.payload),expected[i]);}finally{template.close();}assert.throws(()=>template.render(c.payload),/closed/);template.close();});
const source='{% set d=payload|fromjson %}{set_result("first",1)}{set_result("second",d.value)}',template=new NativeTemplateCandidate(source),store=new SensorStore();store.register({id:'room',type:'MQTT'});const receiver=new SensorMessages(store,'room',template.renderer);
assert.equal(receiver.receive(Buffer.from('{"value":1.0}')),true);assert.deepEqual(store.info('room').values,{first:1,second:1});assert.equal(receiver.receive(Buffer.from('{"value":9007199254740993}')),false);assert.deepEqual(store.info('room').values,{first:1,second:1});assert.equal(receiver.receive(Buffer.from('{"value":2.5}')),true);assert.deepEqual(store.info('room').values,{first:1,second:2.5});receiver.close();template.close();store.close();
for(const source of ['{% for i in range(1000000) %}x{% endfor %}','{% for i in range(17) %}{set_result(i|string,i)}{% endfor %}']){const t=new NativeTemplateCandidate(source);try{assert.throws(()=>t.render(''));}finally{t.close();}}
assert.throws(()=>new NativeTemplateCandidate('{% if %}'));assert.throws(()=>new NativeTemplateCandidate('\ud800'));
// Reject i128 overflow before subsequent cancellation could hide precision loss.
for(const operation of ['d.n+1-d.n','d.n*2-d.n','(-d.n-1)-1+d.n']) {
 const t=new NativeTemplateCandidate(`{% set d=payload|fromjson %}{set_result("value",${operation})}`);
 try {assert.throws(()=>t.render('{"n":170141183460469231731687303715884105727}'));} finally {t.close();}
}
const numericCases=templateRoundCases();assert.deepEqual(numericCases,reference.datasets.rounds.inputs);
const numericExpected=results.rounds.map(value=>value==='error'||!Number.isFinite(Buffer.from(value,'hex').readDoubleBE())?'error':value),numericTemplate=new NativeTemplateCandidate('{% set c=payload|fromjson %}{set_result("value",(c.value|float)|round(c.precision,c.method))}'),bits=Buffer.alloc(8);
try{numericCases.forEach((value,i)=>{let actual;try{const result=numericTemplate.render(JSON.stringify(value));assert.equal(result[0].numberType,'float');bits.writeDoubleBE(result[0].numberValue!);actual=bits.toString('hex');}catch{actual='error';}assert.equal(actual,numericExpected[i],JSON.stringify(value));});}finally{numericTemplate.close();}
console.log(JSON.stringify({node:process.version,fixtures:cases.length,numericCases:numericCases.length,passed:true,scope:'Native syntax, typed literals/JSON/round callbacks, integer cancellation, booleans, recovery, close, fuel and parameter caps; not full Jinja compatibility'},null,2));
