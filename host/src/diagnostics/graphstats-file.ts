import {createReadStream} from 'node:fs';
import {open,rename,rm} from 'node:fs/promises';
import {dirname,basename,join,extname} from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {renderInteractivePlot} from './interactive-plot.ts';
import {StatsLogParser,type StatsSample,type StatsPlot} from './graphstats.ts';
import {renderStatsSvg,renderStatsPanels,type PlotXAxis,type StatsPanel} from './stats-svg.ts';
export async function readStatsFile(filename:string,mcu:string|undefined,signal:AbortSignal):Promise<readonly StatsSample[]>{
 const parser=new StatsLogParser(mcu),decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});let pending='',bytes=0;
 const consume=(final=false)=>{let start=0;for(let i=0;i<pending.length;i++){if(pending[i]!=='\r'&&pending[i]!=='\n')continue;if(pending[i]==='\r'&&i===pending.length-1&&!final)break;parser.line(pending.slice(start,i));if(pending[i]==='\r'&&pending[i+1]==='\n')i++;start=i+1;}pending=pending.slice(start);if(pending.length>1024**2)throw new RangeError('Statistics line limit exceeded');};
 for await(const chunk of createReadStream(filename,{highWaterMark:65536,signal})){bytes+=(chunk as Buffer).length;if(bytes>512*1024**2)throw new RangeError('Statistics file limit exceeded');pending+=decoder.decode(chunk as Buffer,{stream:true});consume();}
 pending+=decoder.decode();consume(true);if(pending)parser.line(pending);signal.throwIfAborted();return parser.samples();
}
export async function writeStatsPlot(plot:StatsPlot,filename:string,signal:AbortSignal,xAxis?:PlotXAxis):Promise<void>{
 await writePlotDocument(plot,()=>renderStatsSvg(plot,xAxis),filename,signal);
}
export async function writeStatsPanels(panels:readonly StatsPanel[],filename:string,signal:AbortSignal):Promise<void>{
 if(!panels.length||panels.length>8)throw new RangeError('Expected 1 to 8 plot panels');
 await writePlotDocument(panels,()=>renderStatsPanels(panels),filename,signal);
}
export async function writePlotDocument(document:unknown,render:()=>string|Promise<string>,filename:string,signal:AbortSignal):Promise<void>{
 const extension=extname(filename).toLowerCase();if(!['.html','.pdf','.svg','.png','.jpg','.jpeg','.webp','.tif','.tiff','.json'].includes(extension))throw new Error('Supported outputs: HTML, PDF, SVG, PNG, JPEG, WebP, TIFF and JSON');signal.throwIfAborted();let bytes:Buffer;
 if(extension==='.json')bytes=Buffer.from(JSON.stringify(document));else{const svg=Buffer.from(await render());if(extension==='.html')bytes=Buffer.from(renderInteractivePlot(svg.toString('utf8')));else if(extension==='.svg')bytes=svg;else if(extension==='.pdf'){const {diagnosticPdf}=await import('./diagnostic-pdf.ts');bytes=await diagnosticPdf(svg.toString('utf8'),signal);}else{const image=sharp(svg,{limitInputPixels:16*1024**2});bytes=await (extension==='.png'?image.png():extension==='.webp'?image.webp():['.tif','.tiff'].includes(extension)?image.tiff():image.jpeg()).toBuffer();}}
 await writeDiagnosticBytes(bytes,filename,signal);
}
export async function writeDiagnosticText(text:string,filename:string,signal:AbortSignal):Promise<void>{signal.throwIfAborted();if(Buffer.byteLength(text)>64*1024**2)throw new RangeError('Diagnostic output limit exceeded');await writeDiagnosticBytes(Buffer.from(text),filename,signal);}
async function writeDiagnosticBytes(bytes:Buffer,filename:string,signal:AbortSignal):Promise<void>{
 if(bytes.length>64*1024**2)throw new RangeError('Statistics output limit exceeded');signal.throwIfAborted();const temp=join(dirname(filename),`.${basename(filename)}.${randomUUID()}.tmp`);let owned=false;try{const file=await open(temp,'wx',0o600);owned=true;try{await file.writeFile(bytes,{signal});}finally{await file.close();}signal.throwIfAborted();await rename(temp,filename);}finally{if(owned)await rm(temp,{force:true});}
}
