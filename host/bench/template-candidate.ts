/** Evaluation gate only: MiniJinja is not enabled in the production host. */
import {Environment} from 'minijinja-js';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {parseRequestJson} from '../src/moonraker/json.ts';
const cases=[
 {name:'integer literal',expression:'1 is integer'},
 {name:'float literal',expression:'1.0 is float'},
 {name:'Python decimal rounding',expression:'2.675|round(2)'},
 {name:'negative tie rounding',expression:'(-2.675)|round(2)'},
 {name:'integer intermediate cancellation',expression:'9007199254740993 - 9007199254740992'},
 {name:'JSON integer type',expression:'(payload|fromjson).i is integer'},
 {name:'JSON float type',expression:'(payload|fromjson).f is float'},
 {name:'callback float type',expression:'kind(1.0)'},
 {name:'Unicode float conversion',expression:'"١_٢.５"|float'},
 {name:'negative floor division',expression:'(-5)//2'},
 {name:'Python dictionary method',expression:'(payload|fromjson).keys()|list|length'},
 {name:'undefined attribute',expression:'missing.child.value'},
];
const payload='{"i":1,"f":1.0,"apower":25.5,"voltage":230.0,"current":0.125,"aenergy":{"by_minute":[1200]}}';
const pythonTemplate='{% set notification = payload|fromjson %}{set_result("power", notification["apower"]|float)}{set_result("voltage", notification["voltage"]|float)}{set_result("current", notification["current"]|float)}{set_result("energy", notification["aenergy"]["by_minute"][0]|float * 0.000001)}';
// Delimiters adapted explicitly for evaluation; no production regex translator.
const nodeTemplate=pythonTemplate.replaceAll('{set_result','{{set_result').replaceAll(')}',')}}');
const referencePath=fileURLToPath(new URL('../node_modules/.cache/jinja-reference',import.meta.url));
const child=spawnSync('python3',['-c',`
import sys,json,time
sys.path.insert(0,${JSON.stringify(referencePath)})
import jinja2
assert jinja2.__version__=='3.1.6'
env=jinja2.Environment('{%','%}','{','}')
env.add_extension('jinja2.ext.do');env.filters['fromjson']=json.loads
cases=json.loads(${JSON.stringify(JSON.stringify(cases))});payload=${JSON.stringify(payload)}
results=[]
for case in cases:
 try:results.append(dict(ok=True,rendered=env.from_string('{'+case['expression']+'}').render(payload=payload,kind=lambda value:'integer' if type(value)==int else 'float' if type(value)==float else type(value).__name__).strip()))
 except Exception:results.append(dict(ok=False))
measurements={}
def capture(name,value):measurements[name]=value
compiled=env.from_string(${JSON.stringify(pythonTemplate)});times=[]
for run in range(9):
 start=time.perf_counter()
 for i in range(3000):compiled.render(payload=payload,set_result=capture)
 if run>=2:times.append((time.perf_counter()-start)*1000)
print(json.dumps(dict(version=jinja2.__version__,results=results,times=times,measurements=measurements)))
`],{encoding:'utf8',timeout:120000});assert.equal(child.status,0,'Jinja2 oracle unavailable: '+child.stderr);const reference=JSON.parse(child.stdout);
assert.equal(reference.results[2].rendered,'2.67');assert.equal(reference.results[6].rendered,'True');assert.equal(reference.results[8].rendered,'12.5');
const env=new Environment();env.enablePyCompat();env.fuel=100000;env.addFilter('fromjson',parseRequestJson);
try{
 const results=cases.map((test,index)=>{let actual:unknown;try{actual={ok:true,rendered:env.renderStr('{{'+test.expression+'}}',{payload,kind:(value:unknown)=>typeof value==='number'?(Number.isInteger(value)?'integer':'float'):typeof value}).trim()};}catch{actual={ok:false};}return {...test,python:reference.results[index],candidate:actual,equivalent:JSON.stringify(actual)===JSON.stringify(reference.results[index])};});
 const measurements:Record<string,number>={},times:number[]=[];env.addTemplate('sensor',nodeTemplate);const context={payload,set_result:(name:string,value:number)=>{measurements[name]=value;return null;}};
 for(let run=0;run<9;run++){const start=performance.now();for(let i=0;i<3000;i++)env.renderTemplate('sensor',context);if(run>=2)times.push(performance.now()-start);assert.deepEqual(measurements,reference.measurements);}
 const directSyntax=env.renderStr('{value}',{value:12})==='12';const summary=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[3],p95Ms:v[6]};};
 const compatible=directSyntax&&results.every(result=>result.equivalent);
 console.log(JSON.stringify({node:process.version,candidate:'minijinja-js@2.24.0',python:'Jinja2@'+reference.version,productionEnabled:false,compatible,directMoonrakerSyntax:directSyntax,results,performance:{renders:3000,warmup:2,samples:7,scope:'Explicitly adapted Shelly template; JSON decode and four numeric callbacks; no MQTT, storage or native typed binding',node:summary(times),python:summary(reference.times)}},null,2));
 if(process.argv.includes('--require-compatible')&&!compatible)process.exitCode=1;
}finally{env.free();}
