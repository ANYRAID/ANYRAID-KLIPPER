import {PrinterPins} from '../../src/protocol/pins.ts';
import {MessageDictionary} from '../../src/protocol/dictionary.ts';
import {ConfigurationReader} from '../../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../../src/moonraker/config-source.ts';
export function stepperBatchFixture(reserved=false){
 const dictionary=new MessageDictionary();dictionary.identify(Buffer.from(JSON.stringify({commands:{get_config:8,'allocate_oids count=%c':9,'finalize_config crc=%u':10,'config_stepper oid=%c step_pin=%c dir_pin=%c invert_step=%c step_pulse_ticks=%u':7,'queue_step oid=%c interval=%u count=%hu add=%hi':2,'set_next_step_dir oid=%c dir=%c':3,'reset_step_clock oid=%c clock=%u':4,'stepper_get_position oid=%c':5},responses:{'config is_config=%c crc=%u is_shutdown=%c move_count=%hu':11,'stepper_position oid=%c pos=%i':6},enumerations:{pin:{PA0:0,PA0_ALIAS:0,PA1:1,PA2:2,PA3:3,PA3_ALIAS:3,PA4:4,PA5:5,PA6:6,PA7:7}},config:{CLOCK_FREQ:1e6,...reserved?{RESERVE_PINS_debug:'PA3'}:{}}})),false);
 const pins=new PrinterPins<object>(),chip={},aux={};pins.register('mcu',chip);pins.register('aux',aux);pins.resolver('mcu').alias('STEP','PA0');return {pins,mcus:new Map([['mcu',{chip,dictionary}],['aux',{chip:aux,dictionary}]]),dictionary};
}
export const batchReader=(second:Record<string,string>={})=>new ConfigurationReader(new ConfigurationSource('/steppers.cfg',{stepper_x:{step_pin:'!STEP',dir_pin:'!PA1',rotation_distance:'40',microsteps:'16'},stepper_y:{step_pin:'PA2',dir_pin:'PA3',rotation_distance:'40',microsteps:'16',...second}},[]),null);
