import {MessageDictionary} from '../src/protocol/dictionary.ts';
import {compileSpi,spiFormats,legacySpiConfig} from '../src/protocol/spi-config.ts';
const results=[];
for(const legacy of [false,true]){
 const d=new MessageDictionary();d.identify(Buffer.from(JSON.stringify({commands:{[legacy?legacySpiConfig:spiFormats.config]:10,[spiFormats.bus]:11,[spiFormats.send]:12,[spiFormats.transfer]:13},responses:{[spiFormats.response]:14},enumerations:{pin:{PA0:0},spi_bus:{spi1:0}},config:{}})),false);
 const chip={},cs={chip,chipName:'mcu',pin:'PA0',invert:0 as const,pullup:0 as const},samples:number[]=[];let count=0;
 for(let run=0;run<9;run++){const start=performance.now();for(let i=0;i<10000;i++)count+=compileSpi(chip,d,0,cs,'spi1',400000,0).select.length;if(run>=2)samples.push(performance.now()-start);}
 samples.sort((a,b)=>a-b);results.push({legacy,iterations:10000,warmups:2,samples:7,medianMs:samples[3],maxMs:samples[6],checksum:count});
}
console.log(JSON.stringify({node:process.version,scope:'SPI configuration compilation only; no IO or print hot path',results},null,2));
