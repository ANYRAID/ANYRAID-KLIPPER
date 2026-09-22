import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const host=fileURLToPath(new URL('..',import.meta.url));
function run(args:string[],env:NodeJS.ProcessEnv=process.env):void {
  const result=spawnSync(process.execPath,args,{cwd:host,stdio:'inherit',timeout:60000,env});
  if(result.status!==0)throw new Error(`Sanitized check failed: ${result.error??result.status}`);
}
const lookup=spawnSync(process.env.CC??'cc',['-print-file-name=libasan.so'],{encoding:'utf8'});
const runtime=lookup.stdout.trim();
if(lookup.status!==0||!existsSync(runtime))throw new Error('Compiler AddressSanitizer runtime was not found');
for(const address of [false,true]) {
  const flag=address?'--address':'--sanitize',suffix=address?'asan':'ubsan';
  run(['scripts/build-native.ts',flag]);run(['scripts/build-stepcompress.ts',flag]);run(['scripts/build-serialqueue.ts',flag]);run(['scripts/build-unix-peer.ts',flag]);run(['scripts/build-sealed-file.ts',flag]);run(['scripts/build-can-query.ts',flag]);run(['scripts/build-ar100-flash.ts','--testing',flag]);
  const env:NodeJS.ProcessEnv={...process.env,
    ANYRAID_AR100_TEST_ADDON:fileURLToPath(new URL(`../build/ar100-flash-test-${suffix}.node`,import.meta.url)),
    ANYRAID_CAN_QUERY_ADDON:fileURLToPath(new URL(`../build/can-query-${suffix}.node`,import.meta.url)),
    ANYRAID_SEALED_FILE_ADDON:fileURLToPath(new URL(`../build/sealed-file-${suffix}.node`,import.meta.url)),
    ANYRAID_UNIX_PEER_ADDON:fileURLToPath(new URL(`../build/unix-peer-${suffix}.node`,import.meta.url)),
    ANYRAID_SERIALQUEUE_ADDON:fileURLToPath(new URL(`../build/serialqueue-${suffix}.node`,import.meta.url)),
    ANYRAID_TRAPQ_ADDON:fileURLToPath(new URL(`../build/trapq-${suffix}.node`,import.meta.url)),
    ANYRAID_STEPCOMPRESS_ADDON:fileURLToPath(new URL(`../build/stepcompress-${suffix}.node`,import.meta.url)),
  };
  if(address) {
    env.LD_PRELOAD=[runtime,process.env.LD_PRELOAD].filter(Boolean).join(':');
    // Node/V8 owns uninstrumented process-global allocations: check access and
    // lifetime errors, without claiming process-wide leak accounting.
    env.ASAN_OPTIONS='detect_leaks=0:abort_on_error=1';
  }
  run(['--test','test/trap-queue.test.ts','test/step-compressor.test.ts','test/step-solver.test.ts','test/corexz.test.ts','test/native-shaper.test.ts','test/pressure-advance.test.ts','test/native-delta.test.ts','test/motion-coordinator.test.ts','test/coordinated-retirement.test.ts','test/partial-flush.test.ts','test/clock-calibration.test.ts','test/secondary-sync.test.ts','test/clock-runtime.test.ts','test/serial-queue.test.ts','test/native-trdispatch.test.ts','test/serial-session.test.ts','test/serial-trigger.test.ts','test/homing-stop.test.ts','test/homing-rebuild.test.ts','test/homing-recovery.test.ts','test/homing-toolhead.test.ts','test/homing-trigger-group.test.ts','test/serial-clock-provenance.test.ts','test/serial-motion.test.ts','test/motion-retirement.test.ts','test/native-position.test.ts','test/step-history.test.ts','test/uart.test.ts','test/usb-bootloader.test.ts','test/firmware-fault.test.ts','test/mcu-group.test.ts','test/serial-ack.test.ts','test/serial-batch.test.ts','test/digital-output.test.ts','test/pwm-output.test.ts','test/adc-input.test.ts','test/serial-adc-temperature.test.ts','test/unix-peer.test.ts','test/sealed-file.test.ts','test/snapshot-budget.test.ts','test/published-files.test.ts','test/published-recovery.test.ts','test/published-delete.test.ts','test/can-query.test.ts','test/can-query-native.test.ts','test/flash-ar100.test.ts'],env);
}
