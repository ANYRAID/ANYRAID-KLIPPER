#!/usr/bin/env node
// GPL-3.0-or-later. Independent Node 26 diagnostic process.
import {parseArgs} from 'node:util';
import {extruderPlot} from '../host/src/diagnostics/graph-extruder.ts';
import {writeStatsPlot} from '../host/src/diagnostics/graphstats-file.ts';
const help='Usage: node scripts/graph_extruder.ts -o FILE\n  -o, --output FILE  SVG, PNG, JPEG, WebP, TIFF or JSON\n  -h, --help         Show help\n';
const controller=new AbortController(),stop=()=>controller.abort(new Error('Extruder graph cancelled'));process.once('SIGINT',stop);process.once('SIGTERM',stop);
try{const {values,positionals}=parseArgs({allowPositionals:true,options:{output:{type:'string',short:'o'},help:{type:'boolean',short:'h'}}});if(values.help)process.stdout.write(help);else{if(positionals.length||!values.output)throw new Error(help);await writeStatsPlot(extruderPlot(),values.output,controller.signal,{label:'Time (s)',format:'number'});}}catch(error){process.stderr.write((error instanceof Error?error.message:String(error))+'\n');process.exitCode=1;}finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
