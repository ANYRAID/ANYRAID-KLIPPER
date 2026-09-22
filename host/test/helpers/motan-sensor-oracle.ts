import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {encodeMotanJson} from '../../src/motan/capture.ts';
import type {SensorBlock,SensorSelection} from '../../src/motan/sensor-samples.ts';
export interface SensorCase {selection:SensorSelection;blocks:SensorBlock[];times:number[];settings:Record<string,unknown>;}
export function sensorCase(selection:SensorSelection,rows=1000):SensorCase{
 const blocks:SensorBlock[]=[];for(let b=0;b<4;b++){const data=[];for(let i=0;i<rows;i++){const t=1+b+i/rows;data.push(selection==='angle'?[t,9007199254740993n+BigInt(b*rows+i)*3n]:['frequency','period','height'].includes(selection)?[t,3000000+Math.sin(t)*100,2+Math.cos(t)/10]:[t,Math.sin(t)*1000,Math.cos(t)*300,9.8]);}blocks.push({data,position_offset:b/10});}
 return {selection,blocks,times:Array.from({length:10000},(_,i)=>1.001+i/2000),settings:{'angle s':{stepper:'stepper_x'},stepper_x:{rotation_distance:40,gear_ratio:'80:20, 3:1'}}};
}
export function sensorOracle(input:SensorCase,bench=false):{values:number[];ms:number[]}{
 const source=execFileSync('git',['show','2c7ba578:scripts/motan/readlog.py']);if(createHash('sha256').update(source).digest('hex')!=='f89b7eff1f4592399d9eb9ad0f679d894cb9a0d2a40a79f81f48d139c16e9ca2')throw new Error('Motan source changed');const kinds={x:['HandleAccelerometer','accelerometer','x'],y:['HandleAccelerometer','accelerometer','y'],z:['HandleAccelerometer','accelerometer','z'],angle:['HandleAngle','angle'],frequency:['HandleEddyCurrent','ldc1612'],period:['HandleEddyCurrent','ldc1612','period'],height:['HandleEddyCurrent','ldc1612','z'],force:['HandleLoadCell','loadcell'],counts:['HandleLoadCell','loadcell','counts']},kind=kinds[input.selection];
 const script=`import json,sys,time\nscope={}\nexec(${JSON.stringify(source.toString())},scope)\nx=json.load(sys.stdin)\nclass Manager:\n def __init__(self): self.blocks=iter(x['blocks'])\n def get_jdispatch(self): return self\n def get_initial_status(self): return {'configfile':{'settings':x['settings']}}\n def pull_msg(self,*args): return next(self.blocks,None)\ndef run():\n h=scope[${JSON.stringify(kind[0])}](Manager(),'s',${JSON.stringify([kind[1],'s',...kind.slice(2)])})\n return [h.pull_data(t) for t in x['times']]\nvalues=run();ms=[]\nif ${bench?'True':'False'}:\n for i in range(9):\n  start=time.perf_counter();run();elapsed=(time.perf_counter()-start)*1000\n  if i>=2: ms.append(elapsed)\nprint(json.dumps(dict(values=values,ms=ms)))`;
 return JSON.parse(execFileSync('python3',['-c',script],{input:encodeMotanJson(input),encoding:'utf8',maxBuffer:16*1024**2}));
}
