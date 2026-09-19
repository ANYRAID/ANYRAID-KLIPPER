import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const host=fileURLToPath(new URL('..',import.meta.url));
function run(args:string[],env:NodeJS.ProcessEnv=process.env):void {
  const result=spawnSync(process.execPath,args,{cwd:host,stdio:'inherit',timeout:60000,env});
  if(result.status!==0)throw new Error(`Sanitized check failed: ${result.error??result.status}`);
}
run(['scripts/build-native.ts','--sanitize']);
run(['--test','test/trap-queue.test.ts'],{...process.env,ANYRAID_TRAPQ_ADDON:fileURLToPath(new URL('../build/trapq-ubsan.node',import.meta.url))});
const lookup=spawnSync(process.env.CC??'cc',['-print-file-name=libasan.so'],{encoding:'utf8'});
const runtime=lookup.stdout.trim();
if(lookup.status!==0||!existsSync(runtime))throw new Error('Compiler AddressSanitizer runtime was not found');
run(['scripts/build-native.ts','--address']);
run(['--test','test/trap-queue.test.ts'],{
  ...process.env,
  ANYRAID_TRAPQ_ADDON:fileURLToPath(new URL('../build/trapq-asan.node',import.meta.url)),
  LD_PRELOAD:[runtime,process.env.LD_PRELOAD].filter(Boolean).join(':'),
  // Uninstrumented Node/V8 own process-global allocations. This checks memory
  // access/lifetime violations, not process-wide leak accounting.
  ASAN_OPTIONS:'detect_leaks=0:abort_on_error=1',
});
run(['scripts/build-stepcompress.ts','--sanitize']);
run(['--test','test/step-compressor.test.ts'],{...process.env,ANYRAID_STEPCOMPRESS_ADDON:fileURLToPath(new URL('../build/stepcompress-ubsan.node',import.meta.url))});
run(['scripts/build-stepcompress.ts','--address']);
run(['--test','test/step-compressor.test.ts'],{
  ...process.env,ANYRAID_STEPCOMPRESS_ADDON:fileURLToPath(new URL('../build/stepcompress-asan.node',import.meta.url)),
  LD_PRELOAD:[runtime,process.env.LD_PRELOAD].filter(Boolean).join(':'),ASAN_OPTIONS:'detect_leaks=0:abort_on_error=1',
});
