import test from 'node:test';
import assert from 'node:assert/strict';
import {motanNotch} from '../src/motan/sos-design.ts';
import {motanSOSFilter} from '../src/motan/sos-filter.ts';
import {sosOracle} from './helpers/motan-sos-oracle.ts';
import type {SOSCase} from './helpers/motan-sos-oracle.ts';

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
      idealError=Math.max(idealError,Math.abs(values[j]-refs[i].ideal![j]));
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
