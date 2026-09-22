// Offline diagnostic export. Never imported by the motion or thermal loop.
import PDFDocument from 'pdfkit';
import SVGtoPDF from 'svg-to-pdfkit';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import {create} from 'fontkit';

const font=(bold:boolean)=>fileURLToPath(new URL(bold?'../../assets/fonts/DejaVuSans-Bold.ttf':'../../assets/fonts/DejaVuSans.ttf',import.meta.url));
const limit=64*1024**2;
const fonts=await Promise.all([false,true].map(async bold=>{const bytes=await readFile(font(bold));const parsed=create(bytes);if(!('hasGlyphForCodePoint' in parsed))throw new Error('Expected a single diagnostic font');return {bytes,parsed};}));
const supported=new Set<number>();
function checkText(svg:string):void{
 // All diagnostic renderers emit plain escaped text, not arbitrary SVG markup.
 for(const match of svg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)){
  const value=match[1].replace(/&(amp|lt|gt|quot|apos);/g,(_entity,name:string)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[name]!));
  for(const char of value){const point=char.codePointAt(0)!;if(supported.has(point)||char==='\n'||char==='\r'||char==='\t')continue;
   if(fonts.some(font=>!font.parsed.hasGlyphForCodePoint(point)))throw new Error(`Diagnostic PDF font lacks U+${point.toString(16).toUpperCase()}; use SVG/PNG or rename the label`);
   supported.add(point);
  }
 }
}

/** Convert our generated SVG only; this is not an arbitrary SVG upload parser. */
export async function diagnosticPdf(svg:string,signal:AbortSignal):Promise<Buffer>{
 signal.throwIfAborted();
 if(Buffer.byteLength(svg)>limit)throw new RangeError('Diagnostic SVG limit exceeded');
 const dimensions=/^<svg\b[^>]*\bwidth="(\d+)"\s+height="(\d+)"/.exec(svg);
 if(!dimensions)throw new Error('Expected generated diagnostic SVG dimensions');
 const width=Number(dimensions[1]),height=Number(dimensions[2]);
 if(width<1||height<1||width>14400||height>14400||width*height>16*1024**2)throw new RangeError('Diagnostic PDF page limit exceeded');
 checkText(svg);
 const doc=new PDFDocument({size:[width,height],margin:0,compress:true,info:{Title:'ANYRAID diagnostic plots',Creator:'ANYRAID Node host'}});
 const chunks:Buffer[]=[];let bytes=0;
 const output=new Promise<Buffer>((resolve,reject)=>{
  doc.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>limit)doc.destroy(new RangeError('Diagnostic PDF output limit exceeded'));else chunks.push(chunk);});
  doc.once('end',()=>resolve(Buffer.concat(chunks)));
  doc.once('error',reject);
 });
 // A synchronous rendering failure must not leave a rejected stream unobserved.
 void output.catch(()=>{});
 const abort=()=>doc.destroy(signal.reason instanceof Error?signal.reason:new Error('Diagnostic PDF cancelled'));
 signal.addEventListener('abort',abort,{once:true});
 try{
  doc.registerFont('Diagnostic',fonts[0].bytes);doc.registerFont('Diagnostic-Bold',fonts[1].bytes);
  SVGtoPDF(doc,svg,0,0,{width,height,assumePt:true,
   fontCallback:(_family,bold)=>bold?'Diagnostic-Bold':'Diagnostic',
   imageCallback:(link)=>{if(!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(link))throw new Error('External diagnostic images are forbidden');return link;},
   documentCallback:()=>{throw new Error('External diagnostic documents are forbidden');},
   warningCallback:(warning)=>{throw new Error('Diagnostic PDF rendering failed: '+warning);},
  });
  signal.throwIfAborted();doc.end();return await output;
 }catch(error){doc.destroy(error instanceof Error?error:new Error('Diagnostic PDF failed'));throw error;}finally{signal.removeEventListener('abort',abort);}
}
