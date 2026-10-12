// libc NSS lookup is isolated from the printing event loop and libuv pool.
import {createRequire} from 'node:module';
import {isIP} from 'node:net';
const address=process.argv[2];
if(process.argv.length!==3||!isIP(address)||address.includes('%'))process.exit(1);
try{
 const native=createRequire(import.meta.url)(process.env.ANYRAID_UNIX_PEER_ADDON??'../../build/unix-peer.node') as {reverseFqdn(address:string):string};
 const name=native.reverseFqdn(address);if(typeof name!=='string'||name.length>4096||!name.isWellFormed())process.exit(1);
 process.stdout.write(JSON.stringify(name));
}catch{process.exitCode=1;}
