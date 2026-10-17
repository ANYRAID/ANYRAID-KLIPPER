#!/usr/bin/env node
// GPL-3.0-or-later. Installed as an immutable, independently versioned launcher-v1 bootstrap.
import {pathToFileURL,fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {ProductGenerationStore} from '../host/src/runtime/product-generation-store.ts';
const controller=new AbortController(),stop=()=>controller.abort(new Error('Product launcher shutdown requested'));process.on('SIGTERM',stop);process.on('SIGINT',stop);
let store:ProductGenerationStore|undefined;
try{const args=process.argv.slice(2),verify=args[0]==='--verify';if(verify)args.shift();if(args.length!==2||args[0]!=='--store')throw new Error('Expected [--verify] --store /absolute/generation-store');store=new ProductGenerationStore(args[1]!);await store.initialize(controller.signal);if(verify){process.stdout.write('Product launcher-v1 installation verified\n');}else{const launch=await store.launch(controller.signal),entry=await import(pathToFileURL(join(launch.directory,'scripts/product-generation-entry.js')).href);if(entry.productGenerationEntryProtocol!==1||typeof entry.runProductGeneration!=='function')throw new Error('Selected product generation lacks launcher protocol v1');await entry.runProductGeneration({...launch,bootstrapDirectory:dirname(dirname(fileURLToPath(import.meta.url))),updates:store.port(),confirm:(proof:{nonce:string;generationSha256:string;profileSha256:string},signal:AbortSignal)=>store!.confirm(proof,signal)},controller.signal,(text:string)=>process.stdout.write(text));}}
catch(error){process.stderr.write('Product generation launcher failed: '+(error instanceof Error?error.message:'startup_failed')+'\n');process.exitCode=1;}
finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);await store?.close();}
