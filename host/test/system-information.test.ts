import test from 'node:test';
import assert from 'node:assert/strict';
import {SystemInformation,osRelease,cpuInformation,sdInformation,networkInformation} from '../src/moonraker/system-information.ts';
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
 const value=networkInformation([{ifname:'eth0',link_type:'ether',address:'aa:bb:cc:dd:ee:ff',addr_info:[{family:'inet',local:'169.254.1.2',scope:'link'},{family:'inet6',local:'2001:db8::1',scope:'global'}]},{ifname:'can0',link_type:'can',txqlen:128,linkinfo:{info_data:{bittiming:{bitrate:1000000},bittiming_const:{name:'test'}}}},{ifname:'lo',link_type:'loopback'},{ifname:'__proto__',link_type:'ether',addr_info:[]}]);assert.deepEqual(value.canbus.can0,{tx_queue_len:128,bitrate:1000000,driver:'test'});assert.deepEqual((value.network.eth0 as any).ip_addresses,[{family:'ipv4',address:'169.254.1.2',is_link_local:true},{family:'ipv6',address:'2001:db8::1',is_link_local:false}]);assert.equal(Object.keys(value.network).length,1);
});
test('system information refreshes atomically, isolates snapshots and waits for cancelled sources',async()=>{
 const pending=Promise.withResolvers<Record<string,any>>();let calls=0;const info=new SystemInformation(async()=>{calls++;if(calls===1)return {runtime:{name:'node'}};return pending.promise;});await info.refresh();const snapshot=info.snapshot() as any;snapshot.system_info.runtime.name='changed';assert.equal((info.snapshot() as any).system_info.runtime.name,'node');
 const first=info.refresh(),second=info.refresh();assert.equal(first,second);const rejected=assert.rejects(first,/closed/);let closed=false;const close=info.close().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);pending.resolve({runtime:{name:'late'}});await rejected;await close;assert.equal(info.status.samples,1);assert.equal(info.status.pending,false);assert.equal((info.snapshot() as any).system_info.runtime.name,'node');
});
