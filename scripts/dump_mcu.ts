#!/usr/bin/env node
// GPL-3.0-or-later. Diagnostic connection cleanup is not a physical stop.
import {runMcuDump} from '../host/src/diagnostics/mcu-dump-cli.ts';
const controller=new AbortController(),cancel=()=>controller.abort(new Error('MCU dump cancelled'));process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
try{await runMcuDump(process.argv.slice(2),controller.signal,text=>process.stdout.write(text));}catch(error){process.stderr.write(`MCU Dump Error: ${error instanceof Error?error.message:String(error)}\n`);process.exitCode=1;}finally{process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
