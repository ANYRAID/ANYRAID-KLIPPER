#!/usr/bin/env node
// GPL-3.0-or-later. Offline commissioning only; do not query during a print.
import {parseArgs} from 'node:util';
import {openCanDiscovery,queryCanDevices} from '../host/src/diagnostics/can-query.ts';
const usage='Usage: node scripts/canbus_query.ts <can interface>\nDiscover unassigned nodes; do not run during an active print.\n';
const controller=new AbortController(),stop=()=>controller.abort(new Error('CAN discovery cancelled'));process.once('SIGINT',stop);process.once('SIGTERM',stop);
try{
 const {values,positionals}=parseArgs({allowPositionals:true,options:{help:{type:'boolean',short:'h'}}});
 if(values.help)process.stdout.write(usage);
 else{if(positionals.length!==1)throw new Error(usage);const devices=await queryCanDevices(openCanDiscovery(positionals[0]),controller.signal);for(const d of devices)process.stdout.write(`Found canbus_uuid=${d.uuid}, Application: ${d.application}\n`);process.stdout.write(`Total ${devices.length} uuids found\n`);}
}catch(error){process.stderr.write((error instanceof Error?error.message:String(error))+'\n');process.exitCode=1;}finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
