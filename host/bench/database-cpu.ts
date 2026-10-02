import {DatabaseEngine} from '../src/moonraker/database-engine.ts';
import {encodeDatabaseRecord,decodeDatabaseRecord} from '../src/moonraker/database-record.ts';
import {performance} from 'node:perf_hooks';
const value={status:{temperature:210.125,name:'中文',payload:'x'.repeat(256)},cycle:5};
const timings:Record<string,number>={};let now=performance.now();for(let i=0;i<100000;i++)encodeDatabaseRecord(value);timings.encode100k=performance.now()-now;
const bytes=encodeDatabaseRecord(value);now=performance.now();for(let i=0;i<100000;i++)decodeDatabaseRecord(bytes);timings.decode100k=performance.now()-now;
const engine=new DatabaseEngine({path:':memory:'}),records=Object.fromEntries(Array.from({length:200},(_,i)=>['job'+i,value]));engine.registerNamespace('ui');now=performance.now();for(let i=0;i<1000;i++)engine.syncNamespace('ui',records);timings.sync1000x200=performance.now()-now;
now=performance.now();for(let i=0;i<1000;i++)engine.get('ui');timings.read1000x200=performance.now()-now;engine.close();console.log({node:process.version,scope:"Single-process CPU profiling workload; in-memory SQLite, no Worker or disk, not a latency acceptance benchmark",timings});
