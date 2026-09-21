#!/usr/bin/env node
// GPL-3.0-or-later. Offline legacy motion demonstration.
import {parseArgs} from 'node:util';
import {motionPlots} from '../host/src/diagnostics/graph-motion.ts';
import {writeStatsPanels} from '../host/src/diagnostics/graphstats-file.ts';
const help='Usage: node scripts/graph_motion.ts -o FILE\n  -o, --output FILE  SVG, PNG, JPEG, WebP, TIFF or JSON\n  -h, --help         Show help\n';
const controller=new AbortController(),stop=()=>controller.abort(new Error('Motion graph cancelled'));process.once('SIGINT',stop);process.once('SIGTERM',stop);
try{const {values,positionals}=parseArgs({allowPositionals:true,options:{output:{type:'string',short:'o'},help:{type:'boolean',short:'h'}}});if(values.help)process.stdout.write(help);else{if(positionals.length||!values.output)throw new Error(help);await writeStatsPanels(motionPlots(),values.output,controller.signal);}}catch(error){process.stderr.write((error instanceof Error?error.message:String(error))+'\n');process.exitCode=1;}finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
