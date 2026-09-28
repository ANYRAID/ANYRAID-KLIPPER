#!/usr/bin/env node
// GPL-3.0-or-later. Node frontend for the pinned native simulavr core.
import {parseArgs} from 'node:util';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runAVR} from '../host/src/simulator/run.ts';
const {values,positionals}=parseArgs({allowPositionals:true,options:{machine:{type:'string',short:'m',default:'atmega644'},speed:{type:'string',short:'s',default:'16000000'},rate:{type:'string',short:'r',default:'0'},baud:{type:'string',short:'b',default:'250000'},trace:{type:'string',short:'t'},port:{type:'string',short:'p',default:'/tmp/pseudoserial'},tracefile:{type:'string',short:'f',default:'avrsim.vcd'},help:{type:'boolean',short:'h'}}});
if(values.help){console.log('Usage: node scripts/avrsim.ts [options] program.elf\n-m, --machine AVR model (atmega644)\n-s, --speed Clock Hz (16000000)\n-b, --baud UART baud (250000)\n-r, --rate Simulation / wall time ratio (0 = unlimited)\n-p, --port New PTY symlink (/tmp/pseudoserial)\n-t, --trace Comma-separated signal names, or ? to list\n-f, --tracefile VCD output (avrsim.vcd)');}
else{
 if(positionals.length!==1)throw new Error('Expected one AVR ELF file; use --help');
 const speed=Number(values.speed),baud=Number(values.baud),rate=Number(values.rate);
 if(!Number.isInteger(speed)||speed<1||speed>1e9||!Number.isInteger(baud)||baud<1||baud>1e8||!Number.isFinite(rate)||rate<0||rate>1e6||!/^[a-z0-9]+$/i.test(values.machine))throw new Error('Invalid simulation options');
 const binary=fileURLToPath(new URL('../host/build/avrsim',import.meta.url));
 if(values.trace==='?'){
  const result=spawnSync(binary,[values.machine,String(speed),String(baud),positionals[0],values.tracefile,'?'],{stdio:'inherit',timeout:10000});
  if(result.status!==0)throw new Error('Cannot list trace signals: '+(result.error??result.status));
 }else{
  const controller=new AbortController(),stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try{await runAVR({binary,elf:positionals[0],port:values.port,machine:values.machine,speed,baud,rate,...values.trace?{trace:{file:values.tracefile,signals:values.trace}}:{}},controller.signal,()=>{
   console.log(`Starting AVR simulation: machine=${values.machine} speed=${speed}\nSerial: port=${values.port} baud=${baud}`);
  });}finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
 }
}
