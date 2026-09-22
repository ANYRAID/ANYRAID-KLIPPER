#!/usr/bin/env node
// GPL-3.0-or-later. Allwinner A64 AR100 SRAM maintenance.
import {runAr100Flash} from '../host/src/diagnostics/flash-ar100-cli.ts';
const controller=new AbortController(),cancel=()=>controller.abort(new Error('AR100 maintenance cancelled'));
process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
try{await runAr100Flash(process.argv.slice(2),controller.signal,text=>process.stdout.write(text));}catch(error){process.stderr.write(`AR100 Flash Error: ${error instanceof Error?error.message:String(error)}\n`);process.exitCode=1;}finally{process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
