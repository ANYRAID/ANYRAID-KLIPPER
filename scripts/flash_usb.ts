#!/usr/bin/env node
// GPL-3.0-or-later. USB firmware maintenance entry.
import {runUsbFlash} from '../host/src/diagnostics/flash-usb-cli.ts';
const controller=new AbortController(),cancel=()=>controller.abort(new Error('USB flash cancelled'));
process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
try{await runUsbFlash(process.argv.slice(2),controller.signal,text=>process.stdout.write(text));}catch(error){process.stderr.write(`USB Flash Error: ${error instanceof Error?error.message:String(error)}\n`);process.exitCode=1;}finally{process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
