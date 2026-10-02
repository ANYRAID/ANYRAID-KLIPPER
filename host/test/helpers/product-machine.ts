import {deltaPrinterSections} from './delta-printer.ts';
import {ConfigurationReader} from '../../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../../src/moonraker/config-source.ts';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {configuredPrinterFixture} from './configured-printer.ts';
import {productTransports} from './product-transports.ts';
import type {ProductMachineConfiguration} from '../../src/config/product-machine.ts';
import type {ProductMachineBindings} from '../../src/runtime/product-machine-profile.ts';
export async function productMachineFixture(dir:string,delta=false,reset?:'ack'|'starting'){
 const f=await configuredPrinterFixture(false,false),transport=await productTransports(delta?new ConfigurationReader(new ConfigurationSource('/printer.cfg',deltaPrinterSections(f.reader.source.original),[]),null):f.reader,false,false,false,false,false,false,false,false,undefined,reset);
 const {output,open,lifecycle,...print}=f.options.print;
 const config:ProductMachineConfiguration={version:1,deviceId:'printer',printerConfig:join(dir,'printer.cfg'),moonrakerConfig:join(dir,'moonraker.conf'),journalPath:join(dir,'jobs.db'),mcus:Object.fromEntries([...transport.policies].map(([id,{stopDevice,...p}])=>[id,p])),machine:{enableLeadTime:.001,fanMinimumScheduleTime:.001},print,limits:{maxNozzle:300,maxBed:130},hardware:{heaterGcodeIds:f.options.hardware.heaterGcodeIds}};
 await writeFile(config.printerConfig,Object.entries(transport.reader.source.original).map(([section,options])=>'['+section+']\n'+Object.entries(options).map(([key,value])=>key+': '+value.replaceAll('\n','\n  ')).join('\n')).join('\n\n'));
 await writeFile(config.moonrakerConfig,'[server]\nhost=127.0.0.1\nport=0');const path=join(dir,'machine.json');await writeFile(path,JSON.stringify(config));let released=0;
 const bindings:ProductMachineBindings={stops:new Map([...transport.policies].map(([id,p])=>[id,p.stopDevice])),print:{output,open,lifecycle},server:{information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]},authorize:()=>{}},async release(){released++;}};
 return {path,config,bindings,transport,get releases(){return released;},async close(){await transport.close();await f.close();}};
}
