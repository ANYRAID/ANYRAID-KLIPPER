#!/usr/bin/env node
import {preflightProductMachine} from '../host/src/runtime/product-machine-profile.ts';
const args=process.argv.slice(2);
try{
 if(args.length===1&&['--help','-h'].includes(args[0]))process.stdout.write('Usage: node scripts/product-preflight.js --machine /absolute/machine.json\nRead-only configuration and topology check; does not validate hardware or permit printing.\n');
 else{
  if(args.length!==2||args[0]!=='--machine')throw new Error('Expected --machine /absolute/machine.json');
  const {config,reader,connections,plan}=await preflightProductMachine(args[1],new AbortController().signal);
  process.stdout.write(JSON.stringify({schema:1,state:'topology_validated',deviceId:config.deviceId,hardwareValidated:false,allOptionsValidated:false,sections:reader.sections(),mcus:connections.map(({plan})=>({id:plan.id,transport:plan.transport})),motors:plan.motion.map(m=>({id:m.emitter,mode:m.mode})),heaters:plan.layout.heaters.map(h=>h.section)},null,2)+'\n');
 }
}catch(error){process.stderr.write('Product Preflight Error: '+(error instanceof Error?error.message:String(error))+'\n');process.exitCode=1;}
