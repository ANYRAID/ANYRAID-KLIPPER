import {createServer,createConnection,type Socket} from 'node:net';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
export async function serialPair(){const dir=mkdtempSync(join(tmpdir(),'anyraid-serial-')),path=join(dir,'socket');let accept!:(socket:Socket)=>void;const peerPromise=new Promise<Socket>(r=>{accept=r;});const server=createServer(accept);await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(path,resolve);});const socket=createConnection(path);socket.pause();await new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});const peer=await peerPromise;const fd=(socket as unknown as {_handle:{fd:number}})._handle.fd;return {fd,peer,async close(){socket.destroy();peer.destroy();await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});}};}
