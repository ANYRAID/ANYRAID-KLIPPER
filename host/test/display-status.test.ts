import test from 'node:test';
import assert from 'node:assert/strict';
import {DisplayStatus} from '../src/gcode/display-status.ts';
import {productDisplayStatus} from '../src/runtime/product-display-status.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
import {nativePrintFixture} from './helpers/native-linear-print.ts';
import {createNativeLinearPrint} from '../src/operations/native-linear-print.ts';
const signal=()=>new AbortController().signal;
test('display progress clamps finite values, expires strictly after five seconds and falls back to file progress',()=>{
 let now=10;const d=new DisplayStatus(()=>now);assert.deepEqual(d.status(10,false,.2),{progress:.2,message:null});d.updateProgress({P:'120'});assert.equal(d.status(15,false,.3).progress,1);assert.equal(d.status(16,true,.3).progress,1);assert.equal(d.status(16,false,.3).progress,.3);d.updateProgress({P:'-10'});assert.equal(d.status(16,true,.8).progress,0);
 d.updateProgress({P:'５０'});assert.equal(d.status(16,true,0).progress,.5);for(const P of ['nan','inf','1__0','1oops'])assert.throws(()=>d.updateProgress({P}));assert.equal(d.status(16,true,0).progress,.5);
 now=20;d.updateProgress({R:'10'});assert.equal(d.status(20,false,.4).progress,.4);d.setMessage('hello');d.reset();assert.deepEqual(d.status(20,true,.7),{progress:.7,message:null});
});
test('display commands preserve raw Unicode and numbered text, extended quoting and empty semantics',async()=>{
 const d=new DisplayStatus(()=>0),dispatch=new GCodeDispatch({output(){},shutdown(){assert.fail('Metadata must not stop motion');}});d.register(dispatch);await assert.rejects(dispatch.execute('M117 blocked'),/not ready/);dispatch.setReady(true);
 await dispatch.execute('N12 M117 正在打印 ; case *15');assert.equal(d.status(0,false,0).message,'正在打印 ; case ');
 await dispatch.execute('M117 Hello ; keep this');assert.equal(d.status(0,false,0).message,'Hello ; keep this');await dispatch.execute('M117');assert.equal(d.status(0,false,0).message,null);
 await dispatch.execute('SET_DISPLAY_TEXT MSG="Mixed Case 中文"');assert.equal(d.status(0,false,0).message,'Mixed Case 中文');await dispatch.execute('SET_DISPLAY_TEXT MSG=""');assert.equal(d.status(0,false,0).message,'');await dispatch.execute('SET_DISPLAY_TEXT');assert.equal(d.status(0,false,0).message,null);
 await dispatch.execute('M73 P25 R10');assert.equal(d.status(0,false,0).progress,.25);await dispatch.execute('M73 Pnan');await assert.rejects(dispatch.execute('M73 P--1'));assert.equal(d.status(0,false,0).progress,.25);
});
test('product display progress follows lifecycle ownership including pause and terminal states',()=>{
 for(const state of ['preparing','printing','pausing','paused','resuming','finishing','cancelling'] as const){const d=new DisplayStatus(()=>0);d.updateProgress({P:'99'});assert.equal(productDisplayStatus(d,state,.2,10).progress,.99);}
 for(const state of ['idle','interrupted','completed','cancelled','failed'] as const){const d=new DisplayStatus(()=>0);d.updateProgress({P:'99'});assert.equal(productDisplayStatus(d,state,.2,10).progress,.2);}
});
test('invalid clocks and oversized display messages cannot partially publish metadata',()=>{
 let now=0;const d=new DisplayStatus(()=>now);d.updateProgress({P:'30'});d.setMessage('valid');now=NaN;assert.throws(()=>d.updateProgress({P:'90'}));assert.throws(()=>d.setMessage('x'.repeat(65537)));assert.throws(()=>d.setMessage('bad\0'));assert.deepEqual(d.status(1,true,.2),{progress:.3,message:'valid'});
});
test('native file accepts display commands without modifying motion and clears old metadata inside prepare',async()=>{
 const f=await nativePrintFixture('M117 正在打印\nM73 P100\nG1 X51 E2.01 F600\nSET_DISPLAY_TEXT MSG="完成"\n'),owner=await createNativeLinearPrint(f.options),eof=Promise.withResolvers<void>();owner.device.subscribeEOF(()=>eof.resolve());owner.device.subscribeFault(eof.reject);void eof.promise.catch(()=>{});
 try{f.gcode.display.setMessage('old');f.gcode.display.updateProgress({P:'80'});await owner.device.prepare({version:1,requestId:'display',fileId:'file',nozzle:200,bed:60},signal());assert.deepEqual(f.gcode.display.status(0,true,0),{progress:0,message:null});await owner.device.start('file',signal());await eof.promise;await owner.device.finish('display',signal());assert.deepEqual(f.gcode.display.status(0,true,0),{progress:1,message:'完成'});assert.deepEqual(f.gcode.coordinates.state.position,[51,0,0,2.01]);assert.equal(f.outputStops,0);}finally{await owner.close();await f.close();}
});
