/** Test-only Python oracle in ignored cache. Never installs into system Python. */
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const directory=new URL('../node_modules/.cache/jinja-reference/',import.meta.url);
const packages=[
 {name:'Jinja2',version:'3.1.6',file:'jinja2-3.1.6-py3-none-any.whl',sha256:'85ece4451f492d0c13c5dd7c13a64681a86afae63a5f347908daf103ce6d2f67'},
 {name:'MarkupSafe',version:'3.0.3',file:'markupsafe-3.0.3-cp312-cp312-manylinux2014_x86_64.manylinux_2_17_x86_64.manylinux_2_28_x86_64.whl',sha256:'d6dd0be5b5b189d31db7cda48b91d7e0a9795f31430b7f271219ab30f1d3ac9d'},
];
await mkdir(directory,{recursive:true});
for(const entry of packages){
 const destination=new URL(entry.file,directory);let bytes:Buffer;
 try{bytes=await readFile(destination);}catch{
  const response=await fetch(`https://pypi.org/pypi/${entry.name}/${entry.version}/json`,{signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error('Cannot resolve oracle wheel');
  const metadata=await response.json() as {urls:{filename:string;url:string;digests:{sha256:string}}[]};const wheel=metadata.urls.find(wheel=>wheel.filename===entry.file&&wheel.digests.sha256===entry.sha256);if(!wheel)throw new Error('Pinned oracle wheel is unavailable');
  const download=await fetch(wheel.url,{signal:AbortSignal.timeout(30000)});if(!download.ok)throw new Error('Cannot download oracle wheel');bytes=Buffer.from(await download.arrayBuffer());
 }
 if(createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw new Error('Oracle wheel hash mismatch');await writeFile(destination,bytes);
 const extract=spawnSync('python3',['-c','import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])',fileURLToPath(destination),fileURLToPath(directory)],{encoding:'utf8',timeout:10000});if(extract.status!==0)throw new Error('Oracle extraction failed: '+extract.stderr);
}
await writeFile(new URL('manifest.json',directory),JSON.stringify(packages,null,2)+'\n');
const verify=spawnSync('python3',['-c','import sys;sys.path.insert(0,sys.argv[1]);import jinja2,markupsafe;assert jinja2.__version__=="3.1.6";assert str(markupsafe.escape("<"))=="&lt;"',fileURLToPath(directory)],{encoding:'utf8',timeout:10000});if(verify.status!==0)throw new Error('Oracle verification failed: '+verify.stderr);console.log('Jinja2 oracle verified in project cache');
