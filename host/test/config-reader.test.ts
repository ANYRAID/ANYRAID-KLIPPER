import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ConfigurationSource,loadConfiguration,ConfigurationError} from '../src/moonraker/config-source.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ServerConfiguration} from '../src/moonraker/metadata.ts';
const reader=(values:Record<string,Record<string,string>>)=>new ConfigurationReader(new ConfigurationSource('/config/main.conf',{DEFAULT:{},...values},[]));
const plain=(v:unknown)=>JSON.parse(JSON.stringify(v));
test('typed configuration reads decimals, underscores, unicode digits, booleans and first-read values',()=>{
 const owner=reader({server:{integer:'١_٢',float:'１_２.５e-１',truth:'YeS',zero:'-0',both:'1'}}),s=owner.section('server');
 assert.equal(s.getInt('integer'),12);assert.equal(s.getFloat('float'),1.25);assert.equal(s.getBoolean('truth'),true);assert.equal(Object.is(s.getInt('zero'),-0),false);assert.equal(Object.is(s.getFloat('zero'),-0),true);assert.equal(s.get('both'),'1');assert.equal(s.getInt('both'),1);assert.equal(owner.parsed().server.both,'1');
});
test('missing defaults are recorded, cloned and distinguished from a required option',()=>{
 const owner=reader({server:{}}),s=owner.section('server'),value={items:[1,2]};assert.equal(s.getInt('port',{defaultValue:7125,minval:8000}),7125);assert.equal(s.get('optional',{defaultValue:null}),null);assert.equal(s.get('object',{defaultValue:value}),value);value.items.push(3);assert.deepEqual(owner.parsed().server.object,{items:[1,2]});assert.throws(()=>s.getInt('missing'),ConfigurationError);assert.equal(owner.parsed().server.__CONFIG_ERROR__,true);assert.throws(()=>s.getFloat('badDefault',{defaultValue:Infinity}),ConfigurationError);
});
test('numeric guards reject overflow, non-finite values, malformed tokens and boundary violations',()=>{
 for(const input of ['9007199254740992','-9007199254740992','1.0','1e2','0x12','1__2','_1','1_','']){const r=reader({server:{value:input}});assert.throws(()=>r.section('server').getInt('value'),ConfigurationError);assert.equal(r.parsed().server.__CONFIG_ERROR__,true);}
 for(const input of ['NaN','inf','-Infinity','1e999','1__2.0','0x1p2'])assert.throws(()=>reader({server:{value:input}}).section('server').getFloat('value'),ConfigurationError);
 const r=reader({server:{value:'10'}}),s=r.section('server');for(const bounds of [{above:10},{below:10},{minval:11},{maxval:9}])assert.throws(()=>s.getInt('value',bounds),ConfigurationError);assert.deepEqual(plain(r.parsed().server),{});assert.equal(s.getInt('value',{minval:10,maxval:10}),10);assert.throws(()=>s.getInt('missing',{defaultValue:9007199254740992}),ConfigurationError);assert.throws(()=>s.getInt('missing',{defaultValue:1.5}),ConfigurationError);
});
test('fallback applies only when the requested section is absent, and warnings are deduplicated',()=>{
 const r=reader({server:{},old:{value:'12'},present:{}}),s=r.section('new','old');assert.equal(s.getInt('value',{deprecate:true}),12);s.getInt('value',{deprecate:true});assert.equal(r.warnings().length,2);assert.equal(r.parsed().old.value,12);assert.deepEqual(plain(r.parsed().new),{});assert.equal(r.section('present','old').getInt('value',{defaultValue:7}),7);assert.equal(s.getInt('absent',{defaultValue:8}),8);assert.equal(r.parsed().new.absent,8);
});
test('lists and dictionaries parse nested counts, whitespace, duplicates and prototype names',()=>{
 const r=reader({server:{rows:'1,2\n3,4',words:' first\tsecond  third ',mapping:'a=1\na=2\n__proto__=3\nnone',choice:'FAST',bad:'1,2,3'}}),s=r.section('server');
 assert.deepEqual(s.getLists('rows',{type:'int',separators:['\n',','],count:[2,2]}),[[1,2],[3,4]]);assert.deepEqual(s.getList('words',{separator:null,count:3}),['first','second','third']);assert.deepEqual(plain(s.getDictionary('mapping',{type:'int',allowEmptyFields:true})),{a:2,['__proto__']:3,none:null});assert.equal(s.getChoice('choice',{fast:5,slow:2},{forceLowercase:true}),5);assert.equal(r.parsed().server.choice,'FAST');assert.throws(()=>s.getIntList('bad',{separator:',',count:2}),ConfigurationError);assert.throws(()=>s.getLists('rows',{separators:['\n',','],count:[2]}),ConfigurationError);
 const values=s.getLists('rows',{type:'int',separators:['\n',',']}) as number[][];values[0][0]=99;assert.equal((r.parsed().server.rows as number[][])[0][0],1);
});
test('section enumeration and validation report unconsumed names without leaking option values',()=>{
 const r=reader({server:{secret:'must-not-leak',port:'7125'},'camera one':{url:'private'},'camera two':{url:'private'}});assert.deepEqual(r.prefixSections('camera'),['camera one','camera two']);assert.equal(r.hasSection('DEFAULT'),false);assert.equal(r.section('server').hasOption('PORT'),true);r.section('server').getInt('port');assert.equal(r.validate().length,3);assert.equal(r.warnings().join('\n').includes('must-not-leak'),false);const parsed=r.parsed();parsed.server.port=1;assert.equal(r.parsed().server.port,7125);
});
test('real file getters publish actual component conversions atomically into server metadata',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'node-config-reader-'));try{
  const path=join(dir,'main.conf');await writeFile(path,'[server]\nport=7125\nmax_websocket_connections=25\n[consumer]\ntravel_speed=120.5\nallow_resume=no');const r=new ConfigurationReader(await loadConfiguration(path)),server=r.section('server'),consumer=r.section('consumer');
  assert.equal(server.getInt('port',{defaultValue:7125,minval:1,maxval:65535}),7125);assert.equal(server.getInt('max_websocket_connections',{defaultValue:50,minval:1}),25);assert.equal(consumer.getFloat('travel_speed',{above:0,maxval:300}),120.5);assert.equal(consumer.getBoolean('allow_resume'),false);
  const metadata=new ServerConfiguration(r.snapshot());assert.deepEqual(plain(metadata.read().config),{server:{port:7125,max_websocket_connections:25},consumer:{travel_speed:120.5,allow_resume:false}});server.get('host',{defaultValue:'127.0.0.1'});assert.equal((metadata.read().config as any).server.host,undefined);r.publish(metadata);assert.equal((metadata.read().config as any).server.host,'127.0.0.1');assert.equal((metadata.read().orig as any).consumer.travel_speed,'120.5');
 }finally{await rm(dir,{recursive:true,force:true});}
});
