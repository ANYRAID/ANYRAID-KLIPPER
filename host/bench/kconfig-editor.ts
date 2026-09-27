import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {parseKconfig} from '../src/kconfig/parser.ts';
import {KconfigEditor} from '../src/kconfig/editor.ts';
const tree=await parseKconfig(fileURLToPath(new URL('../../',import.meta.url)));
const reference=JSON.parse(await readFile(new URL('../contracts/kconfig-editor-reference.json',import.meta.url),'utf8'));
const samples:number[]=[];let maxEditMs=0;
for(let run=0;run<18;run++){
 const editor=new KconfigEditor(tree);const start=performance.now();
 for(const step of reference.steps){
  const editStart=performance.now();
  editor.set(step.name,step.value);
  editor.items();editor.search(step.name,true);editor.dirty;
  assert.equal(editor.full(),step.full);assert.equal(editor.minimal(),step.minimal);
  if(run>=3)maxEditMs=Math.max(maxEditMs,performance.now()-editStart);
 }
 if(run>=3)samples.push(performance.now()-start);
}
samples.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,editsPerJourney:reference.steps.length,warmups:3,runs:samples.length,medianJourneyMs:samples[7],p95JourneyMs:samples[14],maximumEditMs:maxEditMs,scope:'15 architecture/visibility/string/numeric edits including recomputation, root menu, search, dirty state, full/minimal snapshots; excludes parsing, terminal rendering and file IO. Not a printing path.'},null,2));
