#!/usr/bin/env node
// GPL-3.0-or-later. Offline MCU dump inspection; never opens a device for writing.
import {createReadStream} from 'node:fs';
import {open} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import {MessageDictionary} from '../host/src/protocol/dictionary.ts';
import {decodeSerialDump} from '../host/src/diagnostics/serial-dump.ts';
const help='Usage: node scripts/parsedump.ts DICTIONARY SERIAL_DUMP\nDecode MCU frames to text. Corrupt bytes are reported; truncated input fails.\n';
try{
 const args=process.argv.slice(2);if(args.length===1&&['-h','--help'].includes(args[0]))process.stdout.write(help);
 else{if(args.length!==2)throw new Error(help);const file=await open(args[0],'r');let data:Buffer;
 try{const size=(await file.stat()).size;if(size>4*1024**2)throw new Error('Dictionary exceeds 4 MiB');data=Buffer.alloc(4*1024**2+1);let used=0;for(;;){const {bytesRead}=await file.read(data,used,data.length-used,null);used+=bytesRead;if(used>4*1024**2)throw new Error('Dictionary exceeds 4 MiB');if(!bytesRead)break;}data=data.subarray(0,used);}finally{await file.close();}
 const dictionary=new MessageDictionary();dictionary.identify(data,false);
 await pipeline(decodeSerialDump(dictionary,createReadStream(args[1]),decoder=>{if(decoder.discardedBytes)process.stderr.write('Invalid data: discarded '+decoder.discardedBytes+' bytes\n');}),process.stdout);}
}catch(error){process.stderr.write((error instanceof Error?error.message:String(error))+'\n');process.exitCode=1;}
