import {fixedDecimal} from '../src/diagnostics/python-literal.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {QueryADC} from '../src/inputs/query-adc.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
import {queryADCOracle} from './helpers/query-adc-oracle.ts';
test('ADC diagnostic output matches pinned Python including clamp, rounding and name ordering',()=>{
 const cases=Array.from({length:1001},(_,i)=>({sources:{bed:[i*.0625,i/1000]},params:{NAME:'bed',PULLUP:String(i%2?2.5:4700)}}));
 cases.push({sources:{bed:[1,0]},params:{NAME:'absent',PULLUP:'bad'}});
 const py=spawnSync('/usr/bin/python3',['-c',queryADCOracle()],{input:JSON.stringify(cases),encoding:'utf8'});
 assert.equal(py.status,0,py.stderr);const expected=JSON.parse(py.stdout);
 cases.forEach((c,i)=>{const query=new QueryADC();query.register('bed',{lastValue:c.sources.bed as [number,number]});assert.equal(query.report(c.params.NAME,c.params.PULLUP),expected[i]);});
 const query=new QueryADC();for(const name of ['😀','\uffff','a','bed heater'])query.register(name,{lastValue:[0,0]});
 assert.equal(query.report(),'Available ADC objects: "a", "bed heater", "\uffff", "😀"');
});
test('ADC registrations have bounded ownership and stale detach cannot remove a replacement',()=>{
 const query=new QueryADC(),source={lastValue:[0,0] as const};
 const detach=query.register('bed',source);assert.throws(()=>query.register('bed',source));detach();query.register('bed',source);detach();assert.deepEqual(query.names,['bed']);
 for(const name of ['', 'a\nb','a"b','a\\b','x'.repeat(257)])assert.throws(()=>query.register(name,source));
 for(let i=0;i<255;i++)query.register(String(i),source);assert.throws(()=>query.register('overflow',source));
});
test('QUERY_ADC is read only, ready gated and invalid pullup is a command error',async()=>{
 const output:string[]=[];let stopped=0,reads=0;
 const dispatch=new GCodeDispatch({output:line=>output.push(line),shutdown:()=>{stopped++;}}),query=new QueryADC();
 query.register('bed heater',{get lastValue(){reads++;return [1.25,.5] as const;}});query.attach(dispatch);
 await assert.rejects(dispatch.execute('QUERY_ADC'),/not ready/);assert.equal(reads,0);
 dispatch.setReady(true);output.length=0;await dispatch.execute('QUERY_ADC NAME="bed heater" PULLUP=4700');
 assert.deepEqual(output,['// ADC object "bed heater" has value 0.500000 (timestamp 1.250)\n// resistance 4700.000 (with 4700 pullup)']);assert.equal(reads,1);
 for(const raw of ['0','-1','NaN','Infinity','0x10','1e309','1_000'])await assert.rejects(dispatch.execute(`QUERY_ADC NAME="bed heater" PULLUP=${raw}`),/finite positive/);
 assert.equal(stopped,0);
});
test('ADC diagnostic output rejects invalid source values and resistance overflow',()=>{
 for(const pair of [[NaN,.5],[-1,.5],[1,Infinity],[1,-.1],[1,1.1]]){const query=new QueryADC();query.register('test',{lastValue:pair as [number,number]});assert.throws(()=>query.report('test'),/Invalid ADC/);}
 const query=new QueryADC();query.register('test',{lastValue:[1,1]});assert.throws(()=>query.report('test','1e308'),/not finite/);
});

test('shared fixed decimal formatting matches Python ties, negative zero and large values',()=>{
 const values=[-0,-.5,.5,1.5,2.5,-2.5,.0625,.1875,Number.MIN_VALUE,1e21,-1e30,Number.MAX_VALUE];
 const py=spawnSync('/usr/bin/python3',['-c',"import json,sys; values=json.load(sys.stdin); values[0]=-0.0; print(json.dumps([[format(v,'.%df'%p) for p in range(7)] for v in values]))"],{input:JSON.stringify(values),encoding:'utf8'});
 assert.equal(py.status,0,py.stderr);const expected=JSON.parse(py.stdout);
 values.forEach((value,i)=>{for(let p=0;p<=6;p++)assert.equal(fixedDecimal(value,p),expected[i][p]);});
 for(const precision of [-1,7,NaN,.5])assert.throws(()=>fixedDecimal(1,precision));
});
