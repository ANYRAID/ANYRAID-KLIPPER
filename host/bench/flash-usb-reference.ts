import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import type {UsbFlashOptions,UsbFlashIO} from '../src/diagnostics/flash-usb.ts';
export function flashRecorder(katapult=false){const events:unknown[][]=[];const io:UsbFlashIO={async serialPaths(device){events.push(['serial',device]);return {tty:'/dev/ttyMock',stable:'/dev/serial/by-path/mock'};},async usbPath(device){events.push(['usb',device]);return {busPath:'1-2.3',devicePath:'/sys/mock/interface'};},async enterBootloader(device){events.push(['boot',device]);},async waitPath(path,alternative){events.push(['wait',path,alternative??null]);return path;},async isKatapult(path){events.push(['detect',path]);return katapult;},async readText(path){events.push(['read',path]);return path.endsWith('busnum')?'001\n':'023\n';},async run(command){events.push(['run',[...command]]);},async katapult(device,image){events.push(['katapult',device,image]);}};return {io,events};}
const source=String.raw`
import sys,runpy,json,types,io,time
r=runpy.run_path(sys.argv[1]);request=json.load(sys.stdin);g=r['flash_bossac'].__globals__;results=[]
def event(name,*args):events.append([name,*args])
def serial(d):event('serial',d);return '/dev/ttyMock','/dev/serial/by-path/mock'
def usb(d):event('usb',d);return '1-2.3','/sys/mock/interface'
def wait(p,a=None):event('wait',p,a);return p
def detect(p):event('detect',p);return case.get('katapult',False)
def read(p):event('read',p);return io.StringIO('001\n' if p.endswith('busnum') else '023\n')
def call(args,**kwargs):event('run',args);return 0
g.update(translate_serial_to_tty=serial,translate_serial_to_usb_path=usb,enter_bootloader=lambda d:event('boot',d),wait_path=wait,detect_canboot=detect,call_flashcan=lambda d,f:event('katapult',d,f),open=read)
g['subprocess']=types.SimpleNamespace(call=call,check_output=call,STDOUT=None,CalledProcessError=RuntimeError);g['sys']=types.SimpleNamespace(stderr=io.StringIO())
for case in request['cases']:
 options=types.SimpleNamespace(mcutype=case['mcu'],device=case['device'],start=case.get('start'),sudo=case.get('sudo',True));func=next(f for prefix,f in r['MCUTYPES'].items() if options.mcutype.startswith(prefix));samples=[]
 for i in range(request.get('runs',1)):
  events=[];at=time.perf_counter();func(options,case['image']);samples.append((time.perf_counter()-at)*1000)
 results.append(dict(events=events,samples=samples))
print(json.dumps(dict(python=sys.version.split()[0],results=results)))
`;
export function flashReference(cases:(UsbFlashOptions&{katapult?:boolean})[],runs=1):{python:string;results:{events:unknown[][];samples:number[]}[]}{return JSON.parse(execFileSync(process.env.PYTHON??'/usr/bin/python3',['-c',source,fileURLToPath(new URL('../../scripts/flash_usb.py',import.meta.url))],{input:JSON.stringify({cases,runs}),encoding:'utf8',maxBuffer:8*1024**2}));}
