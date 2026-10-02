#!/usr/bin/env node
// GPL-3.0-or-later. Native product host with explicit machine integration.
import {ProductHostControl} from '../host/src/runtime/product-host-control.ts';
import {runProductHostCLI} from '../host/src/runtime/product-host-cli.ts';
const controller=new AbortController(),stop=()=>controller.abort(new Error('Product host termination requested'));
const control=new ProductHostControl(),reinitialize=()=>{void control.reinitialize().then(()=>process.stdout.write(JSON.stringify({event:'reinitialized'})+'\n'),error=>process.stderr.write('Product Host Reinitialization Error: '+(error instanceof Error?error.message:String(error))+'\n'));};
process.on('SIGHUP',reinitialize);
process.on('SIGINT',stop);process.on('SIGTERM',stop);
try{await runProductHostCLI(process.argv.slice(2),controller.signal,text=>{process.stdout.write(text);},control);}
catch(error){process.stderr.write(`Product Host Error: ${error instanceof Error?error.message:String(error)}\n`);process.exitCode=1;}
finally{process.removeListener('SIGHUP',reinitialize);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
