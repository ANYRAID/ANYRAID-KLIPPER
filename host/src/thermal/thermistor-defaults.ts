// Calibration data from temperature_sensors.cfg at 2a3d4b70. GPL-3.0-or-later.
import type { ThermistorModel } from './thermistor.ts';
export const thermistorDefaults: Readonly<Record<string, ThermistorModel>> = {
  'ATC Semitec 104GT-2': {
    points: [
      [20.0, 126800.0],
      [150.0, 1360.0],
      [300.0, 80.65],
    ],
  },
  'ATC Semitec 104NT-4-R025H42G': {
    points: [
      [25.0, 100000.0],
      [160.0, 1074.0],
      [300.0, 82.78],
    ],
  },
  'EPCOS 100K B57560G104F': {
    points: [
      [25.0, 100000.0],
      [150.0, 1641.9],
      [250.0, 226.15],
    ],
  },
  'Generic 3950': {
    points: [
      [25.0, 100000.0],
      [150.0, 1770.0],
      [250.0, 230.0],
    ],
  },
  'SliceEngineering 450': {
    points: [
      [25.0, 500000.0],
      [200.0, 3734.0],
      [400.0, 240.0],
    ],
  },
  'TDK NTCG104LH104JT1': {
    points: [
      [25.0, 100000.0],
      [50.0, 31230.0],
      [125.0, 2066.0],
    ],
  },
  'Honeywell 100K 135-104LAG-J01': { point: [25.0, 100000.0], beta: 3974.0 },
  'NTC 100K MGB18-104F39050L32': { point: [25.0, 100000.0], beta: 4100.0 },
};
for (const model of Object.values(thermistorDefaults)) {
  if ('points' in model) {
    for (const point of model.points) Object.freeze(point);
    Object.freeze(model.points);
  } else Object.freeze(model.point);
  Object.freeze(model);
}
Object.freeze(thermistorDefaults);
