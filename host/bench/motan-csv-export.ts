import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {managerFixture} from '../test/helpers/motan-manager-fixture.ts';
import {scipyReferenceEnvironment} from '../test/helpers/motan-sos-oracle.ts';
const root=fileURLToPath(new URL('../../',import.meta.url)),dir=await mkdtemp(join(tmpdir(),'motan-csv-bench-')),prefix=join(dir,'log');
const numericColumns=['trapq(toolhead,x)','derivative(trapq(toolhead,x))','kin(stepper_x)','kin(stepper_y)','accelerometer(a,x)','status(heater.temperature)','trapq(toolhead,x)','deviation(kin(stepper_x),trapq(toolhead,x))'];
try{
 await managerFixture(prefix,10,'corexy',{text:'逗号, "引号"\r\n换行',wide:9007199254740993123456789n,empty:null,yes:true});
 for(const mixed of [false,true])for(const duration of [.02,20]){
  const columns=mixed?[...numericColumns,'status(export_fields.text)','status(export_fields.wide)','status(export_fields.empty)','status(export_fields.yes)']:numericColumns;
  const outputs:string[]=[];
  for(const mode of ['python','node','node-typed'] as const){
   const command=mode==='python'?(process.env.MOTAN_SCIPY_PYTHON??'python3'):process.execPath;
   const args=[join(root,`scripts/motan/data_export.${mode==='python'?'py':'ts'}`),prefix,'-c',JSON.stringify(columns),'--segment-time','.001','-d',String(duration)];
   if(mode==='node-typed')args.push('--preserve-number-types');
   const ms:number[]=[];let output='';
   for(let i=0;i<9;i++){
    const start=performance.now(),current=execFileSync(command,args,{encoding:'utf8',env:mode==='python'?scipyReferenceEnvironment():process.env,maxBuffer:32*1024**2,timeout:30000}),elapsed=performance.now()-start;
    if(i)assert.equal(current,output);output=current;if(i>=2)ms.push(elapsed);
   }
   ms.sort((a,b)=>a-b);outputs.push(output);
   console.log(JSON.stringify({node:process.version,mode,mixed,duration,columns:columns.length,bytes:Buffer.byteLength(output),elapsedMs:{median:ms[3],p95:ms[6]},includes:'process startup, analysis, CSV and stdout pipe'}));
  }
  const result=execFileSync(process.env.MOTAN_SCIPY_PYTHON??'python3',['-c',`import csv,io,json,sys,struct
x=json.load(sys.stdin)
def decode(text):
 rows=list(csv.reader(io.StringIO(text,newline='')))
 return rows[0],[[struct.pack('>d',float(v)) if i<=8 else v for i,v in enumerate(row)] for row in rows[1:]]
decoded=list(map(decode,x));a=decoded[0]
assert all(a==b for b in decoded[1:])
print(json.dumps(dict(numeric_bits_and_scalar_text_exact=True,rows=len(a[1]))))`],{input:JSON.stringify(outputs),encoding:'utf8',maxBuffer:32*1024**2});
  console.log(result.trim());
 }
}finally{await rm(dir,{recursive:true,force:true});}
