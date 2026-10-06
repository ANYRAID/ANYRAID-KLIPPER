console.log('motion:loading');
const {motionPlots,motionPositions}=await import("file:///home/dek02/.cache/codex/tmp/anyraid-moonraker-machine-control/host/src/diagnostics/graph-motion.ts");
const {motionGraphReference}=await import("file:///home/dek02/.cache/codex/tmp/anyraid-moonraker-machine-control/host/bench/motion-graph-reference.ts");
const {default:assert}=await import('node:assert/strict');
const {writeFileSync}=await import('node:fs');
const {serialize}=await import('node:v8');
const profile={order:4,jerkLimit:true},reference=motionGraphReference('weighted4',undefined,profile);
console.log('motion:loaded');
for(let run=0;run<16;run++){
 const positions=motionPositions(profile);assert.equal(positions.length,reference.positions.length);
 positions.forEach((v,i)=>{const expected=reference.positions[i],difference=v-expected,absolute=Math.abs(difference),within=absolute<=1e-12;if(!within){
  const capture=new URL('motion-mismatch-'+process.pid+'-'+run+'.bin',import.meta.url);
  writeFileSync(capture,serialize({version:3,kind:'positions',run,index:i,comparison:{actual:v,expected,difference,absolute,within,tolerance:1e-12},positions,reference}),{flag:'wx',mode:0o600,flush:true});
  const repeated=motionPositions(profile);writeFileSync(new URL(capture.href+'.repeat'),serialize({positions:repeated}),{flag:'wx',mode:0o600,flush:true});
  throw new Error('Motion position mismatch '+JSON.stringify({run,index:i,actual:v,expected:reference.positions[i],repeated:repeated[i],capture:capture.href}));
 }});
 let stages;const panels=motionPlots('weighted4',undefined,profile,value=>{stages=value;});assert.equal(panels.length,reference.panels.length);
 panels.forEach((p,i)=>{const r=reference.panels[i];assert.equal(p.plot.curves.length,r.curves.length);p.plot.curves.forEach((c,j)=>{
  const expected=r.curves[j];assert.deepEqual(c.times,expected.times);assert.equal(c.values.length,expected.values.length);
  c.values.forEach((v,k)=>{const target=expected.values[k],difference=v-target,absolute=Math.abs(difference),tolerance=[1e-8,1e-4,1e-10][i],within=absolute<=tolerance;if(!within){
   // Persist the first failure before recomputing: a successful repeat must
   // never replace the arrays that actually failed. V8 serialization retains
   // non-finite numbers and negative zero, which JSON would discard.
   const capture=new URL('motion-mismatch-'+process.pid+'-'+run+'.bin',import.meta.url);
   writeFileSync(capture,serialize({version:3,run,panel:i,curve:j,index:k,comparison:{actual:v,expected:target,difference,absolute,within,tolerance},positions,stages,panels,reference}),{flag:'wx',mode:0o600,flush:true});
   const repeatedPanels=motionPlots('weighted4',undefined,profile);
   const repeated=repeatedPanels[i].plot.curves[j].values[k];
   writeFileSync(new URL(capture.href+'.repeat'),serialize({positions:motionPositions(profile),panels:repeatedPanels}),{flag:'wx',mode:0o600,flush:true});
   const bits=x=>{const bytes=Buffer.alloc(8);bytes.writeDoubleLE(x);return bytes.readBigUInt64LE();};
   const xor='0x'+(bits(v)^bits(expected.values[k])).toString(16);
   throw new Error('Motion numerical mismatch '+JSON.stringify({run,panel:i,curve:j,index:k,actual:v,expected:expected.values[k],error:v-expected.values[k],xor,repeated,capture:capture.href,nearby:c.values.slice(Math.max(0,k-2),k+3),reference:expected.values.slice(Math.max(0,k-2),k+3)}));
  }});
 });});
}
console.log('motion:verified');
