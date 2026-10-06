#!/usr/bin/env node
// GPL-3.0-or-later. Explicit protected browser ingress; never a motion owner.
import {ProductClientGateway} from '../host/src/runtime/product-client-gateway.ts';
import {productClientAssets} from '../host/src/runtime/product-client-assets.ts';
const abort=new AbortController(),stop=()=>abort.abort(new Error('Client gateway stop requested'));let gateway:ProductClientGateway|undefined;
process.once('SIGINT',stop);process.once('SIGTERM',stop);
try{
 const args=process.argv.slice(2),flags=new Map<string,string>();let loopbackHttp=false;
 if(args.length===1&&args[0]==='--help')process.stdout.write('Usage: node scripts/product-client.js --origin https://printer.example.com --upstream http://127.0.0.1:7125 --assets /installed/mainsail --port 8080 [--loopback-http]\nRuns on 127.0.0.1. HTTPS public origin requires the existing TLS proxy to preserve Host. --loopback-http explicitly allows a loopback origin for local development.\n');
 else{
  for(let i=0;i<args.length;i++){const key=args[i];if(key==='--loopback-http'){if(loopbackHttp)throw Error('Repeated option');loopbackHttp=true;continue;}if(!['--origin','--upstream','--assets','--port'].includes(key)||flags.has(key)||!args[i+1])throw Error('Invalid client gateway option');flags.set(key,args[++i]);}
  if(flags.size!==4||!/^\d+$/u.test(flags.get('--port')!))throw Error('Origin, upstream, installed assets and port are required');const port=Number(flags.get('--port'));if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid port');
  const [major,minor]=process.versions.node.split('.').map(Number);if(major!==26||minor<9)throw Error('Client gateway requires Node.js 26.9 or later 26.x');
  abort.signal.throwIfAborted();const client=await productClientAssets(flags.get('--assets')!);abort.signal.throwIfAborted();gateway=new ProductClientGateway({origin:flags.get('--origin')!,upstream:flags.get('--upstream')!,loopbackHttp,client});const address=await gateway.listen(port);abort.signal.throwIfAborted();process.stdout.write(JSON.stringify({event:'client-listening',address})+'\n');await new Promise<void>(resolve=>{abort.signal.addEventListener('abort',()=>resolve(),{once:true});if(abort.signal.aborted)resolve();});
 }
}catch{process.stderr.write('Client gateway failed to start or stopped before ready; verify explicit configuration and installed resources.\n');process.exitCode=1;}
finally{await gateway?.close();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
