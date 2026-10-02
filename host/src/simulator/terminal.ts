import {createRequire} from 'node:module';
import {closeSync,readSync,writeSync,symlinkSync,lstatSync,unlinkSync,readlinkSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
/** Own only the symlink we created; never replace an existing terminal path. */
export function simulatorTerminal(link:string){
 const native=createRequire(import.meta.url)('../../build/simulator-pty.node') as {pair():{master:number;slave:number;path:string}};
 const pair=native.pair();let closed=false,identity:ReturnType<typeof lstatSync>;
 try{symlinkSync(pair.path,link);identity=lstatSync(link);}catch(error){closeSync(pair.master);closeSync(pair.slave);throw error;}
 return {path:pair.path,
  read(){if(closed)throw new Error('Simulator terminal closed');const buffer=Buffer.alloc(64);try{return buffer.subarray(0,readSync(pair.master,buffer));}catch(error){if((error as NodeJS.ErrnoException).code==='EAGAIN')return Buffer.alloc(0);throw error;}},
  async write(bytes:Uint8Array,signal:AbortSignal){let offset=0;while(offset<bytes.length){signal.throwIfAborted();if(closed)throw new Error('Simulator terminal closed');try{const count=writeSync(pair.master,bytes,offset);if(!count)throw new Error('Zero PTY write');offset+=count;}catch(error){if((error as NodeJS.ErrnoException).code!=='EAGAIN')throw error;await delay(1,undefined,{signal});}}},
  close(){if(closed)return;closed=true;closeSync(pair.master);closeSync(pair.slave);try{const current=lstatSync(link);if(current.isSymbolicLink()&&current.ino===identity.ino&&current.dev===identity.dev&&readlinkSync(link)===pair.path)unlinkSync(link);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
 };
}
