import test from 'node:test';
import assert from 'node:assert/strict';
import {SystemInformation,osRelease,cpuInformation,sdInformation,networkInformation,linuxNetworkFields} from '../src/moonraker/system-information.ts';
test('system metadata parses data without executing os-release expressions or inventing CPU values',()=>{
 const distribution=osRelease('ID=test\nPRETTY_NAME="Test \\"OS\\""\nVERSION_ID="1.2.3"\nID_LIKE=debian\nNAME=$(false)\nVERSION_CODENAME=demo');assert.equal(distribution.name,'Test "OS"');assert.deepEqual(distribution.version_parts,{major:'1',minor:'2',build_number:'3'});assert.equal(osRelease('NAME=$(false)').name,'$(false)');
 const cpu=cpuInformation('processor: 0\nmodel name : Test CPU\n\nHardware : Board\nSerial : 00001234\nModel : Example','MemTotal: 1024 kB',4,'arm64','aarch64');assert.equal(cpu.cpu_count,4);assert.equal(cpu.cpu_desc,'Test CPU');assert.equal(cpu.bits,'64bit');assert.equal(cpu.serial_number,'1234');assert.equal(cpu.total_memory,1024);assert.equal(cpu.memory_units,'kB');assert.equal(cpuInformation('','',0,'unknown','').total_memory,null);
});
test('SD capacity decodes all three CSD layouts without signed 32-bit overflow',()=>{
 const cid=['03','5344','4142434445','12','12345678','0','185','01'].join('');assert.equal(cid.length,32);
 const csd=Buffer.alloc(16);csd[5]=9;csd[7]=1;csd[10]=128;
 let sd=sdInformation(cid,csd.toString('hex'));assert.equal(sd.product_name,'ABCDE');assert.equal(sd.manufacturer_date,'5/2024');assert.equal(sd.total_bytes,5*8*512);
 csd.fill(0);csd[0]=64;csd[9]=1;sd=sdInformation(cid,csd.toString('hex'));assert.equal(sd.total_bytes,1048576);
 csd.fill(0);csd[0]=128;csd[6]=15;csd[7]=255;csd[8]=255;csd[9]=255;sd=sdInformation(cid,csd.toString('hex'));assert.equal(sd.total_bytes,2**47);assert.equal(sd.capacity,'128.0 TiB');assert.deepEqual(sdInformation('bad',''),{});assert.equal(sdInformation(cid,'bad').capacity,'Unknown');
});
test('network fields preserve link-local scope and CAN settings and omit unsupported links',()=>{
 const value=networkInformation([{operstate:'UP',ifname:'eth0',link_type:'ether',address:'aa:bb:cc:dd:ee:ff',addr_info:[{family:'inet',local:'169.254.1.2',scope:'link'},{family:'inet6',local:'2001:db8::1',scope:'global'}]},{operstate:'UP',ifname:'can0',link_type:'can',txqlen:128,linkinfo:{info_data:{bittiming:{bitrate:1000000},bittiming_const:{name:'test'}}}},{ifname:'lo',link_type:'loopback'},{ifname:'__proto__',link_type:'ether',addr_info:[]}]);assert.deepEqual(value.canbus.can0,{tx_queue_len:128,bitrate:1000000,driver:'test'});assert.deepEqual((value.network.eth0 as any).ip_addresses,[{family:'ipv4',address:'169.254.1.2',is_link_local:true},{family:'ipv6',address:'2001:db8::1',is_link_local:false}]);assert.equal(Object.keys(value.network).length,1);
});
test('system information refreshes atomically, isolates snapshots and waits for cancelled sources',async()=>{
 const pending=Promise.withResolvers<Record<string,any>>();let calls=0;const info=new SystemInformation(async()=>{calls++;if(calls===1)return {runtime:{name:'node'}};return pending.promise;});await info.refresh();const snapshot=info.snapshot() as any;snapshot.system_info.runtime.name='changed';assert.equal((info.snapshot() as any).system_info.runtime.name,'node');
 const first=info.refresh(),second=info.refresh();assert.equal(first,second);const rejected=assert.rejects(first,/closed/);let closed=false;const close=info.close().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);pending.resolve({runtime:{name:'late'}});await rejected;await close;assert.equal(info.status.samples,1);assert.equal(info.status.pending,false);assert.equal((info.snapshot() as any).system_info.runtime.name,'node');
});
test('network command failure preserves last good links; confirmed changes emit isolated complete snapshots',async()=>{
 const up={operstate:'UP',ifname:'eth0',link_type:'ether',address:'02:00:00:00:00:01',addr_info:[{family:'inet',local:'192.0.2.1',scope:'global'}]},events:any[]=[];
 let sample:Record<string,any>={runtime:{name:'node'},...linuxNetworkFields(JSON.stringify([up]))};
 const info=new SystemInformation(async()=>sample,network=>{events.push(structuredClone(network));network.eth0={overwritten:true};});
 try{
  await info.refresh();assert.equal(events.length,0);const first=info.snapshot();
  for(const invalid of [null,'invalid-json','{}','[null]','[{}]',JSON.stringify([{...up,addr_info:{}}]),JSON.stringify([{...up,addr_info:[{family:'invalid',local:'192.0.2.2'}]}]),JSON.stringify([up,{operstate:'UP',link_type:'ether',ifname:'eth1',address:'02:00:00:00:00:02',addr_info:[null]}]),JSON.stringify(Array(2049).fill(up))]){sample={runtime:{name:'node'},...linuxNetworkFields(invalid)};await info.refresh();assert.deepEqual(info.snapshot(),first);}
  assert.equal(events.length,0);
  sample={...linuxNetworkFields(JSON.stringify([{...up,addr_info:[{family:'inet',local:'192.0.2.2',scope:'global'}]}]))};await info.refresh();
  assert.equal(events.length,1);assert.equal((info.snapshot() as any).system_info.network.eth0.ip_addresses[0].address,'192.0.2.2');
  await info.refresh();assert.equal(events.length,1);
  sample={...linuxNetworkFields(JSON.stringify([{...up,operstate:'DOWN'}]))};await info.refresh();assert.equal(events.length,2);assert.deepEqual(events[1],{});assert.deepEqual((info.snapshot() as any).system_info.network,{});
  assert.deepEqual(networkInformation([{...up,operstate:'UNKNOWN'},up]),networkInformation([up]));
 }finally{await info.close();}
});
test('network observer failure never rolls back a committed snapshot; closure joins admitted observer work',async()=>{
 let address='192.0.2.1',fail=true;const entered=Promise.withResolvers<void>(),held=Promise.withResolvers<void>();
 const info=new SystemInformation(async()=>({network:{eth0:{address}},canbus:{}}),async()=>{if(fail)throw new Error('Observer unavailable');entered.resolve();await held.promise;});
 try{
  await info.refresh();address='192.0.2.2';await info.refresh();assert.equal(info.status.notification_failures,1);assert.equal((info.snapshot() as any).system_info.network.eth0.address,address);
  fail=false;address='192.0.2.3';const changing=info.refresh();await entered.promise;assert.equal(info.status.pending,true);assert.equal((info.snapshot() as any).system_info.network.eth0.address,address);
  let closed=false;const closing=info.close().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);held.resolve();await changing;await closing;assert.equal(info.status.pending,false);
  await assert.rejects(info.refresh(),/closed/);
 }finally{held.resolve();await info.close();}
});
test('invalid network source results retain the entire previous snapshot and emit no events',async()=>{
 let value:any={runtime:{name:'node'},network:{eth0:{address:'192.0.2.1'}},canbus:{}},events=0;
 const info=new SystemInformation(async()=>value,()=>{events++;});
 try{await info.refresh();const prior=info.snapshot();for(const invalid of [null,[],false,'link']){value={network:invalid,canbus:{}};await assert.rejects(info.refresh(),/Invalid system network/);assert.deepEqual(info.snapshot(),prior);assert.equal(events,0);}}finally{await info.close();}
});
test('CAN metadata updates remain queryable without inventing Ethernet notifications',async()=>{
 let bitrate=1000000,events=0;
 const info=new SystemInformation(async()=>({network:{},canbus:{can0:{tx_queue_len:128,bitrate,driver:'test'}}}),()=>{events++;});
 try{await info.refresh();bitrate=500000;await info.refresh();assert.equal(events,0);assert.equal((info.snapshot() as any).system_info.canbus.can0.bitrate,bitrate);}finally{await info.close();}
});
