#!/usr/bin/env node
// GPL-3.0-or-later. Scalar Motan CSV export; no Python runtime required.
import {parseArgs} from 'node:util';
import {formatMotanDatasets} from '../../host/src/motan/dataset-catalog.ts';
const help=`Usage: node scripts/motan/data_export.ts [options] <logname>
  -c, --columns LIST   Nonempty Python literal or JSON list of datasets
  -o, --output FILE    CSV file (atomically replaced); default stdout
  -s, --skip SEC       Start offset (default 0)
  -d, --duration SEC   Analysis duration (default 5)
  --segment-time SEC  Sampling interval (default 0.000100)
  --preserve-number-types  Preserve integer tokens in status columns (opt-in)
  -l, --list-datasets  List dataset syntax without opening a capture
  -h, --help           Show help
Scalar columns and integer derivative/deviation/CoreXY/norm2/smooth/integral/SOS are supported.
Structured status objects still need the legacy exporter.
Mixed arithmetic requires known input types (--preserve-number-types for status).
Unannotated raw sensor columns still reject ambiguous mixed arithmetic.
SOS integers must fit NumPy int64/uint64; see migration notes.
Stdout may be partial on failure; see migration notes.
Limits: 1 million samples, 64 MiB accounted table budget, 256 MiB CSV, 60 s analysis.
`;
const controller=new AbortController();let executor:import('../../host/src/motan/analysis-executor.ts').MotanAnalysisExecutor|undefined;
const stop=()=>controller.abort(new Error('Motan CSV export cancelled'));
process.once('SIGINT',stop);process.once('SIGTERM',stop);
try{
 const {values,positionals}=parseArgs({allowPositionals:true,options:{columns:{type:'string',short:'c'},output:{type:'string',short:'o'},skip:{type:'string',short:'s'},duration:{type:'string',short:'d'},'segment-time':{type:'string'},'preserve-number-types':{type:'boolean'},'list-datasets':{type:'boolean',short:'l'},help:{type:'boolean',short:'h'}}});
 let start=0,duration=5,segmentTime=.0001;
 // optparse validates supplied numeric options even for a catalog request.
 if(!values.help&&(values.skip!==undefined||values.duration!==undefined||values['segment-time']!==undefined)){
  const {parsePythonFloat}=await import('../../host/src/moonraker/config-reader.ts');
  if(values.skip!==undefined)start=parsePythonFloat(values.skip);
  if(values.duration!==undefined)duration=parsePythonFloat(values.duration);
  if(values['segment-time']!==undefined)segmentTime=parsePythonFloat(values['segment-time']);
 }
 if(values.help)process.stdout.write(help);
 else if(values['list-datasets'])process.stdout.write(formatMotanDatasets());
 else{
  if(positionals.length!==1||!values.columns||values.columns.length>65536)throw new Error(help);
  const [{Readable},{pipeline},{parseLiteral},{MotanAnalysisExecutor},{motanCsvChunks,writeMotanCsv}]=await Promise.all([
   import('node:stream'),import('node:stream/promises'),import('../../host/src/diagnostics/python-literal.ts'),import('../../host/src/motan/analysis-executor.ts'),import('../../host/src/motan/csv-export.ts'),
  ]);
  executor=new MotanAnalysisExecutor();
  const columns=parseLiteral(values.columns);
  if(!Array.isArray(columns)||!columns.length||columns.length>256||columns.some(name=>typeof name!=='string'))throw new Error('Columns must be a list of dataset names');
  const names=columns as string[],result=await executor.analyze({prefix:positionals[0],datasets:names,output:'table',preserveNumberTypes:values['preserve-number-types'],
   start,duration,segmentTime,
  },{signal:controller.signal});
  // Registration canonicalizes surrounding Python whitespace; use the same
  // canonical keys for export while retaining user order and repeated columns.
  const {pythonStrip}=await import('../../host/src/moonraker/metadata-values.ts');
  const canonical=names.map(pythonStrip),options={signal:controller.signal};
  if(values.output)await writeMotanCsv(result,canonical,values.output,options);
  else await pipeline(Readable.from(motanCsvChunks(result,canonical,options)),process.stdout,{signal:controller.signal,end:false});
 }
}catch(error){process.stderr.write((error instanceof Error?error.message:String(error))+'\n');process.exitCode=1;}
finally{await executor?.close();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
