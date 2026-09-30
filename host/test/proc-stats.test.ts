import test from 'node:test';
import assert from 'node:assert/strict';
import {ProcStats,parseProcFiles,throttledState,type ProcFiles} from '../src/moonraker/proc-stats.ts';
const files:ProcFiles={rss:'Rss: 4096 kB\n',memory:'MemTotal: 10000 kB\nMemAvailable: 3000 kB\n',cpu:'cpu 9007199254740993 0 0 100 0 0 0 0 0 0\ncpu0 10 0 0 10',network:'eth0: 100 2 0 1 0 0 0 0 200 3 0 2 0 0 0 0',temperature:'42000\n'};
test('process files keep units, exact CPU counters, unknown temperature and unsafe network counters explicit',()=>{
 const parsed=parseProcFiles(files);assert.equal(parsed.rss,4096);assert.equal(parsed.units,'kB');assert.equal(parsed.temperature,42);assert.deepEqual(parsed.memory,{total:10000,available:3000,used:7000});assert.equal(parsed.cpu.cpu.total,9007199254741093n);assert.equal(parsed.network.eth0.tx_bytes,200);
 const absent=parseProcFiles({rss:null,memory:'MemTotal: 1\nMemAvailable: 2',cpu:'cpu invalid',network:'eth0: 9007199254740993 0 0 0 0 0 0 0 0 0 0 0',temperature:'invalid'});assert.equal(absent.rss,null);assert.equal(absent.units,null);assert.equal(absent.temperature,null);assert.deepEqual(absent.memory,{});assert.equal(Object.keys(absent.network).length,0);
 assert.deepEqual(throttledState('throttled=0x10001\n'),{bits:65537,flags:['Under-Voltage Detected','Previously Under-Volted']});assert.throws(()=>throttledState('invalid'));
});
test('statistics use monotonic intervals, bounded history and single-record notifications with current connections',async()=>{
 let time=0,cpu=0,input=files;const events:{method:string;value:any}[]=[];
 const stats=new ProcStats({source:{async read(){return input;},async throttled(){return {bits:1,flags:['Under-Voltage Detected']};}},clock:()=>time,wall:()=>100+time,cpuTime:()=>cpu,uptime:()=>1000+time,connections:()=>2,notify:(method,value)=>events.push({method,value})});
 time=1;cpu=.25;await stats.sample();let snapshot=stats.snapshot() as any;assert.deepEqual(snapshot.moonraker_stats,[{time:101,cpu_usage:25,memory:4096,mem_units:'kB'}]);assert.deepEqual(snapshot.system_cpu_usage,{});assert.equal(snapshot.network.eth0.bandwidth,0);assert.equal(snapshot.system_uptime,1001);assert.equal(snapshot.websocket_connections,2);assert.equal(events[0].value.moonraker_stats.cpu_usage,25);assert.equal(events[1].method,'notify_cpu_throttled');
 input={...files,cpu:'cpu 9007199254741013 0 0 120 0 0 0 0 0 0\ncpu0 20 0 0 20',network:'eth0: 150 2 0 1 0 0 0 0 250 3 0 2 0 0 0 0'};
 time=3;cpu=.75;await stats.sample();snapshot=stats.snapshot() as any;assert.deepEqual(snapshot.system_cpu_usage,{cpu:50,cpu0:50});assert.equal(snapshot.network.eth0.bandwidth,50);snapshot.moonraker_stats[0].memory=0;assert.equal((stats.snapshot() as any).moonraker_stats[0].memory,4096);
 input=files;time=4;cpu=1;await stats.sample();snapshot=stats.snapshot() as any;assert.deepEqual(snapshot.system_cpu_usage,{});assert.equal(snapshot.network.eth0.bandwidth,0);
 for(let i=0;i<35;i++){time++;cpu+=.1;await stats.sample();}assert.equal((stats.snapshot() as any).moonraker_stats.length,30);assert.equal(events.filter(e=>e.method==='notify_cpu_throttled').length,1);time+=5;await stats.sample();assert.equal(stats.status.delayedSamples,1);await stats.close();await assert.rejects(stats.sample(),/closed/);
});
test('in-flight sampling is coalesced and close discards late data without notification',async()=>{
 let calls=0,time=0;const read=Promise.withResolvers<ProcFiles>();const stats=new ProcStats({source:{read(){calls++;return read.promise;}},clock:()=>time,cpuTime:()=>0,connections:()=>0,notify(){assert.fail('late notification');}});time=1;
 const first=stats.sample(),second=stats.sample();assert.equal(first,second);assert.equal(calls,1);const rejection=assert.rejects(first,/closed/);let closed=false;const stopping=stats.close().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);read.resolve(files);await rejection;await stopping;assert.equal(stats.status.samples,0);assert.equal(stats.status.pending,false);assert.equal(stats.status.closed,true);
});

test('process usage retains pinned ties-to-even decimal rounding',async()=>{
 let now=0,cpu=0;const stats=new ProcStats({source:{async read(){return files;}},clock:()=>now,cpuTime:()=>cpu,connections:()=>0,notify(){}});now=1;cpu=.00125;await stats.sample();assert.equal((stats.snapshot() as any).moonraker_stats[0].cpu_usage,.12);await stats.close();
});
