import assert from 'node:assert/strict';
import {SDCardSPI,sdCRC16} from '../src/diagnostics/sd-card-spi.ts';
import {SDCardEmulator} from '../test/helpers/sd-card-spi.ts';
const data=Uint8Array.from({length:1024*1024},(_,i)=>i&255),crcTimes:number[]=[],ioTimes:number[]=[];const expected=sdCRC16(data);
for(let batch=0;batch<9;batch++){
 let start=performance.now();for(let i=0;i<16;i++)assert.equal(sdCRC16(data),expected);if(batch>=2)crcTimes.push(performance.now()-start);
 const io=new SDCardEmulator(),card=new SDCardSPI(io),signal=new AbortController().signal;await card.initialize(signal);start=performance.now();
 for(let sector=0;sector<256;sector++){const bytes=await card.readSector(sector,signal);assert.deepEqual(bytes,io.data);await card.writeSector(sector,bytes,signal);}
 if(batch>=2)ioTimes.push(performance.now()-start);assert.equal(io.writes.length,256);await card.deinitialize(signal);
}
crcTimes.sort((a,b)=>a-b);ioTimes.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,warmups:2,samples:7,crc:{bytes:16*data.length,medianMs:crcTimes[3],maxMs:crcTimes[6]},spi:{sectorsRead:256,sectorsWritten:256,medianMs:ioTimes[3],maxMs:ioTimes[6]},scope:'CRC computation and asynchronous SPI protocol with in-memory card; excludes MCU transport, flash storage latency and FAT filesystem.'},null,2));
