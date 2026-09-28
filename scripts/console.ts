#!/usr/bin/env node
import {runMcuConsole} from '../host/src/diagnostics/mcu-console-cli.ts';
const controller=new AbortController(),cancel=()=>controller.abort(Error('MCU console cancelled'));process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
try{await runMcuConsole(process.argv.slice(2),process.stdin,process.stdout,controller.signal);}catch(error){process.stderr.write((error instanceof Error?error.message:String(error))+'\n');process.exitCode=1;}finally{process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
