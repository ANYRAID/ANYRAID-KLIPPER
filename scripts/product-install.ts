#!/usr/bin/env node
import {productInstallCLI} from '../host/src/runtime/product-install.ts';
const controller=new AbortController(),stop=()=>controller.abort(new Error('Product installation cancelled'));
process.on('SIGINT',stop);process.on('SIGTERM',stop);
try{await productInstallCLI(process.argv.slice(2),controller.signal,text=>process.stdout.write(text));}
catch(error){process.stderr.write('Product Install Error: '+(error instanceof Error?error.message:String(error))+'\n');process.exitCode=1;}
finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
