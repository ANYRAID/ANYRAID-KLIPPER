import type { AcceptedFirmwareCommand } from './serial-firmware.ts';

/** Test-only receive-count model. Match src/stepper.c's SF_NEED_RESET and
 * src/trsync.c's one-shot, per-MCU signal ownership. It does not emulate
 * physical step execution or provide an accuracy/clock acceptance result. */
export class StepperStopFence {
  #steps = new Map<number, { reset: boolean; direction: number; clock?: number }>();
  #triggers = new Map<number, Set<number>>();
  #events: object[] = [];
  #eventSequence = 0;
  #dropped = 0;
  readonly currentClock: () => number;
  constructor(currentClock: () => number) { this.currentClock = currentClock; }
  #step(oid: number) {
    let step = this.#steps.get(oid);
    if (!step) { step = { reset: false, direction: -1 }; this.#steps.set(oid, step); }
    return step;
  }
  #record(event: object) {
    if (this.#events.length === 128) { this.#events.shift(); this.#dropped++; }
    this.#events.push({ sequence: ++this.#eventSequence, receivedClock: this.currentClock(), ...event });
  }
  direction(oid: number): number { return this.#step(oid).direction; }
  get observation() { return { dropped: this.#dropped, events: [...this.#events] }; }
  /** Called at the physical endstop event, or for accepted trsync_trigger. */
  trigger(oid: number): void {
    const bound = this.#triggers.get(oid);
    if (!bound) return; // Duplicate/unarmed trigger never stops a new owner.
    this.#triggers.delete(oid);
    for (const stepper of bound) {
      const step = this.#step(stepper);
      step.reset = true; step.direction = -1; step.clock = undefined;
    }
    this.#record({ kind: 'trigger', oid, stopped: [...bound] });
  }
  /** False means queue_step is discarded by firmware until reset_step_clock.
   * Observe only commands accepted by serialFirmware, never another decoder. */
  observe({ name, parameters: p }: AcceptedFirmwareCommand): boolean {
    const oid = Number(p.oid);
    if (name === 'trsync_start') {
      this.#triggers.set(oid, new Set());
      this.#record({ kind: name, oid });
    } else if (name === 'stepper_stop_on_trigger') {
      const trigger = Number(p.trsync_oid), bound = this.#triggers.get(trigger);
      if (!bound) throw new Error('Wire model received a stepper binding before trsync_start');
      if ([...this.#triggers.values()].some(set => set.has(oid))) throw new Error('Wire model stepper already bound');
      bound.add(oid); this.#record({ kind: name, oid, trigger });
    } else if (name === 'trsync_trigger') this.trigger(oid);
    else if (name === 'reset_step_clock') {
      const step = this.#step(oid); step.reset = false; step.clock = Number(p.clock);
      this.#record({ kind: name, oid, requestedClock: step.clock });
    } else if (name === 'set_next_step_dir') this.#step(oid).direction = Number(p.dir) ? 1 : -1;
    else if (name === 'queue_step') {
      const step = this.#step(oid), interval = Number(p.interval), count = Number(p.count), add = Number(p.add);
      const firstClock = step.clock === undefined ? undefined : (step.clock + interval) >>> 0;
      const endClock = step.clock === undefined ? undefined : (step.clock + interval * count + add * count * (count - 1) / 2) >>> 0;
      this.#record({ kind: name, oid, interval, count, add, direction: step.direction, discarded: step.reset, firstClock, endClock });
      if (step.reset) return false;
      step.clock = endClock;
    }
    return true;
  }
}
