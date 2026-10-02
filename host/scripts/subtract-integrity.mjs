// Standalone JS control: intentionally imports no application code or addons.
import {readFileSync} from 'node:fs';
const rounds=Number(process.argv[3]);if(process.argv.length!==4||!Number.isSafeInteger(rounds)||rounds<1||rounds>100000)throw Error('Expected fixture and rounds 1..100000');
const bytes=readFileSync(process.argv[2]);if(!bytes.length||bytes.length%16||bytes.length>1600000)throw Error('Invalid paired binary64 input');
const count=bytes.length/16,left=new Float64Array(count),right=new Float64Array(count);for(let i=0;i<count;i++){left[i]=bytes.readDoubleLE(i*16);right[i]=bytes.readDoubleLE(i*16+8);}
const bits=value=>{const b=Buffer.alloc(8);b.writeDoubleLE(value);return b.readBigUInt64LE().toString(16).padStart(16,'0');};
let failed=false;for(let run=0;run<rounds&&!failed;run++)for(let index=0;index<count;index++){
 const a=left[index],b=right[index],difference=a-b;if(!Number.isFinite(a)||!Number.isFinite(b)||difference!==0){console.log(JSON.stringify({run,index,a:bits(a),b:bits(b),difference:bits(difference)}));failed=true;break;}
}
if(failed)process.exitCode=2;else console.log(`subtract:verified:${rounds}:${count}`);
