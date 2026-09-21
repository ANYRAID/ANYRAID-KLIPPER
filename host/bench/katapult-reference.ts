import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {katapultFrame,type KatapultTransport} from '../src/diagnostics/katapult.ts';
export function katapultSimulator(blockSize=64,start=0x8004000){
 const frames:Buffer[]=[],memory=new Map<number,Buffer>();
 const transport:KatapultTransport={async exchange(frame){
  frames.push(Buffer.from(frame));const cmd=frame[2],p=frame.subarray(4,-4);let response=Buffer.alloc(0);
  if(cmd===0x11){response=Buffer.alloc(28);response.set([0,1,1,0]);response.writeUInt32LE(start,4);response.writeUInt32LE(blockSize,8);response.write('stm32f407\0test',12);}
  else if(cmd===0x12){memory.set(p.readUInt32LE(),Buffer.from(p.subarray(4)));response=Buffer.from(p.subarray(0,4));}
  else if(cmd===0x13){response=Buffer.alloc(4);response.writeUInt32LE(memory.size);}
  else if(cmd===0x14)response=Buffer.concat([p,memory.get(p.readUInt32LE())!]);
  else if(cmd===0x16)response=Buffer.from('1122334455660000','hex');
  else if(cmd!==0x15)throw new Error('Unexpected mock command');
  const echoed=Buffer.alloc(4);echoed.writeUInt32LE(cmd);return katapultFrame(0xa0,Buffer.concat([echoed,response]));
 }};
 return {transport,frames,memory};
}
export function katapultReference(image:Uint8Array,blockSize:number,runs=1):{frames:string[];sha1:string;samples:number[];python:string}{
 return JSON.parse(execFileSync(process.env.PYTHON??'/usr/bin/python3',['-c',String.raw`
import runpy,sys,json,struct,asyncio,tempfile,pathlib,contextlib,io,time
r=runpy.run_path(sys.argv[1]);q=json.load(sys.stdin);F=r['CanFlasher'];samples=[]
class Node:
 def write(self,frame):
  frames.append(frame.hex());cmd=frame[2];p=frame[4:-4];reply=b''
  if cmd==0x11:reply=struct.pack('<4sII',bytes([0,1,1,0]),0x8004000,q['blockSize'])+b'stm32f407\0test\0\0'
  elif cmd==0x12:memory[struct.unpack('<I',p[:4])[0]]=p[4:];reply=p[:4]
  elif cmd==0x13:reply=struct.pack('<I',len(memory))
  elif cmd==0x14:reply=p+memory[struct.unpack('<I',p)[0]]
  elif cmd!=0x15:raise Exception('Unexpected command')
  assert len(reply)%4==0
  self.reply=F._build_command(None,0xa0,struct.pack('<I',cmd)+reply)
 async def readuntil(self,*args):return self.reply
async def main(path):
 global frames,memory,sha
 for i in range(q['runs']):
  frames=[];memory={};f=F(Node(),path);at=time.perf_counter()
  await f.connect_btl();await f.send_file();await f.verify_file();await f.finish()
  samples.append((time.perf_counter()-at)*1000);sha=f.fw_sha.hexdigest()
with tempfile.TemporaryDirectory() as directory:
 p=pathlib.Path(directory)/'firmware.bin';p.write_bytes(bytes.fromhex(q['image']))
 with contextlib.redirect_stdout(io.StringIO()):asyncio.run(main(p))
print(json.dumps(dict(frames=frames,sha1=sha,samples=samples,python=sys.version.split()[0])))
`,fileURLToPath(new URL('../../lib/katapult/flashtool.py',import.meta.url))],{input:JSON.stringify({image:Buffer.from(image).toString('hex'),blockSize,runs}),encoding:'utf8',timeout:30000,maxBuffer:16*1024**2}));
}
