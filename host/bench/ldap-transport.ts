import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {LdapAuthorization} from '../src/moonraker/ldap-authorization.ts';
import {ldapPeer,ldapEntry,ldapResult} from '../test/helpers/ldap-peer.ts';
assert.match(process.versions.node,/^26\./u);
// Fixed before measurement; synthetic loopback budgets, not printing or board guarantees.
const budget={loginP95Ms:250,eventLoopP99Ms:20,eventLoopMaxMs:50};
const input={username:'printer',password:'synthetic-benchmark-password',baseDn:'dc=test',groupDn:'cn=printers,dc=test'};
const peer=await ldapPeer({handle(packet){if(packet.tag===96)ldapResult(packet);else{ldapEntry(packet,'uid=printer,dc=test',{memberOf:[input.groupDn]});ldapResult(packet);}}});
const ldap=new LdapAuthorization({host:'127.0.0.1',port:peer.port,baseDn:input.baseDn,groupDn:input.groupDn,timeoutMs:1000});
const iterations=8,warmups=2,samples=7,delay=monitorEventLoopDelay({resolution:1}),values:number[][]=[],eventLoop:{p99Ms:number;maxMs:number}[]=[];
const batch=async()=>{const result:number[]=[];for(let i=0;i<iterations;i++){const start=performance.now();await ldap.authenticate(input.username,input.password,new AbortController().signal);result.push(performance.now()-start);}return result;};
try{
 for(let i=0;i<warmups;i++)await batch();
 delay.enable();
 for(let i=0;i<samples;i++){delay.reset();values.push(await batch());eventLoop.push({p99Ms:delay.percentile(99)/1e6,maxMs:delay.max/1e6});}
 delay.disable();assert.deepEqual(peer.errors,[]);
 const sorted=values.flat().toSorted((a,b)=>a-b),quantile=(p:number)=>sorted[Math.ceil(sorted.length*p)-1]!;
 const sources:Record<string,string>={};
 for(const path of ['../src/moonraker/ldap-authorization.ts','../test/helpers/ldap-peer.ts','./ldap-transport.ts','../package-lock.json'])sources[path]=createHash('sha256').update(await readFile(new URL(path,import.meta.url))).digest('hex');
 const pass=quantile(.95)<=budget.loginP95Ms&&eventLoop.every(value=>value.p99Ms<=budget.eventLoopP99Ms&&value.maxMs<=budget.eventLoopMaxMs);
 console.log(JSON.stringify({schema:1,node:process.version,sources,inputSha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),iterations,warmups,samples,loginSamplesMs:values,eventLoop,budget,medianMs:quantile(.5),p95Ms:quantile(.95),pass,scope:'Actual TCP LDAP service/anonymous bind, subtree search, user bind and group policy on one synthetic loopback peer. No Python/real-directory/TLS-latency/printing/target-board comparison; cached JWT performance retains its separately fingerprinted identity scope.'},null,2));
 if(!pass)process.exitCode=1;
}finally{delay.disable();await ldap.close();await peer.close();}
