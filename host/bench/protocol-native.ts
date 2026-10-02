// Compile the existing C helper as an independent wire/clock oracle.
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {encodeFrame,FrameDecoder,extendClock} from '../src/protocol/codec.ts';
const dir=mkdtempSync(join(tmpdir(),'anyraid-native-protocol-'));
const helper=fileURLToPath(new URL('../../klippy/chelper/',import.meta.url));
const harness=String.raw`
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <inttypes.h>
#include "msgblock.h"
void errorf(const char *fmt, ...) { abort(); }
int main(int argc,char **argv) {
  if(argc!=3) return 2;
  FILE *f=fopen(argv[1],"rb"); if(!f) return 3;
  uint8_t buf[256],need_sync=0; int used=0; size_t n;
  while((n=fread(buf+used,1,127,f))) {
    used+=(int)n;
    int result;
    while((result=msgblock_check(&need_sync,buf,used))) {
      int consumed=result<0 ? -result : result;
      if(result>0) {
        printf("F ");for(int i=0;i<result;i++) printf("%02x",buf[i]);printf("\n");
      }
      memmove(buf,buf+consumed,used-consumed);used-=consumed;
    }
  }
  fclose(f);f=fopen(argv[2],"r");if(!f) return 4;
  uint64_t last;uint32_t low;
  while(fscanf(f,"%" SCNu64 " %" SCNu32,&last,&low)==2)
    printf("C %" PRIu64 "\n",clock_from_clock32(last,low));
  fclose(f);return 0;
}
`;
let seed=0x793ad918;
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
try {
  const src=join(dir,'oracle.c'),bin=join(dir,'oracle');writeFileSync(src,harness);
  const compile=spawnSync(process.env.CC??'cc',['-O2','-I',helper,src,join(helper,'msgblock.c'),'-o',bin],{encoding:'utf8',timeout:60000});
  if(compile.status!==0) throw new Error(compile.stderr||String(compile.error));
  const data:number[]=[];
  for(let i=0;i<1000;i++) {
    if(i%7===0) for(let j=0;j<random()%20;j++) data.push(random()&255);
    const frame=encodeFrame(i,Uint8Array.from({length:random()%60},()=>random()&255));
    if(i%5===0) frame[random()%frame.length]^=1;
    data.push(...frame);
  }
  const stream=Uint8Array.from(data),frames:string[]=[],decoder=new FrameDecoder();
  for(let i=0;i<stream.length;i+=127) for(const frame of decoder.push(stream.subarray(i,i+127))) frames.push('F '+Buffer.from(frame).toString('hex'));
  const clocks=Array.from({length:10000},()=>({last:(BigInt(random())<<32n)|BigInt(random()),low:random()}));
  clocks.push({last:0xfffffffffffffff0n,low:16},{last:0n,low:0xffffffff});
  writeFileSync(join(dir,'stream'),stream);
  writeFileSync(join(dir,'clocks'),clocks.map(c=>`${c.last} ${c.low}`).join('\n'));
  const run=spawnSync(bin,[join(dir,'stream'),join(dir,'clocks')],{encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
  if(run.status!==0) throw new Error(run.stderr||String(run.error));
  const expected=[...frames,...clocks.map(c=>'C '+extendClock(c.last,c.low))];
  assert.deepEqual(run.stdout.trim().split('\n'),expected);
  console.log(JSON.stringify({nativeOracle:'klippy/chelper/msgblock.c',corruptedStreamBytes:stream.length,recoveredFrames:frames.length,exactClockComparisons:clocks.length}));
} finally {rmSync(dir,{recursive:true,force:true});}
