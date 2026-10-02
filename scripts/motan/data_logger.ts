#!/usr/bin/env node
// GPL-3.0-or-later. Motion analysis data capture.
import {runMotanLogger} from '../../host/src/motan/data-logger.ts';
const control=new AbortController(),stop=()=>control.abort(new Error('Motan capture interrupted'));
process.once('SIGINT',stop);process.once('SIGTERM',stop);
try{await runMotanLogger(process.argv.slice(2),control.signal,text=>process.stdout.write(text));}catch(error){process.stderr.write(`Motan capture error: ${error instanceof Error?error.message:String(error)}\n`);process.exitCode=control.signal.aborted?130:1;}finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
