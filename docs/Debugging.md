# Debugging

This document describes some of the Klipper debugging tools.

## Running the regression tests

The main Klipper GitHub repository uses "github actions" to run a
series of regression tests. It can be useful to run some of these
tests locally.

The source code "whitespace check" requires Node.js 26 (or an absolute
Node path supplied via the `NODE` environment variable) and no npm
dependencies. It can be run with:
```
./scripts/check_whitespace.sh
```

The Klippy regression test suite requires "data dictionaries" from
many platforms. The easiest way to obtain them is to
[download them from github](https://github.com/Klipper3d/klipper/issues/1438).
Once the data dictionaries are downloaded, use the following to run
the regression suite:
```
tar xfz klipper-dict-20??????.tar.gz
~/klippy-env/bin/python ~/klipper/scripts/test_klippy.py -d dict/ ~/klipper/test/klippy/*.test
```

## Estimating AVR stack usage

With AVR binutils and Node.js 26 installed, inspect a firmware disassembly:

```
avr-objdump -d out/klipper.elf | node scripts/checkstack.ts
```

The tool preserves the previous AVR stack heuristic, including preamble,
call, tail-call, command-table and event-handler accounting. The reported
values are estimates, not proven stack bounds: indirect calls and recursive
cycles cannot establish the actual worst-case usage. It is not an analyzer
for every MCU architecture. No npm dependencies are required.

## Manually sending commands to the micro-controller

Normally, the host klippy.py process would be used to translate gcode
commands to Klipper micro-controller commands. However, it's also
possible to manually send these MCU commands (functions marked with
the DECL_COMMAND() macro in the Klipper source code). To do so, run:

```
~/klippy-env/bin/python ./klippy/console.py /tmp/pseudoserial
```

See the "HELP" command within the tool for more information on its
functionality.

Some command-line options are available. For more information run:
`~/klippy-env/bin/python ./klippy/console.py --help`

## Translating gcode files to micro-controller commands

The Klippy host code can run in a batch mode to produce the low-level
micro-controller commands associated with a gcode file. Inspecting
these low-level commands is useful when trying to understand the
actions of the low-level hardware. It can also be useful to compare
the difference in micro-controller commands after a code change.

To run Klippy in this batch mode, there is a one time step necessary
to generate the micro-controller "data dictionary". This is done by
compiling the micro-controller code to obtain the **out/klipper.dict**
file:

```
make menuconfig
make
```

Once the above is done it is possible to run Klipper in batch mode
(see [installation](Installation.md) for the steps necessary to build
the python virtual environment and a printer.cfg file):

```
~/klippy-env/bin/python ./klippy/klippy.py ~/printer.cfg -i test.gcode -o test.serial -v -d out/klipper.dict
```

The above will produce a file **test.serial** with the binary serial
output. This output can be translated to readable text with:

```
~/klippy-env/bin/python ./klippy/parsedump.py out/klipper.dict test.serial > test.txt
```

The resulting file **test.txt** contains a human readable list of
micro-controller commands.

The batch mode disables certain response / request commands in order
to function. As a result, there will be some differences between
actual commands and the above output. The generated data is useful for
testing and inspection; it is not useful for sending to a real
micro-controller.

## Motion analysis and data logging

Klipper supports logging its internal motion history, which can be
later analyzed. To use this feature, Klipper must be started with the
[API Server](API_Server.md) enabled.

Data logging is enabled with the `data_logger.py` tool. For example:
```
~/klipper/scripts/motan/data_logger.py /tmp/klippy_uds mylog -s '*'
```

This command will connect to the Klipper API Server, subscribe to
status and motion information, and log the results. Two files are
generated - a compressed data file and an index file (eg,
`mylog.json.gz` and `mylog.index.gz`). After starting the logging, it
is possible to complete prints and other actions - the logging will
continue in the background. When done logging, hit `ctrl-c` to exit
from the `data_logger.py` tool.

The resulting files can be read and graphed using the `motan_graph.py`
tool. To generate graphs on a Raspberry Pi, a one time step is
necessary to install the "matplotlib" package:
```
sudo apt-get update
sudo apt-get install python-matplotlib
```
However, it may be more convenient to copy the data files to a desktop
class machine along with the Python code in the `scripts/motan/`
directory. The motion analysis scripts should run on any machine with
a recent version of [Python](https://python.org) and
[Matplotlib](https://matplotlib.org/) installed.

Graphs can be generated with a command like the following:
```
~/klipper/scripts/motan/motan_graph.py mylog -o mygraph.png
```

One can use the `-g` option to specify the datasets to graph (it takes
a Python literal containing a list of lists). For example:
```
~/klipper/scripts/motan/motan_graph.py mylog -g '[["trapq(toolhead,velocity)"], ["trapq(toolhead,accel)"]]'
```

The list of available datasets can be found using the `-l` option -
for example:
```
~/klipper/scripts/motan/motan_graph.py -l
```

It is also possible to specify matplotlib plot options for each
dataset:
```
~/klipper/scripts/motan/motan_graph.py mylog -g '[["trapq(toolhead,velocity)?color=red&alpha=0.4"]]'
```
Many matplotlib options are available; some examples are "color",
"label", "alpha", and "linestyle".

The `motan_graph.py` tool supports several other command-line
options - use the `--help` option to see a list. It may also be
convenient to view/modify the
[motan_graph.py](../scripts/motan/motan_graph.py) script itself.

The raw data logs produced by the `data_logger.py` tool follow the
format described in the [API Server](API_Server.md). It may be useful
to inspect the data with a Unix command like the following:
`gunzip < mylog.json.gz | tr '\03' '\n' | less`

## Generating load graphs

The Klippy log file (/tmp/klippy.log) stores statistics on bandwidth,
micro-controller load, and host buffer load. It can be useful to graph
these statistics after a print.

For file export with Node.js 26, install the host dependencies once and run:

```
npm --prefix ~/klipper/host ci
node ~/klipper/scripts/graphstats.ts /tmp/klippy.log -o loadgraph.png
```

The Node tool supports SVG, PNG, JPEG, WebP, TIFF, and JSON curve data. Use
`-s` for system load, `-f` for MCU frequency, `-m` to select an MCU, or
`-t heater_bed,extruder` for temperatures. An output filename is required;
run `node ~/klipper/scripts/graphstats.ts --help` for the options.

The original Python tool is still required for its interactive window and
other export formats such as PDF/EPS. For that tool, install the
"matplotlib" package:

```
sudo apt-get update
sudo apt-get install python-matplotlib
```

Then graphs can be produced with:

```
~/klipper/scripts/graphstats.py /tmp/klippy.log -o loadgraph.png
```

One can then view the resulting **loadgraph.png** file.

Different graphs can be produced. For more information run:
`~/klipper/scripts/graphstats.py --help`

## Generating extruder motion graphs

For an offline illustration of extruder pressure advance, the Node.js 26
tool generates the original fixed sample motion and compares nominal,
raw pressure advance, and smoothed pressure advance velocities:

```
node ~/klipper/scripts/graph_extruder.ts -o extruder.png
```

It uses the same installed host dependencies and export formats as the
Node load graph tool. The horizontal axis is elapsed seconds. This is a
diagnostic simulation, not a calibration command or a hardware validation.
The original `graph_extruder.py` remains available for its interactive
Matplotlib window and PDF/EPS export.

## Generating input shaper simulation graphs

The Node.js 26 tool exports the frequency response and unit step response
in a single file, using the same host dependencies as the tools above:

```
node ~/klipper/scripts/graph_shaper.ts -o shaper.png
node ~/klipper/scripts/graph_shaper.ts --shaper zvd --shaper_freq 45 --system_freq 60 -o shaper.svg
```

Use `--damping_ratio`, `--test_damping_ratios` (comma separated), and
`--system_damping_ratio` to adjust damping. Run with `--help` for defaults.
The output formats are SVG, PNG, JPEG, WebP, TIFF, and JSON. JSON contains
an array of two panels, each with its plot data and horizontal axis label.
The simulation does not configure a printer or measure physical resonance.
The original `graph_shaper.py` remains available for an interactive
Matplotlib window and PDF/EPS export.

## Generating temperature sensor graphs

With Node.js 26 and the host dependencies installed, plot the built-in
analog sensors without connecting to a printer:

```
node ~/klipper/scripts/graph_temp_sensor.ts -o sensors.png
node ~/klipper/scripts/graph_temp_sensor.ts -s "Generic 3950,PT1000" -p 4700 -v 5 -r -o resistance.svg
```

The default output contains ADC and absolute ADC change per degree curves;
`-r` selects the original pullup-based resistance formula. For voltage
sensors this is a formula-derived equivalent, not their physical resistance.
`-s` selects comma-separated sensor names, `-p` changes the pullup resistance,
and `-v` changes ADC voltage. `--help` lists the 16 supported built-in sensors.
The available file formats are SVG, PNG, JPEG, WebP, TIFF, and JSON panels.
These curves do not establish sensor accuracy or a safe heater temperature
range. The legacy Python script currently references a removed thermistor
registration function; its interactive window is not replaced by this tool.

## Generating the legacy motion demonstration

The Node.js 26 motion tool generates velocity, acceleration, and modeled
belt-spring deviation in one file:

```
node ~/klipper/scripts/graph_motion.ts -o motion.png
```

It uses the original script's fixed moves and legacy EI example, which is
different from the current production input shaper. It does not change
printer configuration. The acceleration image clips to ±15000 mm/s²;
JSON keeps all numerical values. It supports the same file formats as the
other Node graph tools above. Experimental filters can be selected directly:

```
node ~/klipper/scripts/graph_motion.ts --filter weighted4 --smooth_time 0.020 -o motion.png
```

Available filters are `average`, `smooth`, `weighted`, `weighted2`,
`weighted3`, `weighted4`, `spring_raw`, and `spring_double_weighted`.
The smoothing default is `(2/3)/40` seconds; `spring_raw` has no smoothing
parameter. Windows must fit the fixed 50 ms margin. Use `--accel_order 4`
or `--accel_order 6` for the original higher-order position curves, and
`--jerk_limit` for the original fixed jerk limit. These options can be
combined with a filter; the default acceleration order is 2. For example:

```
node ~/klipper/scripts/graph_motion.ts --accel_order 6 --jerk_limit --filter weighted4 -o motion.png
```

Use `--legacy_shaper` to select the original motion script's `zv`, `zvd`,
`mzv`, `ei`, `2hump_ei`, or `3hump_ei` formula. This option is mutually
exclusive with `--filter`; it can be combined with acceleration order and
jerk options. The default remains legacy `ei`.

These are offline diagnostic experiments, not production planner settings.
The legacy formulas are distinct from the current production definitions
used by `graph_shaper.ts`. The Python script remains as a differential
reference and for its interactive window and PDF/EPS output.

## Generating accelerometer and frequency graphs

Use Node.js 26 with the host dependencies installed:

```
node ~/klipper/scripts/graph_accelerometer.ts -r -o acceleration.png raw_data.csv
node ~/klipper/scripts/graph_accelerometer.ts -f 200 -a all -o frequency.svg raw_data.csv
node ~/klipper/scripts/graph_accelerometer.ts -a x -o comparison.png first.csv second.csv
```

Raw mode plots all three axes after subtracting each axis mean. Frequency
mode accepts raw samples or processed PSD files; a single XYZ spectrum shows
the total and three axes, while multiple datasets are shown separately.
Selecting an axis requires that axis to exist in every dataset. Previously
normalized files retain their values. Supported outputs are SVG, PNG,
JPEG, WebP, TIFF, and JSON panels. Long curve names and offsets are retained
in JSON and SVG titles even when the visible legend is shortened.
Frequency CSV export is also available:

```
node ~/klipper/scripts/graph_accelerometer.ts -f 200 -o resonances.csv first.csv second.csv
```

CSV output uses all available axes for one dataset, or a common 0.2 Hz grid
for multiple datasets. The upper frequency bound is exclusive for CSV.
Values retain full double precision, so text differs from the Python
tool's rounded output. Normalized input remains marked as normalized;
mixing normalized and unnormalized datasets is rejected. Raw graph mode
(`-r`) cannot be combined with CSV output.
Spectrogram CSV export accepts one raw log and an optional axis:

```
node ~/klipper/scripts/graph_accelerometer.ts -s -a all -o spectrogram.csv raw_data.csv
```

Its first column contains frequency and the remaining columns contain time
frames, with a literal `freq\t` header followed by relative time centers.
The export includes all frequencies regardless of `-f`, matching the Python
CSV convention, and preserves double precision. Processed PSD input and
combining `-s` with `-r` are rejected. Spectrogram images, interactive windows,
and PDF/EPS still require the original Python tool. These offline graphs do not measure print quality or configure
the printer.

## Extracting information from the klippy.log file

The Klippy log file (/tmp/klippy.log) also contains debugging
information. There is a Node.js 26 logextract.ts script that may be useful when
analyzing a micro-controller shutdown or similar problem. It is
typically run with something like:

```
mkdir work_directory
cd work_directory
cp /tmp/klippy.log .
node ~/klipper/scripts/logextract.ts ./klippy.log
```

This tool requires Node.js 26 and no npm dependencies. It preserves log
integer precision and only writes diagnostic files; it does not execute
the extracted G-code.

The script will extract the printer config file and will extract MCU
shutdown information. The information dumps from an MCU shutdown (if
present) will be reordered by timestamp to assist in diagnosing cause
and effect scenarios.

## Testing with simulavr

The [simulavr](http://www.nongnu.org/simulavr/) tool enables one to
simulate an Atmel ATmega micro-controller. This section describes how
one can run test gcode files through simulavr. It is recommended to
run this on a desktop class machine (not a Raspberry Pi) as it does
require significant cpu to run efficiently.

To use simulavr, download the simulavr package and compile with python
support. Note that the build system may need to have some packages (such as
swig) installed in order to build the python module.

```
git clone git://git.savannah.nongnu.org/simulavr.git
cd simulavr
make python
make build
```
Make sure a file like **./build/pysimulavr/_pysimulavr.*.so** is present
after the above compilation:
```
ls ./build/pysimulavr/_pysimulavr.*.so
```
This command should report a specific file (e.g.
**./build/pysimulavr/_pysimulavr.cpython-39-x86_64-linux-gnu.so**) and
not an error.

If you are on a Debian-based system (Debian, Ubuntu, etc.) you can
install the following packages and generate *.deb files for system-wide
installation of simulavr:
```
sudo apt update
sudo apt install g++ make cmake swig rst2pdf help2man texinfo
make cfgclean python debian
sudo dpkg -i build/debian/python3-simulavr*.deb
```

To compile Klipper for use in simulavr, run:

```
cd /path/to/klipper
make menuconfig
```

and compile the micro-controller software for an AVR atmega644p and
select SIMULAVR software emulation support. Then one can compile
Klipper (run `make`) and then start the simulation with:

```
PYTHONPATH=/path/to/simulavr/build/pysimulavr/ ./scripts/avrsim.py out/klipper.elf
```
Note that if you have installed python3-simulavr system-wide, you do
not need to set `PYTHONPATH`, and can simply run the simulator as
```
./scripts/avrsim.py out/klipper.elf
```

Then, with simulavr running in another window, one can run the
following to read gcode from a file (eg, "test.gcode"), process it
with Klippy, and send it to Klipper running in simulavr (see
[installation](Installation.md) for the steps necessary to build the
python virtual environment):

```
~/klippy-env/bin/python ./klippy/klippy.py config/generic-simulavr.cfg -i test.gcode -v
```

### Using simulavr with gtkwave

One useful feature of simulavr is its ability to create signal wave
generation files with the exact timing of events. To do this, follow
the directions above, but run avrsim.py with a command-line like the
following:

```
PYTHONPATH=/path/to/simulavr/src/python/ ./scripts/avrsim.py out/klipper.elf -t PORTA.PORT,PORTC.PORT
```

The above would create a file **avrsim.vcd** with information on each
change to the GPIOs on PORTA and PORTB. This could then be viewed
using gtkwave with:

```
gtkwave avrsim.vcd
```
