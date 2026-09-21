import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {flashKatapultTarget} from '../src/diagnostics/katapult-startup.ts';
import {requestKatapultCANBootloader} from '../src/diagnostics/katapult-can.ts';
test('Katapult startup validates firmware identity and all options before CAN reboot or device acquisition',async()=>{
 const image=deflateSync(JSON.stringify({app:'Klipper',config:{MCU:'stm32f407'}})),signal=new AbortController().signal;
 await assert.rejects(flashKatapultTarget('can0','1',image,signal,{expectedMcu:'other'}),/Requested MCU/);
 for(const options of [{nodeId:256},{roots:{dev:'relative'}},{alreadyBootloader:1},{expectedMcu:''}])await assert.rejects(flashKatapultTarget('can0','1',image,signal,options as Parameters<typeof flashKatapultTarget>[4]));
 await assert.rejects(flashKatapultTarget('can0','1',Buffer.alloc(0),signal),/options/);
 await assert.rejects(flashKatapultTarget('can0','1',image,AbortSignal.abort(new Error('preabort'))),/preabort/);
 await assert.rejects(requestKatapultCANBootloader('bad/name','1',signal),/interface/);await assert.rejects(requestKatapultCANBootloader('can0','bad uuid',signal),/identity/);
});
