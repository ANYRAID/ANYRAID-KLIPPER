import {createHash} from 'node:crypto';
/** Wrap renderer-owned SVG, not arbitrary uploaded XML. Data labels remain
 * escaped by the SVG renderer; the allowlist prevents active SVG constructs. */
export function renderInteractivePlot(svg:string):string {
 if(Buffer.byteLength(svg)>60*1024**2||!svg.startsWith('<svg ')||!svg.endsWith('</svg>'))throw new RangeError('Invalid interactive SVG');
 const allowed=new Set(['svg','title','desc','style','rect','defs','clipPath','text','path','g','circle','line','polygon','polyline','ellipse','tspan','linearGradient','stop','image']);
 for(const match of svg.matchAll(/<\/?([A-Za-z][\w:-]*)\b([^>]*)>/g)){
  if(!allowed.has(match[1]))throw new Error('Active SVG is not supported');
  const rest=match[2].replace(/\s+([\w:-]+)\s*=\s*("[^"]*"|'[^']*')/g,(_attribute,name:string,value:string)=>{if(/^on\w+/i.test(name))throw new Error('Active SVG is not supported');if(/^(?:xlink:)?href$/i.test(name)&&!(match[1]==='image'&&/^["']data:image\/png;base64,[A-Za-z0-9+/=]+["']$/.test(value)))throw new Error('External SVG references are not supported');return '';});
  if(!/^\s*\/?$/.test(rest))throw new Error('Invalid generated SVG attributes');
 }
 const script=String.raw`
'use strict';
const viewport=document.getElementById('viewport'),svg=viewport.querySelector('svg'),status=document.getElementById('status');
const original=svg.getAttribute('viewBox').split(/\s+/).map(Number);let view=[...original],drag=null;
svg.style.width='100%';svg.style.height='auto';
function draw(){svg.setAttribute('viewBox',view.join(' '));status.textContent='Zoom '+Math.round(original[2]/view[2]*100)+'%';}
function zoom(factor){const ratio=Math.max(.25,Math.min(32,original[2]/view[2]*factor)),w=original[2]/ratio,h=original[3]/ratio;view=[view[0]+(view[2]-w)/2,view[1]+(view[3]-h)/2,w,h];draw();}
document.getElementById('in').onclick=()=>zoom(1.5);document.getElementById('out').onclick=()=>zoom(1/1.5);
document.getElementById('reset').onclick=()=>{view=[...original];draw();};
viewport.addEventListener('wheel',e=>{if(!e.ctrlKey)return;e.preventDefault();zoom(e.deltaY<0?1.2:1/1.2);},{passive:false});
svg.addEventListener('pointerdown',e=>{if(e.button!==0)return;drag={id:e.pointerId,x:e.clientX,y:e.clientY,view:[...view]};svg.setPointerCapture(e.pointerId);});
svg.addEventListener('pointermove',e=>{if(!drag||e.pointerId!==drag.id)return;const matrix=svg.getScreenCTM();if(!matrix)return;view[0]=drag.view[0]-(e.clientX-drag.x)/matrix.a;view[1]=drag.view[1]-(e.clientY-drag.y)/matrix.d;draw();});
for(const name of ['pointerup','pointercancel','lostpointercapture'])svg.addEventListener(name,()=>{drag=null;});
viewport.addEventListener('keydown',e=>{const delta=view[2]/10;if(e.key==='+'||e.key==='=')zoom(1.5);else if(e.key==='-')zoom(1/1.5);else if(e.key==='0'){view=[...original];draw();}else if(e.key==='ArrowLeft'){view[0]-=delta;draw();}else if(e.key==='ArrowRight'){view[0]+=delta;draw();}else if(e.key==='ArrowUp'){view[1]-=delta;draw();}else if(e.key==='ArrowDown'){view[1]+=delta;draw();}else return;e.preventDefault();});
const curves=document.getElementById('curves');
for(const group of svg.querySelectorAll('[data-curve-label]')){const label=document.createElement('label'),box=document.createElement('input');box.type='checkbox';box.checked=true;box.addEventListener('change',()=>{group.style.display=box.checked?'':'none';});label.append(box,document.createTextNode((group.ownerSVGElement.querySelector('title')?.textContent||'Plot')+' — '+group.getAttribute('data-curve-label')));curves.append(label);}
if(!curves.childElementCount)curves.parentElement.hidden=true;
draw();
`;
 const hash=createHash('sha256').update(script).digest('base64');
 const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><title>Interactive diagnostic plot</title><style>body{margin:0;background:#edf1f5;color:#172033;font:16px system-ui,sans-serif}header,details{padding:12px 20px;background:white;border-bottom:1px solid #ccd4df}h1{font-size:20px;margin:0 0 8px}button{padding:8px 14px;margin-right:8px;cursor:pointer}#viewport{margin:16px auto;max-width:1200px;background:white;overflow:hidden;outline-offset:3px}#viewport svg{touch-action:none;cursor:grab;user-select:none}#curves{display:flex;flex-wrap:wrap;gap:12px;padding-top:12px}#curves label{display:flex;gap:6px;align-items:center}p{margin:8px 0;font-size:14px}#status{margin-left:8px}</style></head><body><header><h1>Interactive diagnostic plot</h1><button id="in" aria-label="Zoom in">+</button><button id="out" aria-label="Zoom out">−</button><button id="reset">Reset view</button><span id="status" aria-live="polite"></span><p>Drag to pan. Ctrl + wheel to zoom. Keyboard: + / −, arrows, 0 to reset. Curves retain all exported points.</p></header><details open><summary>Visible curves</summary><div id="curves"></div></details><main id="viewport" tabindex="0" aria-label="Diagnostic plot; use arrow keys to pan">${svg}</main><script>${script}</script></body></html>`;
 if(Buffer.byteLength(html)>64*1024**2)throw new RangeError('Interactive output capacity exceeded');return html;
}
