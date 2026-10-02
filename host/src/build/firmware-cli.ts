import {open,writeFile,rename,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {encodeRobin,encodeChitu,maximumFirmwareBytes} from './firmware.ts';
export async function firmwareCLI(kind:'robin'|'chitu'):Promise<void> {
 if(Number(process.versions.node.split('.')[0])!==26)throw new Error('Node.js 26 is required');
 const args=process.argv.slice(2);if(args.length===1&&['-h','--help'].includes(args[0])){console.log('Usage: node '+process.argv[1]+' INPUT OUTPUT');return;}
 if(args.length!==2)throw new Error('Expected input and output firmware paths');
 const handle=await open(args[0],'r');let input:Buffer;
 try{const stat=await handle.stat();if(!stat.isFile()||stat.size>maximumFirmwareBytes)throw new Error('Invalid firmware file');input=await handle.readFile();}finally{await handle.close();}
 const result=kind==='robin'?{firmware:encodeRobin(input)}:encodeChitu(input);
 const temporary=args[1]+'.'+randomUUID()+'.tmp';
 try{await writeFile(temporary,result.firmware,{flag:'wx'});await rename(temporary,args[1]);}finally{await unlink(temporary).catch(()=>{});}
 if('uuid' in result){console.log('Update UUID ',result.uuid);console.log('Block Count is ',result.blocks);console.log('Encoding complete.');}
}
