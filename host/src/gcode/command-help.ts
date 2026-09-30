/** Descriptions for native implementations. A description is exposed only when
 * that command is registered; this catalogue never grants command admission. */
export const nativeCommandHelp:Readonly<Record<string,string>>=Object.freeze({
 SET_GCODE_OFFSET:'Set the G-code coordinate offset',
 SAVE_GCODE_STATE:'Save G-code coordinate state',
 RESTORE_GCODE_STATE:'Restore saved G-code coordinate state',
 SET_VELOCITY_LIMIT:'Set configured motion velocity and acceleration limits',
 SET_PRESSURE_ADVANCE:'Set pressure advance and smoothing time',
 SET_RETRACTION:'Set firmware retraction parameters',
 GET_RETRACTION:'Report firmware retraction parameters',
 ACTIVATE_EXTRUDER:'Select a configured extruder',
 SET_DISPLAY_TEXT:'Set the display message',
 SET_PRINT_STATS_INFO:'Set print layer information',
 EXCLUDE_OBJECT_START:'Mark the start of an object in the print file',
 EXCLUDE_OBJECT_END:'Mark the end of an object in the print file',
 EXCLUDE_OBJECT:'Exclude an object from the current print',
 EXCLUDE_OBJECT_DEFINE:'Define print object metadata',
 SET_HEATER_TEMPERATURE:'Set a configured heater target temperature',
 TURN_OFF_HEATERS:'Turn off all configured heaters',
 TEMPERATURE_WAIT:'Wait for a configured temperature to reach the requested range',
 QUERY_ADC:'Report an analog input reading',
 SET_PIN:'Set a configured output pin',
 SET_SERVO:'Set a configured servo position',
 SET_TMC_CURRENT:'Set a configured TMC driver current',
 SAVE_CONFIG:'Save pending configuration changes',
 BED_MESH_PROFILE:'Load a saved bed mesh profile',
 BED_MESH_CLEAR:'Clear the active bed mesh',
 BED_MESH_OFFSET:'Set the active bed mesh offset'
});
