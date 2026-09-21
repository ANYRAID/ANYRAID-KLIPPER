#!/usr/bin/env node
// GPL-3.0-or-later. Offline bed-mesh analysis; no device configuration writes.
import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {readMeshDump} from '../host/src/diagnostics/mesh-file.ts';
import {analyzeMeshDump,formatMeshReport} from '../host/src/diagnostics/mesh-report.ts';
import {writeDiagnosticText} from '../host/src/diagnostics/graphstats-file.ts';
const help='Usage: node scripts/graph_mesh.ts analyze [--json] [-o REPORT.json] INPUT.json\nAnalyze a local bed_mesh/dump_mesh snapshot. -o preserves full precision JSON.\nSocket/WebSocket acquisition, plots and animation are not yet supported.\n';
const controller=new AbortController(),stop=()=>controller.abort(new Error('Mesh analysis cancelled'));process.once('SIGINT',stop);process.once('SIGTERM',stop);
try{const {values,positionals}=parseArgs({allowPositionals:true,options:{output:{type:'string',short:'o'},json:{type:'boolean'},help:{type:'boolean',short:'h'}}});if(values.help)process.stdout.write(help);else{if(positionals.length!==2||positionals[0]!=='analyze')throw new Error(help);if(values.output!==undefined&&(!values.output||resolve(values.output)===resolve(positionals[1])))throw new Error('Output must not replace input');const report=analyzeMeshDump(await readMeshDump(positionals[1],controller.signal)),json=JSON.stringify(report,null,2)+'\n';if(values.output)await writeDiagnosticText(json,values.output,controller.signal);process.stdout.write(values.json?json:formatMeshReport(report));}}catch(error){process.stderr.write((error instanceof Error?error.message:String(error))+'\n');process.exitCode=1;}finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
