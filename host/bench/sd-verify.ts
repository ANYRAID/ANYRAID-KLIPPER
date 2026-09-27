import {createHash} from 'node:crypto';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
import {verifySDFirmware} from '../src/diagnostics/sd-verify.ts';
const bytes=Buffer.alloc(1024*1024,23),d=new MessageDictionary();d.identify(Buffer.from(JSON.stringify({commands:{},responses:{},config:{MCU:'stm32f103xe'},version:'x'.repeat(16384)})),false);
const base={board:'btt-skr-mini',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},signal=new AbortController().signal;
const files={async stat(){return {size:bytes.length,modified:0,attributes:0};},async readFile(){return Buffer.from(bytes);}};
const results=[];
for(const mode of ['running-dictionary','bootloader-file']){
 const request=mode==='running-dictionary'?{...base,dictionary:d.rawIdentify}:base,samples:number[]=[];
 for(let run=0;run<9;run++){const start=performance.now();for(let i=0;i<256;i++){const result=await verifySDFirmware(files,d,request,signal);if(result.evidence!==mode)throw new Error('Wrong evidence');}if(run>=2)samples.push(performance.now()-start);}
 samples.sort((a,b)=>a-b);results.push({mode,iterations:256,medianMs:samples[3],maxMs:samples[6]});
}
console.log(JSON.stringify({node:process.version,warmups:2,samples:7,scope:'16 KiB dictionary or copied 1 MiB memory file; excludes device and filesystem latency',results},null,2));
