// GPL-3.0-or-later. Path models from graph_mesh.py, Eric Callahan (2024).
import type {MeshPoint} from './mesh-analysis.ts';
export type MeshPathType='points'|'path'|'rapid';
export interface MeshPathPlot {type:MeshPathType;title:string;travel:MeshPoint[];sampled:MeshPoint[];missing:MeshPoint[];bounds:{x:[number,number];y:[number,number]};}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('Expected mesh object');return value as Record<string,unknown>;}
function points(value:unknown):MeshPoint[]{if(!Array.isArray(value)||value.length>100000)throw new RangeError('Invalid mesh path size');return value.map(p=>{if(!Array.isArray(p)||p.length!==2||!p.every(Number.isFinite))throw new TypeError('Invalid mesh path point');return [p[0],p[1]];});}
const key=(p:MeshPoint)=>`${p[0]},${p[1]}`;
export function meshPathPlot(value:unknown,type:MeshPathType,scalePlot=false):MeshPathPlot{
 if(!['points','path','rapid'].includes(type))throw new RangeError('Unsupported mesh path type');const data=object(value),calibration=object(data.calibration),original=points(calibration.points);let travel:MeshPoint[]=[],sampled:MeshPoint[]=[],missing:MeshPoint[]=[];
 if(type==='points')sampled=original;else if(type==='path'){travel=points(calibration.probe_path);sampled=travel.slice(1,-1).map(p=>[...p]);const visited=new Set(travel.map(key));missing=original.filter(p=>!visited.has(key(p)));}else{if(!Array.isArray(calibration.rapid_path)||calibration.rapid_path.length>100000)throw new RangeError('Invalid rapid path');for(const item of calibration.rapid_path){if(!Array.isArray(item)||item.length!==2||typeof item[1]!=='boolean')throw new TypeError('Invalid rapid entry');const p=points([item[0]])[0];travel.push(p);if(item[1])sampled.push([...p]);}const visited=new Set(sampled.map(key));missing=original.filter(p=>!visited.has(key(p)));}
 let xmin=Infinity,xmax=-Infinity,ymin=Infinity,ymax=-Infinity;for(const group of [travel,sampled,missing])for(const [x,y] of group){xmin=Math.min(xmin,x);xmax=Math.max(xmax,x);ymin=Math.min(ymin,y);ymax=Math.max(ymax,y);}
 if(scalePlot){const low=data.axis_minimum,high=data.axis_maximum;if(!Array.isArray(low)||!Array.isArray(high)||low.length<2||high.length<2||![low[0],low[1],high[0],high[1]].every(Number.isFinite))throw new RangeError('Invalid machine axis limits');[xmin,ymin]=low;[xmax,ymax]=high;}else{if(xmin===Infinity){xmin=ymin=0;xmax=ymax=1;}else{const dx=(xmax-xmin)*.05||1,dy=(ymax-ymin)*.05||1;xmin-=dx;xmax+=dx;ymin-=dy;ymax+=dy;}}
 if(![xmin,xmax,ymin,ymax,xmax-xmin,ymax-ymin].every(Number.isFinite)||xmax<=xmin||ymax<=ymin)throw new RangeError('Invalid path display range');return {type,title:{points:'Generated Probe Points',path:'Probe Travel Path',rapid:'Rapid Scan Travel Path'}[type],travel,sampled,missing,bounds:{x:[xmin,xmax],y:[ymin,ymax]}};
}
/** Match legacy axis-aligned reveal frames; always include the final endpoint. */
export function meshPathAnimationFrames(travel: readonly MeshPoint[]): number[] {
 if (travel.length > 100000) throw new RangeError('Animation point limit exceeded');
 points(travel);
 if (!travel.length) return [];
 const frames = [1];
 for (let i = 1; i < travel.length; i++)
  if (travel[i][0] === travel[i-1][0] || travel[i][1] === travel[i-1][1]) frames.push(i+1);
 if (frames.at(-1) !== travel.length) frames.push(travel.length);
 return frames;
}
export function renderMeshPathSvg(plot:MeshPathPlot, animate=false):string{
 if (animate && !['path','rapid'].includes(plot.type)) throw new Error('Animation requires path or rapid plot');
 const groups=[plot.travel,plot.sampled,plot.missing];if(groups.reduce((n,g)=>n+g.length,0)>300000)throw new RangeError('Path display point limit exceeded');for(const g of groups)points(g);
 const [xmin,xmax]=plot.bounds.x,[ymin,ymax]=plot.bounds.y,dx=xmax-xmin,dy=ymax-ymin,factor=Math.min(800/dx,560/dy),w=dx*factor,h=dy*factor,left=100+(800-w)/2,top=65+(560-h)/2;
 if(![xmin,xmax,ymin,ymax,dx,dy,w,h].every(Number.isFinite)||dx<=0||dy<=0||w<=0||h<=0)throw new RangeError('Invalid path bounds');
 const x=(v:number)=>{const r=left+(v-xmin)/dx*w;if(!Number.isFinite(r)||Math.abs(r)>1e9)throw new RangeError('Path projection overflow');return r;},y=(v:number)=>{const r=top+(ymax-v)/dy*h;if(!Number.isFinite(r)||Math.abs(r)>1e9)throw new RangeError('Path projection overflow');return r;},fmt=(v:number)=>v.toFixed(3),label=(v:number)=>Number(v.toPrecision(5)).toString();
 const title={points:'Generated Probe Points',path:'Probe Travel Path',rapid:'Rapid Scan Travel Path'}[plot.type];if(!title)throw new RangeError('Invalid path type');const out=[`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="760" viewBox="0 0 1000 760" role="img"><title>${title}</title><desc>Equal physical X/Y scale in millimeters. Green triangle is start; red square is stop. Magenta rings mark missing points.</desc><style>text{font-family:DejaVu Sans,sans-serif;font-size:12px;fill:#172033}</style><rect width="1000" height="760" fill="white"/><text x="500" y="30" text-anchor="middle" style="font-size:18px">${title}</text><defs><clipPath id="path-area"><rect x="${left}" y="${top}" width="${w}" height="${h}"/></clipPath></defs>`];
 for(let i=0;i<=5;i++){const f=i/5,px=left+w*f,py=top+h*(1-f);out.push(`<path d="M${px} ${top}v${h}M${left} ${py}h${w}" stroke="#e2e8f0" fill="none"/><text x="${px}" y="${top+h+22}" text-anchor="middle">${label(xmin+dx*f)}</text><text x="${left-12}" y="${py+4}" text-anchor="end">${label(ymin+dy*f)}</text>`);}
 out.push('<g clip-path="url(#path-area)">');if(plot.travel.length)out.push(`<path ${animate?'data-mesh-animation="'+meshPathAnimationFrames(plot.travel).join(',')+'" ':''}d="${plot.travel.map((p,i)=>`${i?'L':'M'}${fmt(x(p[0]))} ${fmt(y(p[1]))}`).join('')}" fill="none" stroke="#2563eb" stroke-width="1.5"/>`);
 for(const p of plot.sampled)out.push(`<circle cx="${fmt(x(p[0]))}" cy="${fmt(y(p[1]))}" r="2.5" fill="${plot.type==='points'?'#2563eb':'#172033'}"/>`);for(const p of plot.missing)out.push(`<circle cx="${fmt(x(p[0]))}" cy="${fmt(y(p[1]))}" r="4" fill="none" stroke="#c026d3" stroke-width="2"/>`);
 if(plot.travel.length){const start=plot.travel[0],stop=plot.travel.at(-1)!,sx=x(start[0]),sy=y(start[1]);out.push(`<path d="M${sx-6} ${sy-6}L${sx+6} ${sy}L${sx-6} ${sy+6}Z" fill="#16a34a"/><rect x="${x(stop[0])-4}" y="${y(stop[1])-4}" width="8" height="8" fill="#dc2626"/>`);}
 out.push(`</g><rect x="${left}" y="${top}" width="${w}" height="${h}" stroke="#64748b" fill="none"/><text x="500" y="${top+h+48}" text-anchor="middle">X (mm)</text><text transform="translate(${left-65},${top+h/2}) rotate(-90)" text-anchor="middle">Y (mm)</text><text x="500" y="710" text-anchor="middle">Travel: blue line · Samples: dots · Missing: magenta rings</text><text x="500" y="735" text-anchor="middle">Start: green triangle · Stop: red square · ${plot.travel.length} travel points / ${plot.sampled.length} samples</text></svg>`);const result=out.join('');if(Buffer.byteLength(result)>64*1024**2)throw new RangeError('Path image size limit exceeded');return result;
}
