#!/usr/bin/env node
// GPL-3.0-or-later. Scalar Motan CSV export; no Python runtime required.
import {parseArgs} from 'node:util';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {parseLiteral} from '../../host/src/diagnostics/python-literal.ts';
import {parsePythonFloat} from '../../host/src/moonraker/config-reader.ts';
import {MotanAnalysisExecutor} from '../../host/src/motan/analysis-executor.ts';
import {motanCsvChunks,writeMotanCsv} from '../../host/src/motan/csv-export.ts';
const help=`Usage: node scripts/motan/data_export.ts [options] <logname>
  -c, --columns LIST   Nonempty Python literal or JSON list of datasets
  -o, --output FILE    CSV file (atomically replaced); default stdout
  -s, --skip SEC       Start offset (default 0)
  -d, --duration SEC   Analysis duration (default 5)
  --segment-time SEC  Sampling interval (default 0.000100)
  --preserve-number-types  Preserve integer tokens in status columns (opt-in)
  -h, --help           Show help
Scalar columns and integer derivative/deviation/CoreXY are supported.
Other integer filters and structured status objects need the legacy exporter.
Mixed BigInt/Number arithmetic is rejected; stdout may be partial on failure.
Exact token mode can expose unsupported integer filters; see migration notes.
Limits: 1 million samples, 64 MiB accounted table budget, 256 MiB CSV, 60 s analysis.
`;
const controller=new AbortController(),executor=new MotanAnalysisExecutor();
const stop=()=>controller.abort(new Error('Motan CSV export cancelled'));
process.once('SIGINT',stop);process.once('SIGTERM',stop);
try{
 const {values,positionals}=parseArgs({allowPositionals:true,options:{columns:{type:'string',short:'c'},output:{type:'string',short:'o'},skip:{type:'string',short:'s'},duration:{type:'string',short:'d'},'segment-time':{type:'string'},'preserve-number-types':{type:'boolean'},help:{type:'boolean',short:'h'}}});
 if(values.help)process.stdout.write(help);
 else{
  if(positionals.length!==1||!values.columns||values.columns.length>65536)throw new Error(help);
  const columns=parseLiteral(values.columns);
  if(!Array.isArray(columns)||!columns.length||columns.length>256||columns.some(name=>typeof name!=='string'))throw new Error('Columns must be a list of dataset names');
  const names=columns as string[],result=await executor.analyze({prefix:positionals[0],datasets:names,output:'table',preserveNumberTypes:values['preserve-number-types'],
   start:values.skip===undefined?0:parsePythonFloat(values.skip),duration:values.duration===undefined?5:parsePythonFloat(values.duration),
   segmentTime:values['segment-time']===undefined?.0001:parsePythonFloat(values['segment-time']),
  },{signal:controller.signal});
  // Registration canonicalizes surrounding Python whitespace; use the same
  // canonical keys for export while retaining user order and repeated columns.
  const {pythonStrip}=await import('../../host/src/moonraker/metadata-values.ts');
  const canonical=names.map(pythonStrip),options={signal:controller.signal};
  if(values.output)await writeMotanCsv(result,canonical,values.output,options);
  else await pipeline(Readable.from(motanCsvChunks(result,canonical,options)),process.stdout,{signal:controller.signal,end:false});
 }
}catch(error){process.stderr.write((error instanceof Error?error.message:String(error))+'\n');process.exitCode=1;}
finally{await executor.close();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
