#!/usr/bin/env node
// GPL-3.0-or-later. Katapult maintenance CLI.
import {runKatapult} from '../host/src/diagnostics/katapult-cli.ts';
const controller=new AbortController(),cancel=()=>controller.abort(new Error('Katapult cancelled'));
process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
try{await runKatapult(process.argv.slice(2),controller.signal,text=>process.stdout.write(text));}catch(error){process.stderr.write(`Katapult Error: ${error instanceof Error?error.message:String(error)}\n`);process.exitCode=1;}finally{process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
