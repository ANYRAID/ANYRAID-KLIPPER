import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const host=fileURLToPath(new URL('..',import.meta.url));
function run(args:string[],env:NodeJS.ProcessEnv=process.env):void {
  const started=performance.now();
  const result=spawnSync(process.execPath,args,{cwd:host,stdio:'inherit',timeout:60000,env});
  console.log(JSON.stringify({sanitizedCommand:args,elapsedMs:performance.now()-started,status:result.status,signal:result.signal}));
  if(result.status!==0)throw new Error(`Sanitized check failed: ${result.error??result.status}; signal=${result.signal??'none'}; command=${JSON.stringify(args)}`);
}
const lookup=spawnSync(process.env.CC??'cc',['-print-file-name=libasan.so'],{encoding:'utf8'});
const runtime=lookup.stdout.trim();
if(lookup.status!==0||!existsSync(runtime))throw new Error('Compiler AddressSanitizer runtime was not found');
for(const address of [false,true]) {
  const flag=address?'--address':'--sanitize',suffix=address?'asan':'ubsan';
  run(['scripts/build-native.ts',flag]);run(['scripts/build-stepcompress.ts',flag]);run(['scripts/build-serialqueue.ts',flag]);run(['scripts/build-unix-peer.ts',flag]);run(['scripts/build-sealed-file.ts',flag]);run(['scripts/build-file-events.ts',flag]);run(['scripts/build-can-query.ts',flag]);run(['scripts/build-ar100-flash.ts','--testing',flag]);
  const env:NodeJS.ProcessEnv={...process.env,
    ANYRAID_FILE_EVENTS_ADDON:fileURLToPath(new URL(`../build/file-events-${suffix}.node`,import.meta.url)),
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
  const tests=['test/print-clock.test.ts','test/boundary-output-transfer.test.ts','test/lookahead-batch.test.ts','test/motion.test.ts','test/path-stop.test.ts','test/boundary-markers.test.ts','test/motion-boundary-output.test.ts','test/bed-mesh-port.test.ts','test/trap-queue.test.ts','test/trapq-future.test.ts','test/step-compressor.test.ts','test/step-solver.test.ts','test/corexz.test.ts','test/native-shaper.test.ts','test/pressure-advance.test.ts','test/native-delta.test.ts','test/motion-coordinator.test.ts','test/coordinated-retirement.test.ts','test/partial-flush.test.ts','test/clock-calibration.test.ts','test/secondary-sync.test.ts','test/clock-runtime.test.ts','test/serial-queue.test.ts','test/native-trdispatch.test.ts','test/serial-session.test.ts','test/serial-trigger.test.ts','test/homing-stop.test.ts','test/homing-stop-set.test.ts','test/homing-rebuild.test.ts','test/homing-recovery.test.ts','test/homing-toolhead.test.ts','test/homing-trigger-group.test.ts','test/homing-trigger-set.test.ts','test/homing-drip.test.ts','test/homing-linear-command.test.ts','test/homing-move-execution.test.ts','test/endstop-rate.test.ts','test/homing-retract-execution.test.ts','test/homing-prepare.test.ts','test/homing-group-plan.test.ts','test/homing-linear-seek.test.ts','test/homing-native-linear-port.test.ts','test/native-pause-parking.test.ts','test/native-pause-boundary.test.ts','test/native-file-motion.test.ts','test/native-idle-fault.test.ts','test/native-linear-gcode.test.ts','test/native-fan-gcode.test.ts','test/native-linear-print.test.ts','test/thermal-print-device.test.ts','test/async-heaters.test.ts','test/stop-notice.test.ts','test/motion-streamer.test.ts','test/motion-streamer-pause.test.ts','test/idle-motion.test.ts','test/gcode-dispatch.test.ts','test/gcode-file-execution.test.ts','test/file-print-device.test.ts','test/planned-motion-source.test.ts','test/source-brake.test.ts','test/motion-stop-rebase.test.ts','test/rebuilt-motion.test.ts','test/serial-clock-provenance.test.ts','test/serial-motion.test.ts','test/motion-retirement.test.ts','test/native-position.test.ts','test/step-history.test.ts','test/uart.test.ts','test/usb-bootloader.test.ts','test/firmware-fault.test.ts','test/mcu-group.test.ts','test/coordinated-drain.test.ts','test/serial-ack.test.ts','test/serial-batch.test.ts','test/digital-output.test.ts','test/pwm-output.test.ts','test/fan.test.ts','test/fan-boundaries.test.ts','test/fan-native.test.ts','test/generation-pwm.test.ts','test/adc-input.test.ts','test/serial-adc-temperature.test.ts','test/unix-peer.test.ts','test/sealed-file.test.ts','test/snapshot-budget.test.ts','test/published-files.test.ts','test/published-recovery.test.ts','test/published-delete.test.ts','test/can-query.test.ts','test/can-query-native.test.ts','test/flash-ar100.test.ts','test/recovery-filters.test.ts','test/motor-enable.test.ts','test/motor-release.test.ts','test/linear-motion-config.test.ts','test/stepper-distance-config.test.ts','test/stepper-config.test.ts','test/configured-steppers.test.ts','test/pins.test.ts','test/physical-pin-ownership.test.ts','test/mcu-oids.test.ts','test/configured-motor-enable.test.ts','test/always-on-motors.test.ts','test/configured-homing.test.ts','test/configured-cooling-fan.test.ts','test/configured-analog-heater.test.ts','test/configured-hardware.test.ts','test/hardware-startup.test.ts','test/configured-motion-emitters.test.ts','test/auxiliary-motion.test.ts','test/initial-motion.test.ts','test/native-port-disposal.test.ts','test/initial-linear.test.ts','test/configured-target-barrier.test.ts','test/configured-print.test.ts','test/linear-homing-config.test.ts','test/configured-printer.test.ts','test/group-print-clocks.test.ts','test/connected-printer.test.ts','test/product-printer.test.ts','test/product-service.test.ts','test/configured-uart.test.ts','test/configured-mcu-connections.test.ts','test/can-connect.test.ts','test/pipe-lock.test.ts','test/board-pins.test.ts','test/linear-printer.test.ts'];
  tests.push('test/file-events.test.ts');
  run(['scripts/build-file-write-lease.ts',flag]);
  env.ANYRAID_FILE_WRITE_LEASE_HELPER=fileURLToPath(new URL(`../build/file-write-lease-${suffix}`,import.meta.url));
  tests.push('test/file-write-lease.test.ts','test/native-ufp-disk-imports.test.ts');
  tests.push('test/native-file-start-accounting.test.ts');
  tests.push('test/print-clock-timeline.test.ts');
  tests.push('test/periodic-clock-calibration.test.ts');
  tests.push('test/idle-clock-calibration.test.ts');
  tests.push('test/idle-clock-scheduler.test.ts');
  tests.push('test/heating-clock-calibration.test.ts');
  tests.push('test/paused-clock-calibration.test.ts');
  tests.push('test/homing-clock-calibration.test.ts');
  tests.push('test/print-retirement.test.ts','test/product-host.test.ts');
  tests.push('test/product-machine.test.ts');
  tests.push('test/native-host-status.test.ts');
  tests.push('test/native-objects.test.ts','test/gcode-move.test.ts','test/async-heater-runtime.test.ts');
  tests.push('test/native-subscriptions.test.ts','test/print-layer-info.test.ts');
  tests.push('test/dwell.test.ts');
  tests.push('test/arcs.test.ts');
  tests.push('test/velocity-limits.test.ts');
  tests.push('test/retraction.test.ts');
  tests.push('test/display-status.test.ts');
  tests.push('test/pressure-advance-settings.test.ts');
  // The deadline covers the whole invocation, including queued files. Give
  // each file its own child so earlier paced cases cannot consume its budget.
  // Keep every test and the original 60-second deadline, without retrying.
  if(new Set(tests).size!==tests.length)throw new Error('Duplicate sanitized test file');
  for(const file of tests)run(['--test','--test-reporter=tap',file],env);
}
