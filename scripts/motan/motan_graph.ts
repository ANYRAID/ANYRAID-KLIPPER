#!/usr/bin/env node
// GPL-3.0-or-later. Offline motion graphs, powered by the Node analysis worker.
import {parseArgs} from 'node:util';
import {resolve,extname} from 'node:path';
import {formatMotanDatasets} from '../../host/src/motan/dataset-catalog.ts';
import {parseMotanGraphs,motanGraphDatasets,motanGraphPanels} from '../../host/src/motan/graph.ts';
import {validateMotanGraphStyles,renderMotanGraph} from '../../host/src/motan/graph-render.ts';
import {parsePythonFloat} from '../../host/src/moonraker/config-reader.ts';
const help='Usage: node scripts/motan/motan_graph.ts [-g GRAPH] [-s START] [-d SECONDS] [--segment-time SEC] -o OUTPUT PREFIX\n  GRAPH: Python literal or JSON list of graph rows; defaults to velocity, acceleration and step deviation.\n  OUTPUT: HTML, PDF, SVG, PNG, JPEG, WebP, TIFF or full JSON; required.\n  Styles: color/c (hex, basic names, shorthand, tab colors), alpha, label, linewidth/lw, linestyle/ls, marker (none, . or o), markersize/ms.\n  -l, --list-datasets: dataset catalog; -h, --help: help.\n  Numeric datasets only. No desktop plotting window. Analysis timeout: 60 s.\n';
const controller=new AbortController(),stop=()=>controller.abort(new Error('Motan graph cancelled'));
let executor:import('../../host/src/motan/analysis-executor.ts').MotanAnalysisExecutor|undefined;
process.once('SIGINT',stop);process.once('SIGTERM',stop);
try{
 const {values,positionals}=parseArgs({allowPositionals:true,options:{output:{type:'string',short:'o'},graph:{type:'string',short:'g'},skip:{type:'string',short:'s'},duration:{type:'string',short:'d'},'segment-time':{type:'string'},'list-datasets':{type:'boolean',short:'l'},help:{type:'boolean',short:'h'}}});
 if(values.help)process.stdout.write(help);
 else{
  const start=values.skip===undefined?0:parsePythonFloat(values.skip),duration=values.duration===undefined?5:parsePythonFloat(values.duration),segmentTime=values['segment-time']===undefined?.0001:parsePythonFloat(values['segment-time']);
  if(values['list-datasets'])process.stdout.write(formatMotanDatasets());
  else{
   if(positionals.length!==1||!values.output)throw new Error(help);
   if(!['.html','.pdf','.svg','.png','.jpg','.jpeg','.webp','.tif','.tiff','.json'].includes(extname(values.output).toLowerCase()))throw new Error('Unsupported graph output format');
   const prefix=positionals[0],output=resolve(values.output);
   if([prefix+'.json.gz',prefix+'.index.gz'].some(path=>resolve(path)===output))throw new Error('Output must not replace a Motan capture');
   const graphs=parseMotanGraphs(values.graph);validateMotanGraphStyles(graphs);
   const {MotanAnalysisExecutor}=await import('../../host/src/motan/analysis-executor.ts');
   const {writePlotDocument}=await import('../../host/src/diagnostics/graphstats-file.ts');
   executor=new MotanAnalysisExecutor();
   const result=await executor.analyze({prefix,datasets:motanGraphDatasets(graphs),start,duration,segmentTime},{signal:controller.signal});
   const panels=motanGraphPanels(result,graphs,prefix);
   await writePlotDocument(panels,()=>renderMotanGraph(panels),output,controller.signal);
  }
 }
}catch(error){process.stderr.write((error instanceof Error?error.message:String(error))+'\n');process.exitCode=1;}
finally{await executor?.close();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
