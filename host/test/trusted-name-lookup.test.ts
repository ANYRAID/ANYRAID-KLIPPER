import test from 'node:test';import assert from 'node:assert/strict';
import {createRequire}from'node:module';
import {mkdtemp,writeFile,rm}from'node:fs/promises';import{join}from'node:path';import{tmpdir}from'node:os';
import {NativeTrustedNameLookup,type TrustedNameLookup}from'../src/moonraker/trusted-name-lookup.ts';
import {TrustedClients}from'../src/moonraker/trusted-clients.ts';
const native=createRequire(import.meta.url)(process.env.ANYRAID_UNIX_PEER_ADDON??'../build/unix-peer.node') as {reverseFqdn(address:unknown):string};
test('native FQDN validates numeric input before NSS; loopback result is a bounded string',()=>{
 for(const input of [undefined,null,{},1,'','localhost','127.1','127.0.0.1\0x','::1%lo','a'.repeat(1000)])assert.throws(()=>native.reverseFqdn(input),/numeric peer address/);
 for(const ip of ['127.0.0.1','::1','::ffff:127.0.0.1']){const name=native.reverseFqdn(ip);assert.equal(typeof name,'string');assert(name.length>0&&name.length<=4096);}
 for(let i=0;i<100;i++)assert.equal(typeof native.reverseFqdn('127.0.0.1'),'string');
});
test('real owned Node child uses same libc NSS result and drains on close',async()=>{
 const lookup=new NativeTrustedNameLookup();try{assert.equal(await lookup.lookup('127.0.0.1',new AbortController().signal),native.reverseFqdn('127.0.0.1'));assert.equal(lookup.status.active,0);assert.equal(await lookup.lookup('host.invalid',new AbortController().signal),null);}finally{await lookup.close();}assert.deepEqual(lookup.status,{active:0,closed:true});await assert.rejects(lookup.lookup('127.0.0.1',new AbortController().signal),/closed/);
});
test('NSS child cancellation and owner close leave no owned children',async()=>{
 const lookup=new NativeTrustedNameLookup(),abort=new AbortController();const result=lookup.lookup('127.0.0.1',abort.signal);abort.abort(new Error('caller-cancel'));await assert.rejects(result,/caller-cancel/);assert.equal(lookup.status.active,0);
 const pending=lookup.lookup('::1',new AbortController().signal);const denied=assert.rejects(pending,/closed/);await lookup.close();await denied;assert.equal(lookup.status.active,0);
});
test('NSS child capacity is four and has no unbounded process queue',async()=>{
 const lookup=new NativeTrustedNameLookup(),signal=new AbortController().signal;const requests=Array.from({length:4},()=>lookup.lookup('127.0.0.1',signal));assert.equal(lookup.status.active,4);assert.equal(await lookup.lookup('127.0.0.1',signal),null);await Promise.all(requests);assert.equal(lookup.status.active,0);await lookup.close();
});
test('five-second deadline kills an actually stalled owned child and drains it',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nss-stall-')),path=join(root,'addon.cjs'),prior=process.env.ANYRAID_UNIX_PEER_ADDON;await writeFile(path,"module.exports={reverseFqdn(){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20000);return 'printer.example';}};");
 const lookup=new NativeTrustedNameLookup();process.env.ANYRAID_UNIX_PEER_ADDON=path;
 try{const start=performance.now();assert.equal(await lookup.lookup('127.0.0.1',new AbortController().signal),null);const elapsed=performance.now()-start;assert(elapsed>=4900&&elapsed<6500);assert.equal(lookup.status.active,0);}finally{await lookup.close();if(prior===undefined)delete process.env.ANYRAID_UNIX_PEER_ADDON;else process.env.ANYRAID_UNIX_PEER_ADDON=prior;await rm(root,{recursive:true,force:true});}
});
function source(name:string|null):TrustedNameLookup&{calls:number;closed:boolean}{return{calls:0,closed:false,async lookup(){this.calls++;return name;},async close(){this.closed=true;}};}
test('domain configuration, case-insensitive NSS result, 84000-second cache and numeric fast path',async()=>{
 let now=0;const lookup=source('PRINTER.EXAMPLE'),policy=new TrustedClients(['printer.example','127.0.0.1','2001:db8::/32'],{lookup,monotonicNow:()=>now}),signal=new AbortController().signal;
 assert.equal(policy.hasDomains,true);assert.equal(await policy.resolve('127.0.0.1',signal),true);assert.equal(await policy.resolve('2001:db8::1',signal),true);assert.equal(lookup.calls,0);
 assert.equal(policy.matches('192.0.2.1'),false);assert.equal(await policy.resolve('192.0.2.1',signal),true);assert.equal(policy.matches('192.0.2.1'),true);assert.equal(lookup.calls,1);
 now=83999999;assert.equal(await policy.resolve('192.0.2.1',signal),true);assert.equal(lookup.calls,1);now=84000000;assert.equal(policy.matches('192.0.2.1'),false);assert.equal(await policy.resolve('192.0.2.1',signal),true);assert.equal(lookup.calls,2);await policy.close();assert.equal(lookup.closed,true);assert.equal(policy.matches('127.0.0.1'),false);
});
test('negative FQDN result is cached, unknown failures grant nothing, malformed peers do not query',async()=>{
 const lookup=source('other.example'),policy=new TrustedClients(['printer.example'],{lookup}),signal=new AbortController().signal;
 for(const ip of ['192.0.2.1','192.0.2.1'])assert.equal(await policy.resolve(ip,signal),false);assert.equal(lookup.calls,1);
 for(const ip of [undefined,'printer.example','::1%lo','127.1'])assert.equal(await policy.resolve(ip,signal),false);assert.equal(lookup.calls,1);await policy.close();
 const failure=new TrustedClients(['printer.example'],{lookup:{async lookup(){throw Error('lookup-failure');},async close(){}}});assert.equal(await failure.resolve('192.0.2.1',signal),false);await failure.close();
});
test('concurrent same-address callers share lookup and one cancelled caller does not cancel others',async()=>{
 const reply=Promise.withResolvers<string|null>();let calls=0;const policy=new TrustedClients(['printer.example'],{lookup:{lookup(){calls++;return reply.promise;},async close(){reply.resolve(null);}}}),a=new AbortController(),b=new AbortController();
 const first=policy.resolve('192.0.2.1',a.signal),second=policy.resolve('192.0.2.1',b.signal);assert.equal(calls,1);a.abort(new Error('first-cancelled'));await assert.rejects(first,/first-cancelled/);reply.resolve('printer.example');assert.equal(await second,true);await policy.close();
});
test('owner closure rejects pending resolutions and late result cannot rearm trust',async()=>{
 const reply=Promise.withResolvers<string|null>();const policy=new TrustedClients(['printer.example'],{lookup:{lookup(){return reply.promise;},async close(){reply.resolve('printer.example');}}});
 const pending=policy.resolve('192.0.2.1',new AbortController().signal),denied=assert.rejects(pending,/closed/);await policy.close();await denied;assert.equal(policy.matches('192.0.2.1'),false);
});
test('cache capacity remains bounded under concurrent completions',async()=>{
 const lookup=source('printer.example'),policy=new TrustedClients(['printer.example'],{lookup}),signal=new AbortController().signal;for(let i=0;i<4088;i++)assert.equal(await policy.resolve(`10.${i>>>8}.${i&255}.1`,signal),true);const results=await Promise.all(Array.from({length:12},(_,i)=>policy.resolve('192.0.2.'+(i+1),signal)));assert.equal(results.filter(Boolean).length,8);assert.equal(await policy.resolve('192.0.2.100',signal),false);assert.equal(lookup.calls,4100);await policy.close();
});
test('domain validation rejects long ambiguous suffixes without regex backtracking',()=>{
 const begin=performance.now();for(let i=0;i<1000;i++)assert.throws(()=>new TrustedClients(['a'.repeat(252)+'1']),TypeError);assert(performance.now()-begin<500);for(const name of ['aa','printer..example','printer.example.','printer_1.example','Printer.example'])assert.throws(()=>new TrustedClients([name]),TypeError);
});
test('synchronous resolver-side caller cancellation cannot miss the abort event',async()=>{
 const abort=new AbortController(),reply=Promise.withResolvers<string|null>();const policy=new TrustedClients(['printer.example'],{lookup:{lookup(){abort.abort(new Error('reentrant-cancel'));return reply.promise;},async close(){reply.resolve(null);}}});await assert.rejects(policy.resolve('192.0.2.1',abort.signal),/reentrant-cancel/);await policy.close();
});
