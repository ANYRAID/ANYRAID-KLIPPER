// Moonraker job_state.py semantics. GPL-3.0-or-later.
// Original: Copyright (C) 2021 Eric Callahan.
import { prepareStatus } from './subscription-status.ts';
import { ApiError, type Json } from './rpc.ts';
export type JobEvent =
  | 'standby'
  | 'started'
  | 'paused'
  | 'resumed'
  | 'complete'
  | 'error'
  | 'cancelled';
type Stats = Readonly<Record<string, Json>>;
export type JobChange =
  | { kind: 'state'; event: JobEvent; previous: Stats; current: Stats }
  | { kind: 'layer'; current: number; total: number };
const idle = (state: Json | undefined) =>
  ['standby', 'complete', 'cancelled', 'error'].includes(state as string);
function stats(value: unknown): Stats {
  const data = prepareStatus({ print_stats: value }).print_stats;
  if (
    data.state !== undefined &&
    ![
      'standby',
      'printing',
      'paused',
      'complete',
      'error',
      'cancelled',
    ].includes(data.state as string)
  )
    throw new ApiError(502, 'Invalid print_stats state');
  if (data.filename !== undefined && typeof data.filename !== 'string')
    throw new ApiError(502, 'Invalid print filename');
  if (
    data.total_duration !== undefined &&
    (typeof data.total_duration !== 'number' || data.total_duration < 0)
  )
    throw new ApiError(502, 'Invalid print duration');
  if (data.info !== undefined) {
    if (!data.info || typeof data.info !== 'object' || Array.isArray(data.info))
      throw new ApiError(502, 'Invalid print layer info');
    if (data.info.total_layer === null)
      throw new ApiError(502, 'Invalid total layer');
    for (const key of ['current_layer', 'total_layer']) {
      const value = data.info[key];
      if (
        value !== undefined &&
        value !== null &&
        (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
      )
        throw new ApiError(502, 'Invalid print layer');
    }
  }
  return data;
}
/** Observational only: emits no device commands and grants no recovery authority. */
export class JobState {
  #stats: Stats = Object.freeze({});
  #event: JobEvent = 'standby';
  get lastEvent(): JobEvent {
    return this.#event;
  }
  get lastStats(): Stats {
    return structuredClone(this.#stats);
  }
  initialize(value: unknown): void {
    this.#stats = stats(value);
  }
  disconnect(): void {
    if (['printing', 'paused'].includes(this.#stats.state as string)) {
      this.#stats = Object.freeze({ ...this.#stats, state: 'error' });
      this.#event = 'error';
    }
  }
  update(value: unknown): readonly JobChange[] {
    const delta = stats(value),
      previous = this.#stats;
    const current = Object.freeze({ ...previous, ...delta });
    if (Object.keys(current).length > 256)
      throw new ApiError(502, 'Too many accumulated print stats fields');
    const changes: JobChange[] = [];
    const emit = (event: JobEvent) => {
      changes.push(Object.freeze({ kind: 'state', event, previous, current }));
    };
    if (
      delta.state !== undefined &&
      previous.state !== undefined &&
      delta.state !== previous.state
    ) {
      let event = delta.state as JobEvent | 'printing';
      if (idle(previous.state)) {
        if (event === 'printing') event = 'started';
        else if (event !== 'standby') emit('started');
      } else if (event === 'printing') {
        event =
          previous.state === 'paused' &&
          previous.filename === current.filename &&
          typeof previous.total_duration === 'number' &&
          typeof current.total_duration === 'number' &&
          previous.total_duration < current.total_duration
            ? 'resumed'
            : 'started';
      }
      emit(event as JobEvent);
    }
    if (
      delta.info &&
      typeof delta.info === 'object' &&
      !Array.isArray(delta.info)
    ) {
      const layer = delta.info.current_layer;
      if (typeof layer === 'number')
        changes.push(
          Object.freeze({
            kind: 'layer',
            current: layer,
            total: (delta.info.total_layer ?? 0) as number,
          }),
        );
    }
    this.#stats = current;
    for (const change of changes)
      if (change.kind === 'state') this.#event = change.event;
    return Object.freeze(changes);
  }
}
