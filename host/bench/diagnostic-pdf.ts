import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {temperaturePlots} from '../src/diagnostics/graph-temperature.ts';
import {motionPlots} from '../src/diagnostics/graph-motion.ts';
import {writeStatsPanels} from '../src/diagnostics/graphstats-file.ts';

const warmups=2,runs=7;
const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[Math.floor(values.length/2)],p95Ms:values[Math.ceil(values.length*.95)-1]};};
const reference=String.raw`
import sys, json, time, matplotlib, numpy
matplotlib.use('Agg')
matplotlib.rcParams['path.simplify']=False
import matplotlib.pyplot as plt
request=json.load(sys.stdin)
samples=[]
for run in range(request['warmups']+request['runs']):
 start=time.perf_counter()
 panels=request['panels']
 fig,axes=plt.subplots(nrows=len(panels),figsize=(800/72,len(panels)*600/72),squeeze=False,layout='constrained')
 for i,panel in enumerate(panels):
  ax=axes[i][0];plot=panel['plot'];ax.set_title(plot['title']);ax.set_xlabel(panel['xAxis']['label']);ax.set_ylabel(plot['axes'][0]);ax.grid(True)
  other=ax.twinx() if len(plot['axes'])>1 else None
  for curve in plot['curves']:
   target=other if curve['axis'] else ax
   target.plot(curve['times'],curve['values'],'.' if curve['style']=='points' else '-',label=curve['label'])
  if 'yRanges' in panel:
   ax.set_ylim(panel['yRanges'][0])
  ax.legend(fontsize=8,ncol=3)
 fig.savefig(request['output'],format='pdf');plt.close(fig)
 if run>=request['warmups']:samples.append((time.perf_counter()-start)*1000)
print(json.dumps({'samples':samples,'python':sys.version.split()[0],'matplotlib':matplotlib.__version__,'numpy':numpy.__version__}))
`;
const directory=await mkdtemp(join(tmpdir(),'diagnostic-pdf-bench-'));
const referencePath=fileURLToPath(new URL('../node_modules/.cache/pdf-reference/',import.meta.url));
await mkdir(join(referencePath,'mplconfig'),{recursive:true});
const results=[];
try{
 for(const [name,panels] of [['temperature-adc',temperaturePlots()],['temperature-resistance',temperaturePlots({resistance:true})],['legacy-motion',motionPlots()]] as const){
  const nodeExports:Record<string,unknown>={};
  for(const extension of ['pdf','png']){
   const file=join(directory,name+'.'+extension),samples:number[]=[];
   for(let run=0;run<warmups+runs;run++){const start=performance.now();await writeStatsPanels(panels,file,new AbortController().signal);if(run>=warmups)samples.push(performance.now()-start);}
   const bytes=(await stat(file)).size;assert.ok(bytes>1000);
   if(extension==='pdf')assert.match(execFileSync('pdfinfo',[file],{encoding:'utf8'}),/Pages:\s+1/);
   nodeExports[extension]={...stats(samples),bytes};
  }
  const python=JSON.parse(execFileSync(process.env.PDF_REFERENCE_PYTHON??'/usr/bin/python3',['-c',reference],{input:JSON.stringify({panels,warmups,runs,output:join(directory,name+'-reference.pdf')}),encoding:'utf8',maxBuffer:16*1024**2,env:{...process.env,PYTHONPATH:referencePath,MPLCONFIGDIR:join(referencePath,'mplconfig')}}));
  results.push({name,points:panels.reduce((n,p)=>n+p.plot.curves.reduce((n,c)=>n+c.values.length,0),0),nodeExports,pythonPdf:{...stats(python.samples),python:python.python,matplotlib:python.matplotlib,numpy:python.numpy}});
 }
 console.log(JSON.stringify({node:process.version,warmups,runs,results,scope:'Offline export of identical precomputed panel data with no path simplification. Node includes SVG generation, font embedding, encoding and atomic file replacement; Python includes figure creation, plotting, PDF encoding and file save. No process startup or numerical calculation. Layouts differ. Not a printer throughput or target scheduling measurement.'},null,2));
}finally{await rm(directory,{recursive:true,force:true});}
