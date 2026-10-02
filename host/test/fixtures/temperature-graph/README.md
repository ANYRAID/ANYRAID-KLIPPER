# Temperature graph reference contract

`reference.json` contains outputs captured from commit `f35ba564` before
retiring `scripts/graph_temp_sensor.py`. It records SHA-256 hashes for the
original plotting script, reference adapter, Python conversion modules and
sensor configuration. The original GPL-3.0-or-later attribution remains in
the TypeScript diagnostic implementation.

The 16 sensor names are ordered explicitly. Four cases cover 4700 ohm / 5 V
and 2200 ohm / 3.3 V, each in ADC/resolution and resistance modes. Temperature
samples are consecutive integer degrees starting at 1: 349 for each ADC and
delta curve, 350 for resistance. All 33,536 values are preserved as JSON
numbers, without rounding or downsampling.

The old tool's `thermistor.load_config` registration entry was unavailable.
The captured adapter used the original plotting loops and original sensor
conversion classes, with thermistor data from `temperature_sensors.cfg`.
This is a numerical reference, not evidence that the old CLI was runnable.

To audit or regenerate, use a detached checkout of `f35ba564`, verify the
recorded source hashes, then call that checkout's
`host/bench/temperature-graph-reference.ts` export `temperatureGraphReference`
with each of the four `{sensors, pullup, voltage, resistance}` cases. Use
`runs:16`, discard the first five timing samples, retain every curve value,
and verify that every temperature grid is the expected integer sequence.
Regeneration requires the historical Python reference environment. Normal
Node tests and benchmarks do not import or execute it. Never regenerate the
contract using the Node implementation under test.

Stored timing samples are historical measurements from the recorded CPU,
not current Python performance. The Node benchmark reports live computation
and PNG export separately, and enforces desktop computation budgets of
25 ms median / 50 ms p95 per full 16-sensor plot. Those budgets catch gross
regressions; they are not target-board or physical sensor acceptance limits.
