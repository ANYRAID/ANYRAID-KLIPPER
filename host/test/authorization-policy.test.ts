import test from 'node:test';
import assert from 'node:assert/strict';
import {LoginAttempts,OneShotTokens,authorizationAddress} from '../src/moonraker/authorization-policy.ts';
const signal=()=>new AbortController().signal;
test('login limit serializes concurrent attempts, resets on success and isolates addresses',async()=>{
 const limit=new LoginAttempts(2);let calls=0;
 const failure=()=>limit.run('127.0.0.1',signal(),async()=>{calls++;throw Error('bad password');});
 const results=await Promise.allSettled([failure(),failure(),failure()]);assert.equal(calls,2);assert(results.every(x=>x.status==='rejected'));assert.match((results[2] as PromiseRejectedResult).reason.message,/Maximum Login/);
 assert.equal(await limit.run('127.0.0.2',signal(),async()=>123),123);assert.equal(limit.status.addresses,1);
 await assert.rejects(limit.run('127.0.0.3',signal(),async()=>{throw Error('bad');}),/bad/);await limit.run('127.0.0.3',signal(),async()=>true);
 await assert.rejects(limit.run('127.0.0.3',signal(),async()=>{throw Error('new bad');}),/new bad/);
 const abort=new AbortController();const cancelled=limit.run('127.0.0.4',abort.signal,async()=>{abort.abort(Error('cancel'));throw abort.signal.reason;});await assert.rejects(cancelled,/cancel/);
 assert.equal(await limit.run('127.0.0.4',signal(),async()=>true),true);limit.close();assert.throws(()=>limit.run('127.0.0.1',signal(),async()=>true),/closed/);
});
test('login pending capacity does not evade failure counters and disabled policy does not retain addresses',async()=>{
 assert.throws(()=>new LoginAttempts(0),/Invalid/);const limit=new LoginAttempts(1),release=Promise.withResolvers<void>(),work=Array.from({length:32},()=>limit.run('ip',signal(),async()=>{await release.promise;throw Error('wrong');}));
 assert.throws(()=>limit.run('another',signal(),async()=>true),/capacity/);release.resolve();const results=await Promise.allSettled(work);assert.equal(results.filter(x=>x.status==='rejected').length,32);assert.equal(limit.status.pending,0);limit.close();
 const disabled=new LoginAttempts();for(let i=0;i<5;i++)await assert.rejects(disabled.run('ip',signal(),async()=>{throw Error('wrong');}));assert.equal(disabled.status.addresses,0);disabled.close();
});
test('one-shot expiry, removal on wrong address, capacity recovery and peer canonicalization',()=>{
 let now=0;const store=new OneShotTokens<string>(()=>now),token=store.issue('a','alice');assert.match(token,/^[A-Z2-7]{32}$/);assert.equal(store.consume(token,'b'),undefined);assert.equal(store.consume(token,'a'),undefined);
 const valid=store.issue('a','alice');now=4999;assert.equal(store.consume(valid,'a'),'alice');assert.equal(store.consume(valid,'a'),undefined);
 const expired=store.issue('a','alice');now+=5000;assert.equal(store.consume(expired,'a'),undefined);
 const tokens=new Set(Array.from({length:1024},()=>store.issue('a','alice')));assert.equal(tokens.size,1024);assert.throws(()=>store.issue('a','alice'),/capacity/);now+=5000;assert.equal(store.count,0);assert(store.issue('a','alice'));store.close();assert.throws(()=>store.consume('x','a'),/closed/);
 assert.equal(authorizationAddress('0:0:0:0:0:0:0:1'),'::1');assert.equal(authorizationAddress('::ffff:127.0.0.1'),authorizationAddress('::ffff:7f00:1'));assert.equal(authorizationAddress('fe80::1%eth0'),'fe80::1%eth0');assert.throws(()=>authorizationAddress('proxy.test'),/unavailable/);
});
