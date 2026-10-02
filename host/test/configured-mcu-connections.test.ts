import {spawnSync} from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,symlink,rm} from 'node:fs/promises';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {readMCUConnections} from '../src/config/mcu-connections.ts';
import {configuredMCUConnections,type MCUMachinePolicy} from '../src/runtime/configured-mcu-connections.ts';
import {MCUGroup} from '../src/runtime/mcu-group.ts';
import {ptyPair} from './helpers/pty.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
const reader=(s:Record<string,Record<string,string>>)=>new ConfigurationReader(new ConfigurationSource('/mixed.cfg',s,[]),null);
const stopDevice=async()=>{};
test('mixed config preserves CAN UUID bytes and character-device routing',()=>{
 const plans=readMCUConnections(reader({mcu:{serial:'/dev/ttyUSB0'},'mcu aux':{canbus_uuid:'0xA'},'mcu host':{serial:'/tmp/klipper_host_mcu'}}));
 assert.deepEqual(plans[1],{id:'aux',section:'mcu aux',transport:'can',interface:'can0',uuid:'00000000000a'});assert.equal(plans[2].transport,'pipe');assert.equal(plans[0].transport,'uart');assert(Object.isFrozen(plans));
 for(const s of [{mcu:{canbus_uuid:'a',serial:'/dev/a'}},{mcu:{canbus_uuid:'a'},'mcu aux':{canbus_uuid:'00000000000A'}},{mcu:{canbus_uuid:'1000000000000'}},{mcu:{serial:'/dev/rpmsg_pru',baud:'250000'}}])assert.throws(()=>readMCUConnections(reader(s as unknown as Record<string,Record<string,string>>)));
});
test('CAN policy rejects colliding node IDs before assignment and snapshots accepted nodes',async()=>{
 const r=reader({mcu:{canbus_uuid:'1'},'mcu aux':{canbus_uuid:'2'}}),policies=new Map<string,MCUMachinePolicy>([['mcu',{transport:'can',nodeId:64,timeoutMs:5000,stopDevice}],['aux',{transport:'can',nodeId:64,timeoutMs:5000,stopDevice}]]);
 assert.throws(()=>configuredMCUConnections(r,policies),/Duplicate CAN node/);policies.set('aux',{transport:'can',nodeId:65,timeoutMs:5000,stopDevice});const connections=configuredMCUConnections(r,policies);
 const abort=new AbortController();abort.abort(new Error('do not assign'));for(const c of connections)await assert.rejects(c.connect(abort.signal,stopDevice),/do not assign/);
 policies.set('aux',{transport:'can',nodeId:undefined as unknown as number,timeoutMs:5000,stopDevice});assert.throws(()=>configuredMCUConnections(r,policies),/explicit node/);
 policies.set('aux',{transport:'pipe',stopDevice});assert.throws(()=>configuredMCUConnections(r,policies),/differ/);
});
test('same CAN node ID can be declared on independent interfaces',()=>{
 const r=reader({mcu:{canbus_uuid:'1'},'mcu aux':{canbus_uuid:'1',canbus_interface:'can1'}}),p={transport:'can' as const,nodeId:64,timeoutMs:1000,stopDevice};assert.equal(configuredMCUConnections(r,new Map([['mcu',p],['aux',p]])).length,2);
});
test('mixed UART and character-device connectors run through real PTYs',async()=>{
 const dir=await mkdtemp('/tmp/klipper_host_mixed-'),pairs=[ptyPair(),ptyPair()],firmware=await Promise.all(pairs.map(p=>serialFirmware(p))),stops=[0,0];await symlink(pairs[1].path,dir+'/stream');
 const policies=new Map<string,MCUMachinePolicy>([['mcu',{transport:'uart',rts:true,leaveBootloader:false,stopDevice:async()=>{stops[0]++;}}],['host',{transport:'pipe',stopDevice:async()=>{stops[1]++;}}]]);
 const env={...process.env};delete env.LD_PRELOAD;delete env.ASAN_OPTIONS;const raw=spawnSync('stty',['-F',pairs[1].path,'raw','-echo'],{env,encoding:'utf8'});assert.equal(raw.status,0,raw.stderr);
 const group=new MCUGroup(configuredMCUConnections(reader({mcu:{serial:pairs[0].path},'mcu host':{serial:dir+'/stream'}}),policies));
 try{await group.start(new AbortController().signal);assert.equal(group.session('host').status.state,'ready');assert.equal(group.session('mcu').status.state,'ready');await group.stop();assert.deepEqual(stops,[1,1]);}
 finally{await group.stop();await Promise.all(firmware.map(f=>f.close()));await rm(dir,{recursive:true,force:true});}
});
