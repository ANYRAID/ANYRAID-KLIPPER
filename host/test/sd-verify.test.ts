import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
import {verifySDFirmware} from '../src/diagnostics/sd-verify.ts';
const signal=()=>new AbortController().signal;
function dictionary(version='new',mcu='stm32f103xe'){const d=new MessageDictionary();d.identify(Buffer.from(JSON.stringify({commands:{},responses:{},config:{MCU:mcu},version})),false);return d;}
const bytes=Buffer.alloc(4097,23),request={board:'btt-skr-mini',sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length};
const noFiles={async stat(){throw new Error('Unexpected disk access');},async readFile(){throw new Error('Unexpected disk access');}};
test('requested dictionary must match exactly; unrelated changes never fall back to disk',async()=>{
 const d=dictionary(),result=await verifySDFirmware(noFiles,d,{...request,dictionary:d.rawIdentify},signal());assert.equal(result.evidence,'running-dictionary');assert.equal(result.runningDictionaryMatched,true);assert.equal(result.bootloaderFileMatched,false);
 await assert.rejects(verifySDFirmware(noFiles,dictionary('unrelated'),{...request,dictionary:d.rawIdentify},signal()),/dictionary mismatch/);
 await assert.rejects(verifySDFirmware(noFiles,d,{...request,dictionary:dictionary('new','wrong').rawIdentify},signal()),/MCU mismatch/);
 await assert.rejects(verifySDFirmware(noFiles,dictionary('new','wrong'),request,signal()),/MCU mismatch/);
 await assert.rejects(verifySDFirmware(noFiles,d,{...request,dictionary:Buffer.from('{}')},signal()));
});
test('bootloader artifact requires exact size and digest and preserves late cancellation',async()=>{
 let reads=0;const files={async stat(){return {size:bytes.length,modified:0,attributes:0};},async readFile(){reads++;return Buffer.from(bytes);}};
 const result=await verifySDFirmware(files,dictionary(),request,signal());assert.equal(result.evidence,'bootloader-file');assert.equal(result.runningDictionaryMatched,false);assert.equal(result.bootloaderFileMatched,true);
 await assert.rejects(verifySDFirmware({...files,async stat(){return {size:1,modified:0,attributes:0};}},dictionary(),request,signal()),/size mismatch/);assert.equal(reads,1);
 await assert.rejects(verifySDFirmware({...files,async readFile(){const b=Buffer.from(bytes);b[0]^=1;return b;}},dictionary(),request,signal()),/SHA-256 mismatch/);
 const controller=new AbortController();await assert.rejects(verifySDFirmware({...files,async readFile(){controller.abort(new Error('cancelled'));return bytes;}},dictionary(),request,controller.signal),/cancelled/);
 for(const bad of [{sha256:'bad'},{size:0},{size:NaN}])await assert.rejects(verifySDFirmware(noFiles,dictionary(),{...request,...bad},signal()),/fingerprint/);
});
