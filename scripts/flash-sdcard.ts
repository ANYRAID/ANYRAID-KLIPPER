#!/usr/bin/env node
import {fileURLToPath} from 'node:url';
import {runSDFlash} from '../host/src/diagnostics/sd-flash-cli.ts';
const controller=new AbortController(),cancel=()=>controller.abort(new Error('SD flashing cancelled'));
process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
try{process.exitCode=await runSDFlash(process.argv.slice(2),fileURLToPath(new URL('../',import.meta.url)),controller.signal,text=>process.stdout.write(text));}catch(error){process.stderr.write(`SD Flash Error: ${error instanceof Error?error.message:String(error)}\n`);process.exitCode=1;}finally{process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
