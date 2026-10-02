import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {ConfigurationReader,type ConfigSection} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
const root=process.env.MOONRAKER_SOURCE;if(!root)throw new Error('Set MOONRAKER_SOURCE');const pin=JSON.parse(readFileSync(new URL('../contracts/moonraker-upstream.json',import.meta.url),'utf8')).commit;
type Case={method:string;value?:string;options?:Record<string,any>;choices?:any;section?:string;fallback?:string;present?:boolean};
const cases:Case[]=[];
for(const value of ['12','-12','+1_234','٠١٢','１２','𝟙𝟚','-0','01','1.5','0x12','1__2','\x1c1','\x851'])cases.push({method:'getInt',value});
for(const value of ['.25','1.','1_2.3_4e-1','١٢.٥','-0','+1e+2','abc','1_e2'])cases.push({method:'getFloat',value});
for(const value of ['true','FaLsE','1','0','on','OFF','Yes','no','2',' true '])cases.push({method:'getBoolean',value});
for(const options of [{above:10},{below:10},{minval:10,maxval:10},{minval:11},{maxval:9}])cases.push({method:'getInt',value:'10',options});
cases.push({method:'getInt'},{method:'getInt',options:{defaultValue:null}},{method:'getInt',options:{defaultValue:3,minval:10}},{method:'get',options:{defaultValue:{nested:[1,2]}}},{method:'get',value:'raw %(template)s'});
cases.push({method:'getChoice',value:'FAST',choices:{fast:1,slow:2},options:{forceLowercase:true}},{method:'getChoice',value:'no',choices:['yes','maybe']},{method:'getChoice',choices:['yes'],options:{defaultValue:'yes'}});
cases.push({method:'getList',value:' first\n\nsecond\n',options:{count:2}},{method:'getList',value:'a\tb  c',options:{separator:null}},{method:'getIntList',value:'1,2,,3',options:{separator:',',count:3}},{method:'getFloatList',value:'1.2,3.4',options:{separator:',',count:3}},{method:'getLists',value:'1,2\n3,4',options:{type:'int',separators:['\n',','],count:[2,2]}},{method:'getLists',value:'1,2\n3',options:{type:'int',separators:['\n',','],count:[2,2]}});
cases.push({method:'getDictionary',value:'a=1\na=2\n__proto__=3\nempty',options:{type:'int',allowEmptyFields:true}},{method:'getDictionary',value:'a=b=c'},{method:'getDictionary',value:'a 1\nb 2',options:{type:'int',separators:['\n',null]}},{method:'getDictionary',value:'a=1\nb',options:{type:'int'}});
cases.push({method:'getInt',value:'12',section:'new',fallback:'old',options:{deprecate:true}},{method:'getInt',value:'12',section:'new',fallback:'old',present:true,options:{defaultValue:7}},{method:'getInt',section:'new',fallback:'old',options:{defaultValue:8}},{method:'get',value:'text',options:{deprecate:true}});
const original={DEFAULT:{},server:{integer:'1234',float:'123.45',flag:'true',list:'1,2,3,4,5'}};
function invoke(section:ConfigSection,fixture:Case):unknown{const method=(section as any)[fixture.method].bind(section);return fixture.method==='getChoice'?method('value',fixture.choices,fixture.options??{}):method('value',fixture.options??{});}
const actual=cases.map(f=>{const values:Record<string,Record<string,string>>={DEFAULT:{},server:{},old:{}};const location=f.fallback?'old':f.section??'server';if(f.value!==undefined)values[location]={value:f.value};if(f.present)values[f.section!]={};const r=new ConfigurationReader(new ConfigurationSource('/fixture.conf',values,[]));r.section('old');let value,ok=true;try{value=invoke(r.section(f.section??'server',f.fallback),f);}catch{ok=false;}return {ok,...ok?{value}:{},parsed:r.parsed(),warnings:r.warnings()};});
const python=String.raw`
import ast,sys,json,configparser,copy,pathlib,types,time,subprocess,platform,math
from typing import *
from io import StringIO
DOCS_URL='https://moonraker.readthedocs.io/en/latest'
CFG_ERROR_KEY='__CONFIG_ERROR__'
class ConfigError(Exception):pass
class Sentinel:MISSING=object()
code=subprocess.check_output(['git','-C',sys.argv[1],'show',sys.argv[2]+':moonraker/confighelper.py'],text=True)
classes=[n for n in ast.parse(code).body if isinstance(n,ast.ClassDef) and n.name in ('ConfigHelper','ConfigSourceWrapper','DictSourceWrapper')]
exec('from __future__ import annotations\n'+ast.unparse(ast.Module(body=classes,type_ignores=[])),globals())
data=json.load(sys.stdin)
names={'get':'get','getInt':'getint','getFloat':'getfloat','getBoolean':'getboolean','getChoice':'getchoice','getLists':'getlists','getList':'getlist','getIntList':'getintlist','getFloatList':'getfloatlist','getDictionary':'getdict'}
def make(values):
 warnings={};s=types.SimpleNamespace(add_warning=lambda msg:warnings.setdefault(msg,None));source=DictSourceWrapper();source.read_dict(values);return ConfigHelper(s,source,'server',{}),warnings
results=[]
for f in data['cases']:
 values={'server':{},'old':{}};location='old' if f.get('fallback') else f.get('section','server')
 if 'value' in f:values[location]={'value':f['value']}
 if f.get('present'):values[f['section']]={}
 c,warnings=make(values);c.getsection('old');section=c.getsection(f.get('section','server'),f.get('fallback'));options=dict(f.get('options',{}));method=f['method']
 if 'defaultValue' in options:options['default_key' if method=='getChoice' else 'default']=options.pop('defaultValue')
 if 'forceLowercase' in options:options['force_lowercase']=options.pop('forceLowercase')
 if 'allowEmptyFields' in options:options['allow_empty_fields']=options.pop('allowEmptyFields')
 if 'type' in options:options['dict_type' if method=='getDictionary' else 'list_type']={'string':str,'int':int,'float':float}[options.pop('type')]
 args=['value']
 if method=='getChoice':args.append(f['choices'])
 try: result={'ok':True,'value':getattr(section,names[method])(*args,**options)}
 except Exception:result={'ok':False}
 result.update(parsed=c.parsed,warnings=list(warnings));results.append(result)
c,_=make(data['original']);samples=[]
for run in range(14):
 start=time.perf_counter()
 for i in range(10000):
  c.getint('integer');c.getfloat('float');c.getboolean('flag');c.getintlist('list',separator=',',count=5)
 if run>=3:samples.append((time.perf_counter()-start)*1000)
initial=[]
for run in range(14):
 start=time.perf_counter()
 for i in range(1000):
  fresh=ConfigHelper(c.server,c.source,'server',{})
  fresh.getint('integer');fresh.getfloat('float');fresh.getboolean('flag');fresh.getintlist('list',separator=',',count=5);fresh.get_parsed_config()
 if run>=3:initial.append((time.perf_counter()-start)*1000)
print(json.dumps({'results':results,'samples':sorted(samples),'initial':sorted(initial),'python':platform.python_version()}))
`;
const reference=spawnSync(process.env.PYTHON??'/usr/bin/python3',['-c',python,root,pin],{input:JSON.stringify({cases,original}),encoding:'utf8',maxBuffer:8*1024*1024});if(reference.status!==0)throw new Error(reference.stderr);const result=JSON.parse(reference.stdout);
function normalize(value:any):any{if(Array.isArray(value))return value.map(normalize);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,normalize(item)]));return value;}
for(let i=0;i<cases.length;i++)assert.deepEqual(normalize(actual[i]),result.results[i],`fixture ${i}: ${JSON.stringify(cases[i])}`);
const reader=new ConfigurationReader(new ConfigurationSource('/fixture.conf',original,[])),config=reader.section('server'),samples:number[]=[];
for(let run=0;run<14;run++){const start=performance.now();for(let i=0;i<10000;i++){config.getInt('integer');config.getFloat('float');config.getBoolean('flag');config.getIntList('list',{separator:',',count:5});}if(run>=3)samples.push(performance.now()-start);}samples.sort((a,b)=>a-b);
const initial:number[]=[];for(let run=0;run<14;run++){const start=performance.now();for(let i=0;i<1000;i++){const fresh=new ConfigurationReader(reader.source),section=fresh.section('server');section.getInt('integer');section.getFloat('float');section.getBoolean('flag');section.getIntList('list',{separator:',',count:5});fresh.parsed();}if(run>=3)initial.push(performance.now()-start);}initial.sort((a,b)=>a-b);
console.log(JSON.stringify({upstream:pin,node:process.version,python:result.python,fixtures:cases.length,gettersPerSample:40000,nodeMedianMs:samples[5],nodeP95Ms:samples[10],pythonMedianMs:result.samples[5],pythonP95Ms:result.samples[10],initialGenerations:1000,nodeInitialMedianMs:initial[5],nodeInitialP95Ms:initial[10],pythonInitialMedianMs:result.initial[5],pythonInitialP95Ms:result.initial[10],scope:'Pinned ConfigHelper/DictSourceWrapper AST, return values + parsed records + warnings. Python samples precede Node; in-memory getters, no disk, template/GPIO components or real printing. Initial generations include four first reads plus parsed retrieval (Node deep copy, upstream shallow copy). Overflow/non-finite rejection is a deliberate Node precision policy covered separately.'},null,2));
