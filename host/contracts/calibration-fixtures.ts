/** Input recipes for the fixed, pre-retirement Python/NumPy calibration oracle.
 * Keep arithmetic order stable; each UTF-8 input is checked against its hash. */
export function calibrationLogFixtures(){
 const raw=(count:number)=>Array.from({length:count},(_,i)=>`${i/3200},${3+200*Math.sin(2*Math.PI*43*i/3200)},${100*Math.cos(2*Math.PI*67*i/3200)},${50*Math.sin(2*Math.PI*123*i/3200)}`).join('\n');
 const rows=Array.from({length:512},(_,i)=>`${i},${i*.3},${i*.2},${i*.1},${i*.6}`).join('\n');
 return {raw:raw(8192),rawLarge:raw(65536),axes:'freq,psd_x,psd_y,psd_z,psd_xyz\n'+rows,normalized:'freq,psd_x,psd_y,psd_z,psd_xyz,shapers:,mzv\n'+rows.split('\n').map(s=>s+',,.2').join('\n'),multi:'freq,"run, A",run B,shapers:,mzv\n'+Array.from({length:512},(_,i)=>`${i},${i*.3},${i*.4},,.5`).join('\n')};
}
export function calibrationCliFixture(){return 'freq,psd_x,psd_y,psd_z,psd_xyz\n'+Array.from({length:256},(_,i)=>{const f=i*.9,p=.01+Math.exp(-(((f-43)/7)**2));return `${f},0,0,${p},${p}`;}).join('\n');}
