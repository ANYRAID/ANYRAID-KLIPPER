import assert from 'node:assert/strict';
import {FatFS} from '../src/diagnostics/fatfs.ts';
import {fatDisk} from '../test/helpers/fatfs-disk.ts';
const data=Buffer.alloc(1024*1024,0x5a),times:number[]=[],d=fatDisk(),signal=new AbortController().signal,fs=await FatFS.mount(d.device,signal);
try{for(let i=0;i<9;i++){const start=performance.now();await fs.writeFile('firmware.bin',data,signal);assert.deepEqual(await fs.readFile('firmware.bin',signal),data);if(i>=2)times.push(performance.now()-start);}}finally{await fs.close();}
times.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,bytes:data.length,warmups:2,samples:7,writeReadMedianMs:times[3],maxMs:times[6],scope:'Native FatFs file write, close and exact readback with process IPC and memory FAT16 sectors; excludes actual card/MCU latency'}));
