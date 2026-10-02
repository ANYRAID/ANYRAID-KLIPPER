import test from 'node:test';
import assert from 'node:assert/strict';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {readMCUUARTConfiguration} from '../src/config/mcu-uart.ts';
import {configuredUARTConnections} from '../src/runtime/configured-uart.ts';
import {MCUGroup} from '../src/runtime/mcu-group.ts';
import {ptyPair} from './helpers/pty.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
const reader=(sections:Record<string,Record<string,string>>)=>new ConfigurationReader(new ConfigurationSource('/uart.cfg',sections,[]),null);
test('UART config maps primary and secondary names with exact baud defaults',()=>{
 const r=reader({'mcu aux':{serial:'/dev/serial/../ttyUSB1',baud:'115200'},mcu:{serial:'/dev/ttyUSB0'}}),plans=readMCUUARTConfiguration(r);
 assert.deepEqual(plans,[{id:'aux',section:'mcu aux',path:'/dev/ttyUSB1',baud:115200},{id:'mcu',section:'mcu',path:'/dev/ttyUSB0',baud:250000}]);assert(Object.isFrozen(plans));assert(Object.isFrozen(plans[0]));
});
test('UART config rejects unsupported transports, duplicate identities and invalid rates',()=>{
 for(const sections of [
  {},{'mcu aux':{serial:'/dev/a'}},{mcu:{serial:'/dev/a'},'mcu mcu':{serial:'/dev/b'}},
  {mcu:{serial:'/dev/a'},'mcu aux':{serial:'/dev/../dev/a'}},{mcu:{serial:'relative'}},
  {mcu:{serial:'/tmp/klipper_host_mcu'}},{mcu:{serial:'/dev/rpmsg_pru30'}},
  {mcu:{serial:'/dev/a',canbus_uuid:'abc'}},{mcu:{serial:'/dev/a',baud:'2399'}},{mcu:{serial:'/dev/a',baud:'4000001'}},
 ] as Record<string,Record<string,string>>[])assert.throws(()=>readMCUUARTConfiguration(reader(sections)));
});
test('UART factory requires exact explicit safety policy before any connection',()=>{
 const r=reader({mcu:{serial:'/nonexistent/uart'}}),policy={stopDevice:async()=>{},rts:true,leaveBootloader:false};
 assert.throws(()=>configuredUARTConnections(r,new Map()),/cover/);
 assert.throws(()=>configuredUARTConnections(r,new Map([['other',policy]])),/cover/);
 assert.throws(()=>configuredUARTConnections(r,new Map([['mcu',{...policy,rts:undefined as unknown as boolean}]])),/explicit/);
 const connections=configuredUARTConnections(r,new Map([['mcu',policy]]));assert(Object.isFrozen(connections));assert.equal(connections[0].id,'mcu');
});
test('configured UART opens actual PTYs and retains its captured safety callbacks',async()=>{
 const pairs=[ptyPair(),ptyPair()],firmware=await Promise.all(pairs.map(p=>serialFirmware(p))),stops=[0,0];
 const policies=new Map(['mcu','aux'].map((id,i)=>[id,{stopDevice:async()=>{stops[i]++;},rts:true,leaveBootloader:false}]));
 const connections=configuredUARTConnections(reader({mcu:{serial:pairs[0].path},'mcu aux':{serial:pairs[1].path,baud:'115200'}}),policies),group=new MCUGroup(connections);
 policies.get('mcu')!.stopDevice=async()=>{throw new Error('mutated policy');};
 try{await group.start(new AbortController().signal);assert.equal(group.session('mcu').status.state,'ready');assert.equal(group.session('aux').status.state,'ready');await group.stop();assert.deepEqual(stops,[1,1]);}
 finally{await group.stop();await Promise.all(firmware.map(f=>f.close()));}
});
