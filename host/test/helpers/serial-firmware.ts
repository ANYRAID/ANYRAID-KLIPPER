import {deflateSync} from 'node:zlib';
import {MessageDictionary} from '../../src/protocol/dictionary.ts';
import {FrameDecoder,encodeFrame} from '../../src/protocol/codec.ts';
import {serialClock} from '../../src/protocol/serial-queue.ts';
import {serialPair} from './serial-pair.ts';
export async function serialFirmware<T extends {fd:number;peer:{on(event:'data',callback:(chunk:Buffer|string)=>void):unknown;write(data:Uint8Array):unknown};close():Promise<void>}=Awaited<ReturnType<typeof serialPair>>>(provided?:T){
 const pair=provided??await serialPair() as unknown as T,dictionary=new MessageDictionary();const compressed=deflateSync(Buffer.from(JSON.stringify({commands:{'config_analog_in oid=%c pin=%u':27,'query_analog_in oid=%c clock=%u sample_ticks=%u sample_count=%c rest_ticks=%u bytes_per_report=%c min_value=%hu max_value=%hu range_check_count=%c':28,'config_pwm_out oid=%c pin=%u cycle_ticks=%u value=%hu default_value=%hu max_duration=%u':24,'queue_pwm_out oid=%c clock=%u value=%hu':25,'set_digital_out_pwm_cycle oid=%c cycle_ticks=%u':26,'config_digital_out oid=%c pin=%u value=%c default_value=%c max_duration=%u':21,'update_digital_out oid=%c value=%c':22,'queue_digital_out oid=%c clock=%u on_ticks=%u':23,get_uptime:2,get_clock:3,get_config:10,'config_stepper oid=%c step_pin=%u dir_pin=%u invert_step=%c step_pulse_ticks=%u':14,'reset_step_clock oid=%c clock=%u':15,'stepper_get_position oid=%c':16,'allocate_oids count=%c':11,'finalize_config crc=%u':12,'echo value=%u':6,'queue_step oid=%c interval=%u count=%hu add=%hi':8,'set_next_step_dir oid=%c dir=%c':9},responses:{'analog_in_state oid=%c next_clock=%u values=%*s':29,'shutdown clock=%u static_string_id=%hu':18,'is_shutdown static_string_id=%hu':19,'starting':20,'stepper_position oid=%c pos=%i':17,'config is_config=%c crc=%u is_shutdown=%c move_count=%hu':13,'uptime high=%u clock=%u':4,'clock clock=%u':5,'echo_response value=%u':7},enumerations:{static_string_id:{'Timer too close':1,'Command request':2},pin:{PA0:0,PA1:1}},config:{ADC_MAX:4095,PWM_MAX:255,STEPPER_STEP_BOTH_EDGE:1,CLOCK_FREQ:1e6,RECEIVE_WINDOW:256}})));dictionary.identify(compressed);
 const delayed=new Set<ReturnType<typeof setTimeout>>();let echoDelay=0,holdEcho=false;const heldEchoes:Uint8Array[]=[];const decoder=new FrameDecoder(),start=serialClock.now();let ignored:string|undefined,frames=0,sequence=1,configured=0,configCRC=0;const outputs:{name:string;parameters:Record<string,unknown>}[]=[];const stepperConfigs:Record<string,unknown>[]=[];const motion:{name:string;parameters:Record<string,unknown>;time:number}[]=[];
 pair.peer.on('data',(chunk:Buffer|string)=>{for(const frame of decoder.push(typeof chunk==='string'?Buffer.from(chunk):chunk)){frames++;if((frame[1]&15)!==sequence){pair.peer.write(encodeFrame(sequence,new Uint8Array()));continue;}const seq=(frame[1]+1)&15;sequence=seq;
  for(const cmd of dictionary.parseFrame(frame)){
   if(cmd.name===ignored)continue;
   if(['config_analog_in','query_analog_in','config_digital_out','update_digital_out','queue_digital_out','config_pwm_out','queue_pwm_out','set_digital_out_pwm_cycle'].includes(cmd.name)){outputs.push({name:cmd.name,parameters:cmd.parameters});continue;}
   if(cmd.name==='queue_step'||cmd.name==='set_next_step_dir'){motion.push({name:cmd.name,parameters:cmd.parameters,time:serialClock.now()});continue;}
   if(cmd.name==='allocate_oids'||cmd.name==='reset_step_clock')continue;
   if(cmd.name==='config_stepper'){stepperConfigs.push({...cmd.parameters});continue;}
   if(cmd.name==='finalize_config'){configured=1;configCRC=cmd.parameters.crc as number;continue;}
   const ticks=Math.round(1e6+(serialClock.now()-start)*1e6);let payload:Uint8Array;
   if(cmd.name==='identify'){const offset=cmd.parameters.offset as number;payload=dictionary.encode('identify_response',{offset,data:compressed.subarray(offset,offset+40)});}
   else if(cmd.name==='stepper_get_position')payload=dictionary.encode('stepper_position',{oid:cmd.parameters.oid,pos:0});
   else if(cmd.name==='get_config')payload=dictionary.encode('config',{is_config:configured,crc:configCRC,is_shutdown:0,move_count:512});
   else if(cmd.name==='get_uptime')payload=dictionary.encode('uptime',{high:0,clock:ticks});
   else if(cmd.name==='get_clock')payload=dictionary.encode('clock',{clock:ticks});
   else payload=dictionary.encode('echo_response',{value:cmd.parameters.value});
   // Firmware command_add_frame reads next_sequence when sending, not
   // when the request arrived; other commands may have advanced it meanwhile.
   if(cmd.name==='echo'&&holdEcho)heldEchoes.push(payload);
   else if(cmd.name==='echo'&&echoDelay){const timer=setTimeout(()=>{delayed.delete(timer);pair.peer.write(encodeFrame(sequence,payload));},echoDelay);delayed.add(timer);}else pair.peer.write(encodeFrame(seq,payload));
  }
  pair.peer.write(encodeFrame(seq,new Uint8Array()));
 }});
 return {...pair,async close(){for(const timer of delayed)clearTimeout(timer);delayed.clear();heldEchoes.length=0;await pair.close();},holdEcho(){holdEcho=true;},releaseEcho(){holdEcho=false;for(const payload of heldEchoes.splice(0))pair.peer.write(encodeFrame(sequence,payload));},delayEcho(milliseconds:number){echoDelay=milliseconds;},dictionary,motion,stepperConfigs,outputs,get frames(){return frames;},emit(name:string,parameters:Parameters<MessageDictionary['encode']>[1]={}){pair.peer.write(encodeFrame(sequence,dictionary.encode(name,parameters)));},emitEcho(value:number){pair.peer.write(encodeFrame(sequence,dictionary.encode('echo_response',{value})));},ignore(name:string){ignored=name;}};
}
