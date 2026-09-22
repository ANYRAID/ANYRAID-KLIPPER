import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {encodeMotanJson} from '../../src/motan/capture.ts';
import type {StepBlock,TrapMove,TrapSelection} from '../../src/motan/motion-samples.ts';
export const sourceHash='f89b7eff1f4592399d9eb9ad0f679d894cb9a0d2a40a79f81f48d139c16e9ca2';
export interface MotionCase {blocks:StepBlock[];moves:TrapMove[][];times:number[];smooth:number;selection:TrapSelection;}
export function motionCase(count=600):MotionCase{
 const blocks:StepBlock[]=[],moves:TrapMove[][]=[];let position=.123;
 for(let b=0;b<4;b++){const n=Math.min(count,65535),first=9007199254740993n+BigInt(b)*100000000n,span=BigInt(100*(n-1)+n*(n-1)/2+150*n),start=1+b*2;blocks.push({first_clock:first,last_clock:first+span,first_step_time:start,last_step_time:start+.8,step_distance:.0125,start_position:position,start_mcu_position:-(1n<<80n)+BigInt(b),data:[[100,n,1],[150,-n,0]]});position+=.25;moves.push([[start,.75,20,30,[position,-.2,3],[.6,-.8,0]],[start+.75,.25,42.5,-30,[position+15,2,3],[-.6,.8,0]]]);}
 const times=Array.from({length:10001},(_,i)=>i/1000);return {blocks,moves,times,smooth:.01,selection:'x'};
}
export function oracle(input:MotionCase,benchmark=false):{step:number[];trap:number[];decoded:number[][];phases:number[];ms:number[]}{
 const source=execFileSync('git',['show','2c7ba578:scripts/motan/readlog.py']);if(createHash('sha256').update(source).digest('hex')!==sourceHash)throw new Error('Motan oracle source hash mismatch');
 const script=`import json,sys,time,statistics\nscope={}\nexec(${JSON.stringify(source.toString())},scope)\nx=json.load(sys.stdin)\n# trapq wire fields originate as C doubles, including integral-valued fields.\nx['moves']=[[[*[float(v) for v in m[:4]],*[list(map(float,v)) for v in m[4:]]] for m in block] for block in x['moves']]\nclass Dispatch:\n def __init__(self,values): self.values=iter(values)\n def pull_msg(self,*args): return next(self.values,None)\nclass Manager:\n def __init__(self,values): self.dispatch=Dispatch(values)\n def get_jdispatch(self): return self.dispatch\ndef run():\n s=scope['HandleStepQ'](Manager(x['blocks']),'s',['stepq','s',str(x['smooth'])])\n t=scope['HandleTrapQ'](Manager([{'data':m} for m in x['moves']]),'t',['trapq','t',x['selection']])\n return [s.pull_data(v) for v in x['times']],[t.pull_data(v) for v in x['times']]\na,b=run()\nd=scope['HandleStepQ'](Manager(x['blocks']),'s',['stepq','s'])\nd._pull_block(0)\ndecoded=d.step_data[1:]\nphases=[]\npos=x['blocks'][0]['start_mcu_position']\nfor interval,count,add in x['blocks'][0]['data']:\n for i in range(abs(count)):\n  pos+=1 if count>=0 else -1\n  phases.append((pos-9007199254740997)%1024)\nms=[]\nif ${benchmark?'True':'False'}:\n for i in range(9):\n  start=time.perf_counter();run();elapsed=(time.perf_counter()-start)*1000\n  if i>=2: ms.append(elapsed)\nprint(json.dumps(dict(step=a,trap=b,decoded=decoded,phases=phases,ms=ms)))`;
 return JSON.parse(execFileSync('python3',['-c',script],{input:encodeMotanJson(input),encoding:'utf8',maxBuffer:64*1024*1024}));
}
