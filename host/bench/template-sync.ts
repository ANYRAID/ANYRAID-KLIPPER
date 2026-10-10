import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {SecretsStore,parseSecretsText} from '../src/moonraker/secrets.ts';
import {MoonrakerTemplateOwner} from '../src/moonraker/template-owner.ts';
// Budgets fixed before candidate measurement. Synthetic file values only.
const budgets={renderToJinja:1.5,coldToJinja:1.5,fuelFailureMaxMs:25,secretsParseToBaseline:1.2,secretsCachedToBaseline:1.2};
const source='{secrets["ldap"]["base"]}/{secrets["large"]+2}/{value.f is integer}',context='{"value":{"f":1.0}}',expected='dc=example,dc=test/9007199254740995/False';
const reference=JSON.parse(await readFile(new URL('../contracts/moonraker-template-sync-reference.json',import.meta.url),'utf8'));
const repetitions={render:3000,cold:100,parse:2000,cached:1000000},warmups=2,samples=7;
const summary=(runs:number[])=>{const sorted=[...runs].sort((a,b)=>a-b);return {samplesMs:runs,medianMs:sorted[Math.floor(sorted.length/2)],p95Ms:sorted[Math.ceil(sorted.length*0.95)-1]};};
const referenceCode=`
import sys,json,time,types,subprocess
sys.path.insert(0,sys.argv[1])
data=json.loads(sys.stdin.read())
for name in ('moonraker','moonraker.components','moonraker.utils'):
 m=types.ModuleType(name);m.__path__=[];sys.modules[name]=m
w=types.ModuleType('moonraker.utils.json_wrapper');w.loads=json.loads;w.JSONDecodeError=json.JSONDecodeError;sys.modules[w.__name__]=w
c=types.ModuleType('moonraker.common');c.RenderableTemplate=object;sys.modules[c.__name__]=c
for name in ('secrets','template'):
 text=subprocess.check_output(['git','-C',sys.argv[2],'show',data['revision']+':moonraker/components/'+name+'.py']);m=types.ModuleType('moonraker.components.'+name);sys.modules[m.__name__]=m;exec(compile(text,name+'.py','exec'),m.__dict__)
s=sys.modules['moonraker.components.secrets'].Secrets.__new__(sys.modules['moonraker.components.secrets'].Secrets);s.values=json.loads(data['secrets']);s.type='json';s.secrets_file=data['file']
class Server:
 def load_component(self,config,name):return s
 def error(self,msg,code=400):return RuntimeError(msg)
 def config_error(self,msg):return ValueError(msg)
 def is_configured(self):return True
class Config:
 def get_server(self):return Server()
factory=sys.modules['moonraker.components.template'].TemplateFactory(Config());template=factory.create_template(data['source']);context=json.loads(data['context']);times={'render':[],'cold':[]}
for run in range(9):
 start=time.perf_counter()
 for i in range(data['repetitions']['render']):output=template.render(context)
 elapsed=(time.perf_counter()-start)*1000;assert output==data['expected']
 if run>=2:times['render'].append(elapsed)
 start=time.perf_counter()
 for i in range(data['repetitions']['cold']):factory.create_template(data['source'])
 if run>=2:times['cold'].append((time.perf_counter()-start)*1000)
print(json.dumps(dict(runtime=sys.version.split()[0],times=times)))
`;
if(!process.env.JINJA_REFERENCE||!process.env.MOONRAKER_REFERENCE)throw Error('Pinned JINJA_REFERENCE and MOONRAKER_REFERENCE paths are required');
const child=spawnSync('python3',['-c',referenceCode,process.env.JINJA_REFERENCE,process.env.MOONRAKER_REFERENCE],{input:JSON.stringify({...reference,source,context,expected,repetitions,revision:reference.upstream.revision}),encoding:'utf8',timeout:60000});assert.equal(child.status,0,JSON.stringify({signal:child.signal,error:child.error?.message,stderr:child.stderr}));const python=JSON.parse(child.stdout);
const parsed=parseSecretsText(reference.secrets),secrets=new SecretsStore(reference.file,parsed.type,parsed.values),owner=new MoonrakerTemplateOwner(secrets),template=owner.createTemplate(source),times={render:[] as number[],cold:[] as number[]};
try{
 for(let run=0;run<warmups+samples;run++){
  let output='';let start=performance.now();for(let i=0;i<repetitions.render;i++)output=template.render(context);assert.equal(output,expected);if(run>=warmups)times.render.push(performance.now()-start);
  start=performance.now();for(let i=0;i<repetitions.cold;i++)owner.createTemplate(source).close();if(run>=warmups)times.cold.push(performance.now()-start);
 }
 const exhausted=owner.createTemplate('{% for i in range(1000000) %}{% set v=i %}{% endfor %}'),start=performance.now();assert.throws(()=>exhausted.render());const fuelFailureMs=performance.now()-start;exhausted.close();
 const native=Object.fromEntries(Object.entries(times).map(([name,runs])=>[name,summary(runs)])),jinja=Object.fromEntries(Object.entries(python.times).map(([name,runs])=>[name,summary(runs as number[])]));
 let baseline:unknown;
 if(process.env.SECRETS_BASELINE){
  const original=await import(process.env.SECRETS_BASELINE) as typeof import('../src/moonraker/secrets.ts'),text=JSON.stringify(Object.fromEntries(Array.from({length:32},(_,i)=>['section'+i,{password:'synthetic-value-'.repeat(4),index:String(i)}]))),measure=(implementation:typeof original)=>{
   const rows={parse:[] as number[],cached:[] as number[]},values=implementation.parseSecretsText(text).values,store=new implementation.SecretsStore('/synthetic/baseline','json',values);
   try{for(let run=0;run<warmups+samples;run++){let sum=0,start=performance.now();for(let i=0;i<repetitions.parse;i++)sum+=Object.keys(implementation.parseSecretsText(text).values).length;assert.equal(sum,32*repetitions.parse);if(run>=warmups)rows.parse.push(performance.now()-start);sum=0;start=performance.now();for(let i=0;i<repetitions.cached;i++)sum+=typeof store.item('section31')==='object'?1:0;assert.equal(sum,repetitions.cached);if(run>=warmups)rows.cached.push(performance.now()-start);}}finally{store.close();}return {parse:summary(rows.parse),cached:summary(rows.cached)};
  };
  const old=measure(original),current=measure({parseSecretsText,SecretsStore} as typeof original);baseline={old,current,parseRatio:current.parse.medianMs/old.parse.medianMs,cachedRatio:current.cached.medianMs/old.cached.medianMs};
 }
 const result={schema:1,node:process.version,rust:'1.89.0',engine:'minijinja 2.24.0 via N-API',upstream:reference.upstream,repetitions,warmups,samples,inputs:{sourceSha256:createHash('sha256').update(source).digest('hex'),contextSha256:createHash('sha256').update(context).digest('hex')},budgets,native,jinja,python:python.runtime,ratios:{render:native.render.medianMs/jinja.render.medianMs,cold:native.cold.medianMs/jinja.cold.medianMs},fuelFailureMs,baseline,scope:'Desktop synchronous private text rendering, compilation and old secrets hot-path regression. No MCU, printing, target-board, async callable or full-template compatibility claim.'};
 console.log(JSON.stringify(result));
 assert(result.ratios.render<=budgets.renderToJinja);assert(result.ratios.cold<=budgets.coldToJinja);assert(fuelFailureMs<=budgets.fuelFailureMaxMs);
 if(baseline){const data=baseline as {parseRatio:number;cachedRatio:number};assert(data.parseRatio<=budgets.secretsParseToBaseline);assert(data.cachedRatio<=budgets.secretsCachedToBaseline);}
}finally{template.close();owner.close();secrets.close();}
