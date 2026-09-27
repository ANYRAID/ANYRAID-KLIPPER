import {readFileSync,statSync} from 'node:fs';
import {inspectMotionCapture} from '../src/diagnostics/motion-capture.ts';
if(process.argv.length!==3)throw new Error('Usage: node host/scripts/inspect-motion-capture.ts capture.bin[.gz]');
const path=process.argv[2],info=statSync(path);if(!info.isFile()||info.size>32*1024*1024)throw new Error('Invalid capture file');
console.log(JSON.stringify(inspectMotionCapture(readFileSync(path)),null,2));
