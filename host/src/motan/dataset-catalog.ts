// GPL-3.0-or-later. Dataset descriptions from readlog.py and analyzers.py.
// Preserve handler ordering and the historical accelerometer/adxl345 alias rows.
const raw:readonly (readonly [string,string])[]=[
 ["accelerometer(<name>,<axis>)", "Accelerometer for given axis (x, y, or z)"],
 ["accelerometer(<name>,<axis>)", "Accelerometer for given axis (x, y, or z)"],
 ["angle(<name>)", "Angle sensor position"],
 ["ldc1612(<name>)", "Coil resonant frequency"],
 ["ldc1612(<name>,period)", "Coil resonant period"],
 ["ldc1612(<name>,z)", "Estimated Z height"],
 ["loadcell(<name>)", "Force reading from load cell"],
 ["loadcell(<name>,counts)", "Raw ADC counts from load cell"],
 ["stallguard(<stepper>,sg_result)", "Stallguard result of the given stepper driver"],
 ["stallguard(<stepper>,cs_actual)", "Current level result of the given stepper driver"],
 ["status(<field>)", "A get_status field name (separate by periods)"],
 ["step_phase(<driver>)", "Stepper motor phase of the given stepper"],
 ["step_phase(<driver>,microstep)", "Microstep position for stepper"],
 ["stepq(<stepper>)", "Commanded position of the given stepper"],
 ["stepq(<stepper>,<time>)", "Commanded position with smooth time"],
 ["trapq(<name>,velocity)", "Requested velocity for the given trapq"],
 ["trapq(<name>,accel)", "Requested acceleration for the given trapq"],
 ["trapq(<name>,<axis>)", "Requested axis (x, y, or z) position"],
 ["trapq(<name>,<axis>_velocity)", "Requested axis velocity"],
 ["trapq(<name>,<axis>_accel)", "Requested axis acceleration"],
];
const derived:readonly (readonly [string,string])[]=[
 ["corexy(x,<stepper>,<stepper>)", "Toolhead x position from steppers"],
 ["corexy(y,<stepper>,<stepper>)", "Toolhead y position from steppers"],
 ["derivative(<dataset>)", "Derivative of the given dataset"],
 ["deviation(<dataset1>,<dataset2>)", "Difference between datasets"],
 ["integral(<dataset>)", "Integral of the given dataset"],
 ["integral(<dataset1>,<dataset2>)", "Integral with dataset2 as reference"],
 ["integral(<dataset1>,<dataset2>,<half_life>)", "Integral with weighted half-life time"],
 ["kin(<stepper>)", "Stepper position derived from toolhead kinematics"],
 ["norm2(<dataset1>,<dataset2>)", "pointwise 2-norm of dataset1 and dataset2"],
 ["norm2(<dataset1>,<dataset2>,<dataset3>)", "pointwise 2-norm of 3 datasets"],
 ["smooth(<dataset>)", "Generate moving weighted average of a dataset"],
 ["smooth(<dataset>,<smooth_time>)", "Generate moving weighted average of a dataset with a given smoothing time that defines the window size"],
 ["sos(<dataset>,{filt,filtfilt},highpass,<order>,<hz>)", "SOS highpass filtered dataset"],
 ["sos(<dataset>,{filt,filtfilt},lowpass,<order>,<hz>)", "SOS lowpass filtered dataset"],
 ["sos(<dataset>,{filt,filtfilt},bandpass,<order>,<lowhz>,<highhz>)", "SOS lowpass filtered dataset"],
 ["sos(<dataset>,{filt,filtfilt},notch,<hz>,<quality>)", "SOS notch filtered dataset"],
];
/** Syntax catalog, independent of a particular log or its subscriptions.
 * A listed operator can still reject unsupported scalar types or parameters. */
export function listMotanDatasets():readonly (readonly [string,string])[]{
 return Object.freeze([...raw,...derived].map(row=>Object.freeze([...row] as [string,string])));
}
export function formatMotanDatasets():string{
 return '\nAvailable datasets:\n'+listMotanDatasets().map(([name,description])=>name.padEnd(24)+': '+description+'\n').join('')+'\n';
}
