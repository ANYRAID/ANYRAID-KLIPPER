import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {closeSync,readdirSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {connectUART} from '../src/protocol/uart.ts';
import {ptyPair,inspectPTY} from './helpers/pty.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
const native=createRequire(import.meta.url)(process.env.ANYRAID_SERIALQUEUE_ADDON??'../build/serialqueue.node') as {openUART(path:string,baud:number,rts:boolean):number;setUARTBaud(fd:number,baud:number):void};
const signal=()=>new AbortController().signal;
test('UART raw configuration, arbitrary baud and exclusivity survive duplicated session ownership',async()=>{
 const pair=ptyPair();await serialFirmware(pair);let stopped=0;
 try{const session=await connectUART(pair.path,{baud:250000,leaveBootloader:false,async stopDevice(){stopped++;}},signal());
 try{assert.deepEqual(inspectPTY(pair.path),{baud:250000,inputBaud:250000,inputFlags:0,outputFlags:0,localFlags:0,vmin:0,vtime:0,stopBits:0,parity:0,flow:0,hupcl:0,bits:8});assert.throws(()=>native.openUART(pair.path,115200,true),/Lock/);
 const result=await session.query(session.dictionary.encode('echo',{value:255}),'echo_response',signal());assert.equal(result.message.parameters.value,255);
 }finally{await session.stop();}assert.equal(stopped,1);const fd=native.openUART(pair.path,115200,false);closeSync(fd);
 }finally{await pair.close();}
});
test('default AVR leave sequence has exact bytes and restores requested speed before identification',async()=>{
 const pair=ptyPair();const received:Buffer[]=[];let bootBaud=0;pair.peer.on('data',(b:Buffer)=>{received.push(b);if(received.length===1)bootBaud=inspectPTY(pair.path).baud;});await serialFirmware(pair);
 try{const session=await connectUART(pair.path,{baud:250000,async stopDevice(){}},signal());try{assert.deepEqual(received[0],Buffer.from([0x1b,1,0,1,0x0e,0x11,4]));assert.equal(bootBaud,115200);assert.equal(inspectPTY(pair.path).baud,250000);}finally{await session.stop();}}finally{await pair.close();}
});
test('abort during bootloader wait closes UART and releases its lock without starting a session',async()=>{
 const pair=ptyPair(),abort=new AbortController();let stops=0;try{const pending=connectUART(pair.path,{baud:115200,async stopDevice(){stops++;}},abort.signal);const rejected=assert.rejects(pending,/Abort/);await delay(10);abort.abort();await rejected;assert.equal(stops,0);const fd=native.openUART(pair.path,115200,true);closeSync(fd);}finally{await pair.close();}
});
test('UART validation and failed opens do not leak descriptors',async()=>{
 const pair=ptyPair();try{const before=readdirSync('/proc/self/fd').length;for(let i=0;i<20;i++){assert.throws(()=>native.openUART('/dev/null',115200,true),/termios/);assert.throws(()=>native.openUART(pair.path,0,true),/baud/);assert.throws(()=>native.openUART(pair.path+'\0extra',115200,true),/NUL/);}assert.ok(readdirSync('/proc/self/fd').length<=before);const fd=native.openUART(pair.path,123457,true);try{assert.equal(inspectPTY(pair.path).baud,123457);native.setUARTBaud(fd,2400);assert.equal(inspectPTY(pair.path).baud,2400);}finally{closeSync(fd);}}finally{await pair.close();}
});
test('abort during identification stops the session once and unlocks the physical port',async()=>{
 const pair=ptyPair(),abort=new AbortController();let stops=0;try{const pending=connectUART(pair.path,{baud:115200,leaveBootloader:false,async stopDevice(){stops++;}},abort.signal);const rejected=assert.rejects(pending,/cancel identify/);await delay(15);abort.abort(new Error('cancel identify'));await rejected;assert.equal(stops,1);const fd=native.openUART(pair.path,115200,true);closeSync(fd);}finally{await pair.close();}
});
