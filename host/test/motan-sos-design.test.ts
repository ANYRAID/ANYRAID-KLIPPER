import test from 'node:test';
import assert from 'node:assert/strict';
import {motanNotch,motanButterworth} from '../src/motan/sos-design.ts';
import {motanSOSFilter} from '../src/motan/sos-filter.ts';
import {sosOracle} from './helpers/motan-sos-oracle.ts';
import type {SOSCase} from './helpers/motan-sos-oracle.ts';
import {Complex} from 'complex.js';

test('Butterworth cutoff gain remains -3dB at narrow bands and near frequency boundaries',()=>{
 for(const order of [1,3,8,16,32,64]){
  for(const kind of ['lowpass','highpass','bandpass'] as const){
   const cutoffs=kind==='bandpass'?[[1,5],[100,101],[450,490]]:[.1,1,499.9];
   for(const cutoff of cutoffs){
    const sos=motanButterworth(order,cutoff,kind,1000);
    for(const frequency of typeof cutoff==='number'?[cutoff]:cutoff){
     const w=2*Math.PI*frequency/1000,z=new Complex(Math.cos(w),-Math.sin(w)),z2=z.mul(z);
     let response=new Complex(1);
     for(const[b0,b1,b2,,a1,a2]of sos)response=response.mul(z.mul(b1).add(z2.mul(b2)).add(b0).div(z.mul(a1).add(z2.mul(a2)).add(1)));
     assert.ok(Math.abs(response.abs()-Math.SQRT1_2)<2e-7,`${kind}/${order}/${cutoff}: ${response.abs()}`);
    }
   }
  }
 }
});

test('Butterworth low/high/bandpass coefficients and complete filtering match SciPy',()=>{
 const source=Array.from({length:2048},(_,i)=>.3+Math.sin(i*.023)+Math.cos(i*.317)),cases:SOSCase[]=[];
 for(const kind of ['lowpass','highpass','bandpass'] as const)
  for(const order of [0,1,2,3,5,8,16,32,64])for(const mode of ['filt','filtfilt'] as const)
   cases.push({kind,order,mode,source,cutoff:kind==='bandpass'?[20,100]:50});
 const refs=sosOracle(cases);
 const high=cases.filter(c=>c.kind==='bandpass'&&c.order>=32),precise=sosOracle(high,false,true);
 for(let i=0;i<cases.length;i++){
  const c=cases[i],sos=motanButterworth(c.order,c.cutoff,c.kind as 'lowpass'|'highpass'|'bandpass',1000);
  assert.equal(sos.length,refs[i].sos.length);
  const actual=c.kind==='bandpass'?sos.toSorted((a,b)=>a[4]-b[4]||a[5]-b[5]):sos;
  const expected=c.kind==='bandpass'?refs[i].sos.toSorted((a,b)=>a[4]-b[4]||a[5]-b[5]):refs[i].sos;
  assert.ok(Math.abs(sos[0][0]-refs[i].sos[0][0])<2e-12);
  for(let j=0;j<sos.length;j++)for(let k=c.kind==='bandpass'?3:0;k<6;k++)
   assert.ok(Math.abs(actual[j][k]-expected[j][k])<2e-12,`${c.kind}/${c.order} section ${j}/${k}`);
  const values=motanSOSFilter(sos,source,c.mode);let error=0;
  const reference=c.kind==='bandpass'&&c.order>=32?precise[high.indexOf(c)].preciseValues!:refs[i].values;
  for(let j=0;j<values.length;j++)error=Math.max(error,Math.abs(values[j]-reference[j]));
  assert.ok(error<2e-10,`${c.kind}/${c.order}/${c.mode}: ${error}`);
 }
});

test('Butterworth design rejects invalid orders, cutoff shapes and unrepresentable designs',()=>{
 for(const order of [-1,.5,65,NaN])assert.throws(()=>motanButterworth(order,50,'lowpass',1000),/parameters/);
 for(const cutoff of [0,500,Infinity,[20,10],[20],[20,30,40]])assert.throws(()=>motanButterworth(2,cutoff,'bandpass',1000),/cutoff/);
 assert.throws(()=>motanButterworth(5,1e-100,'lowpass',1000),/stably/);
 assert.ok(Object.isFrozen(motanButterworth(3,50,'highpass',1000)[0]));
});

test('Native notch design and filtering match the SciPy design/root conversion path', () => {
  const source = Array.from({length:4096},(_,i)=>.3+Math.sin(i*.023)+Math.cos(i*.317));
  const cases:SOSCase[]=[];
  for(const cutoff of [.01,1,50,250,499.9]) for(const order of [.5,1,30,1000]) {
    if(2*cutoff/1000/order>=1)continue;
    for(const mode of ['filt','filtfilt'] as const)
      cases.push({source,cutoff,order,mode,kind:'notch'});
  }
  const refs=sosOracle(cases,false,true);
  for(let i=0;i<cases.length;i++) {
    const c=cases[i],sos=motanNotch(c.cutoff as number,c.order,1000);
    sos[0].forEach((value,j)=>assert.ok(Math.abs(value-refs[i].sos[0][j])<2e-14));
    const values=motanSOSFilter(sos,source,c.mode);
    let error=0,idealError=0;
    for(let j=0;j<values.length;j++) {
      error=Math.max(error,Math.abs(values[j]-refs[i].values[j]));
      idealError=Math.max(idealError,Math.abs(values[j]-refs[i].preciseValues![j]));
    }
    // Extremely low cutoffs amplify coefficient rounding in SciPy's root
    // round-trip too. Use an independent 80-digit ideal filter for that case.
    assert.ok(idealError<(c.cutoff===.01?1e-7:2e-10),
      `ideal ${c.cutoff}/${c.order}/${c.mode}: ${idealError}`);
    if(c.cutoff!==.01)assert.ok(error<2e-10,`${c.cutoff}/${c.order}/${c.mode}: ${error}`);
  }
});

test('Notch design rejects unrepresentable poles and invalid bandwidth instead of returning an unstable filter',()=>{
  for(const args of [[0,30,1000],[500,30,1000],[50,0,1000],[50,30,0],
    [50,NaN,1000],[400,.5,1000],[1e-200,30,1000],[50,1e300,1000]])
    assert.throws(()=>motanNotch(args[0],args[1],args[2]),/notch/);
  assert.ok(Object.isFrozen(motanNotch(50,30,1000)[0]));
});
