import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {parseMotanGraphs,motanGraphPanels} from '../src/motan/graph.ts';
import {renderMotanGraph} from '../src/motan/graph-render.ts';
import {motanMarkers} from '../src/motan/markers.ts';
import sharp from 'sharp';
const count=20000,analysis={times:Float64Array.from({length:count},(_,i)=>i/100),datasets:{a:Float64Array.from({length:count},(_,i)=>Math.sin(i/100))},labels:{a:{name:'a',label:'A',units:'mm'}}},results=[];
for(const style of ['marker=none','marker=s&fillstyle=left&mfc=red&mfcalt=blue']){
 const panels=motanGraphPanels(analysis,parseMotanGraphs(`[['a?${style}']]`),'benchmark'),samples:number[]=[];let bytes=0;
 for(let i=0;i<16;i++){const begin=performance.now(),svg=renderMotanGraph(panels),elapsed=performance.now()-begin;if(i>=5)samples.push(elapsed);bytes=Buffer.byteLength(svg);assert.equal((svg.match(/<use /g)||[]).length,style==='marker=none'?0:2*(count+1));}
 samples.sort((a,b)=>a-b);results.push({style,points:count,bytes,medianMs:samples[5],p95Ms:samples[10]});
}
const names=motanMarkers.filter(m=>!['none','None','',' '].includes(m)),times=Float64Array.of(0,1,2),datasets=Object.fromEntries(names.map((_,i)=>['m'+i,Float64Array.of(i%5,i%5,i%5)])),labels=Object.fromEntries(names.map((m,i)=>['m'+i,{name:'m'+i,label:'marker '+m,units:'marker family'}]));
const graphs=Array.from({length:5},(_,row)=>names.slice(row*5,row*5+5).map((m,j)=>`m${row*5+j}?marker=${encodeURIComponent(m)}&ms=16&fillstyle=left&mfc=red&mfcalt=blue&mec=black&ls=none`));
const svg=renderMotanGraph(motanGraphPanels({times,datasets,labels},parseMotanGraphs(JSON.stringify(graphs)),'Standard markers; left fill'));
await writeFile('/tmp/motan-marker-gallery.svg',svg);await sharp(Buffer.from(svg)).png().toFile('/tmp/motan-marker-gallery.png');
console.log(JSON.stringify({node:process.version,warmups:5,runs:11,results,scope:'SVG construction with existing numeric panels; excludes analysis, raster encoding and printing. No Python render performance claim.'},null,2));
