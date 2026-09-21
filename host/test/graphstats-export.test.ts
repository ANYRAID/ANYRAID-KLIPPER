import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import sharp from 'sharp';
import {readStatsFile,writeStatsPlot} from '../src/diagnostics/graphstats-file.ts';
import {renderStatsSvg} from '../src/diagnostics/stats-svg.ts';
import {parseStats,mcuStatsPlot,systemStatsPlot,frequencyStatsPlot,temperatureStatsPlot} from '../src/diagnostics/graphstats.ts';
import {graphstatsFixture} from '../bench/graphstats-reference.ts';
const signal=new AbortController().signal,script=fileURLToPath(new URL('../../scripts/graphstats.ts',import.meta.url));
test('SVG preserves lines, point plots, dual axes and escapes untrusted labels',()=>{
 const data=parseStats(graphstatsFixture(50));for(const plot of [mcuStatsPlot(data),systemStatsPlot(data),frequencyStatsPlot(data),temperatureStatsPlot(data,'heater')]){const svg=renderStatsSvg(plot);assert.match(svg,/Time \(UTC\)/);assert.match(svg,/<clipPath/);assert.equal((svg.match(/<circle/g)??[]).length,plot.curves.filter(c=>c.style==='points').reduce((n,c)=>n+c.times.length,0));}
 const plot=systemStatsPlot(data);plot.title='<script>alert(1)</script>';plot.curves[0].label='" & <label>';const svg=renderStatsSvg(plot);assert.equal(svg.includes('<script>'),false);assert.match(svg,/&lt;script&gt;/);assert.match(svg,/&quot; &amp; &lt;label&gt;/);
 assert.throws(()=>renderStatsSvg({...plot,curves:[{label:'invalid',axis:0,style:'line',times:[1],values:[Infinity]}]}),/coordinates/);
});
test('streaming reader matches parser across CRLF boundaries and rejects oversized or invalid UTF-8 lines',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'stats-input-'));try{const path=join(dir,'log'),text='x'.repeat(65535)+'\r\n'+graphstatsFixture(30).replaceAll('\n','\r');await writeFile(path,text);assert.deepEqual(await readStatsFile(path,undefined,signal),parseStats(text));await writeFile(path,Buffer.from([0xc0,0xaf]));await assert.rejects(readStatsFile(path,undefined,signal));await writeFile(path,'x'.repeat(1024**2+1));await assert.rejects(readStatsFile(path,undefined,signal),/line limit/);const aborted=new AbortController();aborted.abort();await assert.rejects(readStatsFile(path,undefined,aborted.signal));}finally{await rm(dir,{recursive:true,force:true});}
});
test('CLI exports each graph mode with exact JSON curves and raster formats decode successfully',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'stats-cli-'));try{const text=graphstatsFixture(50),input=join(dir,'log with spaces.txt'),data=parseStats(text);await writeFile(input,text);const cases:[string[],unknown][]=[[[],mcuStatsPlot(data)],[['-s'],systemStatsPlot(data)],[['-f'],frequencyStatsPlot(data)],[['-f','-m','mcu'],frequencyStatsPlot(data,'mcu')],[['-t','heater'],temperatureStatsPlot(data,'heater')]];
  for(const [args,expected] of cases){const output=join(dir,'plot.json');execFileSync(process.execPath,[script,input,...args,'-o',output]);assert.deepEqual(JSON.parse(await readFile(output,'utf8')),expected);}
  const plot=systemStatsPlot(data);for(const extension of ['png','jpg','webp','tiff']){const output=join(dir,'plot.'+extension);await writeStatsPlot(plot,output,signal);const metadata=await sharp(output).metadata();assert.equal(metadata.width,800);assert.equal(metadata.height,600);const pixels=await sharp(output).raw().toBuffer();assert.ok(pixels.some(value=>value<100));}
  const svg=join(dir,'plot.svg');await writeStatsPlot(plot,svg,signal);assert.match(await readFile(svg,'utf8'),/<svg/);assert.equal((await readdir(dir)).some(name=>name.endsWith('.tmp')),false);assert.match(execFileSync(process.execPath,[script,'--help'],{encoding:'utf8'}),/Usage:/);assert.equal(spawnSync(process.execPath,[script,input,'-o',input]).status,1);assert.equal(await readFile(input,'utf8'),text);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('failed or cancelled export preserves prior output and empty logs create no artifact',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'stats-failed-'));try{const output=join(dir,'old.png');await writeFile(output,'old');const controller=new AbortController();controller.abort();await assert.rejects(writeStatsPlot(mcuStatsPlot(parseStats(graphstatsFixture(4))),output,controller.signal));assert.equal(await readFile(output,'utf8'),'old');const input=join(dir,'empty.log');await writeFile(input,'nothing to graph');execFileSync(process.execPath,[script,input,'-o',join(dir,'empty.svg')]);assert.equal((await readdir(dir)).includes('empty.svg'),false);await assert.rejects(writeStatsPlot(systemStatsPlot(parseStats(graphstatsFixture(4))),join(dir,'unsupported.pdf'),signal),/Supported outputs/);}finally{await rm(dir,{recursive:true,force:true});}
});
