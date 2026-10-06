import test from 'node:test';import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
import {StepperExecutedCounter} from './helpers/stepper-executed-counter.ts';import type {AcceptedFirmwareCommand} from './helpers/serial-firmware.ts';

for(const sanitizer of ['undefined','address,undefined'])test(`commanded pulse position matches actual C through future, partial and wrap (${sanitizer})`,()=>{
 const directory=mkdtempSync(join(tmpdir(),'stepper-position-reference-'));
 try{
  const helpers=fileURLToPath(new URL('./helpers/',import.meta.url)),binary=join(directory,'test');
  execFileSync(process.env.CC??'cc',['-std=gnu11','-O2','-Wall','-Wextra','-Werror','-Wno-unused-parameter','-fsanitize='+sanitizer,'-fno-sanitize-recover=all',...(sanitizer.includes('address')?['-fno-pie','-no-pie']:[]),'-I'+join(helpers,'stepper-stop-firmware'),'-I'+join(helpers,'output-firmware'),join(helpers,'stepper-stop-firmware/scheduled-position.c'),'-o',binary],{timeout:60000,stdio:'pipe'});
  const reference=JSON.parse(execFileSync(binary,{encoding:'utf8',timeout:10000}));
  const model=(initialClock:number,position:number)=>{let now=initialClock;const counter=new StepperExecutedCounter(()=>now,()=>{});counter.seedPosition(2,position);return{counter,clock(value:number){now=value;},command(name:string,parameters:Record<string,number>){return counter.observe({name,parameters} as AcceptedFirmwareCommand);}};};
  const future=model(2502934,-24);future.command('reset_step_clock',{oid:2,clock:2598527});future.command('trsync_start',{oid:9});future.command('stepper_stop_on_trigger',{oid:2,trsync_oid:9});future.command('queue_step',{oid:2,interval:2500,count:20,add:0});
  assert.equal(future.counter.position(2),reference.capturedFutureBefore);future.clock(2504434);future.command('trsync_trigger',{oid:9,reason:1});assert.equal(future.counter.position(2),reference.capturedFutureAfterStop);assert.notEqual(future.counter.position(2),reference.receiveOnlyWrong);future.clock(2700000);assert.equal(future.counter.position(2),-24);
  const partial=model(2498000,-24);partial.command('reset_step_clock',{oid:2,clock:2498000});partial.command('trsync_start',{oid:9});partial.command('stepper_stop_on_trigger',{oid:2,trsync_oid:9});partial.command('queue_step',{oid:2,interval:2500,count:20,add:-10});partial.clock(2504434);assert.equal(partial.counter.position(2),-26);partial.command('trsync_trigger',{oid:9,reason:1});assert.equal(partial.counter.position(2),reference.partialNegativeAdd);partial.clock(2600000);assert.equal(partial.counter.position(2),-26);
  const wrap=model(4294966796,-26);wrap.command('reset_step_clock',{oid:2,clock:4294966796});wrap.command('trsync_start',{oid:9});wrap.command('stepper_stop_on_trigger',{oid:2,trsync_oid:9});wrap.command('queue_step',{oid:2,interval:250,count:4,add:0});wrap.clock(4294967246);wrap.command('trsync_trigger',{oid:9,reason:1});assert.equal(wrap.counter.position(2),reference.wrapAfterStop);wrap.clock(2000);assert.equal(wrap.counter.position(2),-27);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
test('scheduled counter keeps per-MCU stop ownership and one-shot reset authority',()=>{
 let now=1000;const a=new StepperExecutedCounter(()=>now,()=>{}),b=new StepperExecutedCounter(()=>now,()=>{}),command=(c:StepperExecutedCounter,name:string,parameters:Record<string,number>)=>c.observe({name,parameters} as AcceptedFirmwareCommand);
 for(const c of[a,b]){command(c,'reset_step_clock',{oid:0,clock:1000});command(c,'trsync_start',{oid:8});command(c,'stepper_stop_on_trigger',{oid:0,trsync_oid:8});command(c,'queue_step',{oid:0,interval:100,count:3,add:5});}
 now=1150;a.trigger(8);assert.equal(a.position(0),-1);now=1400;assert.equal(a.position(0),-1);assert.equal(b.position(0),-3);assert.equal(command(a,'queue_step',{oid:0,interval:100,count:2,add:0}),false);
 command(a,'reset_step_clock',{oid:0,clock:1400});command(a,'set_next_step_dir',{oid:0,dir:1});command(a,'queue_step',{oid:0,interval:100,count:2,add:0});a.trigger(8);now=1700;assert.equal(a.position(0),1);
});
test('distinct explicit halt inputs publish only at their own MCU stop, once',()=>{
 let now=1000;const delivered:number[]=[];const create=(halt:number)=>{let c:StepperExecutedCounter;return c=new StepperExecutedCounter(()=>now,()=>{},oid=>{delivered.push(halt);c.seedPosition(oid,halt);});};
 const a=create(-7),b=create(-11),command=(c:StepperExecutedCounter,name:string,parameters:Record<string,number>)=>c.observe({name,parameters} as AcceptedFirmwareCommand);
 for(const c of[a,b]){command(c,'reset_step_clock',{oid:0,clock:1000});command(c,'trsync_start',{oid:8});command(c,'stepper_stop_on_trigger',{oid:0,trsync_oid:8});command(c,'queue_step',{oid:0,interval:100,count:3,add:5});}
 now=1150;a.trigger(8);assert.deepEqual(delivered,[-7]);assert.equal(a.position(0),-7);assert.equal(b.position(0),-1);
 now=1400;b.trigger(8);assert.deepEqual(delivered,[-7,-11]);assert.equal(a.position(0),-7);assert.equal(b.position(0),-11);a.trigger(8);b.trigger(8);assert.deepEqual(delivered,[-7,-11]);
});
