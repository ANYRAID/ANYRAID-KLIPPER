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
const surface=svg.querySelector('[data-surface-faces]');
if(surface){
 const panel=document.getElementById('surface-controls'),yaw=document.getElementById('yaw'),tilt=document.getElementById('tilt'),angles=document.getElementById('angles');
 const numbers=(element,name,min,max)=>{const values=element.getAttribute(name).split(' ').map(Number);if(values.length<min||values.length>max||!values.every(Number.isFinite))throw new Error('Invalid surface geometry');return values;};
 const faces=Array.from(surface.querySelectorAll('[data-surface-vertices]'),element=>{const values=numbers(element,'data-surface-vertices',9,24);if(values.length%3)throw new Error('Invalid surface vertex count');return {element,values};});
 if(faces.length>50000)throw new Error('Surface capacity exceeded');
 const axes=Array.from(svg.querySelectorAll('[data-surface-axis]'),element=>({element,values:numbers(element,'data-surface-axis',6,6)}));
 const labels=Array.from(svg.querySelectorAll('[data-surface-label]'),element=>({element,values:numbers(element,'data-surface-label',4,4)}));
 let pending=0;
 function rotate(){
  pending=0;
  const bounded=(input,min,max)=>{const value=Number(input.value);return Number.isFinite(value)?Math.max(min,Math.min(max,value)):0;};
  const a=bounded(yaw,-180,180),b=bounded(tilt,-80,80),ca=Math.cos(a*Math.PI/180),sa=Math.sin(a*Math.PI/180),cb=Math.cos(b*Math.PI/180),sb=Math.sin(b*Math.PI/180);
  const project=(v,i)=>{const x=v[i]*ca-v[i+1]*sa,y0=v[i]*sa+v[i+1]*ca,y=y0*cb-v[i+2]*sb,z=y0*sb+v[i+2]*cb;return [470+350*(x-y),355+120*(x+y)-160*z,x+y+1.5*z];};
  const order=[];
  for(const face of faces){let depth=0;const points=[];for(let i=0;i<face.values.length;i+=3){const p=project(face.values,i);depth+=p[2]/(face.values.length/3);points.push(p[0].toFixed(3)+','+p[1].toFixed(3));}face.element.setAttribute('points',points.join(' '));order.push({element:face.element,depth});}
  order.sort((a,b)=>a.depth-b.depth);for(const face of order)surface.append(face.element);
  for(const {element,values} of axes){const p=project(values,0),q=project(values,3);element.setAttribute('d','M'+p[0].toFixed(3)+' '+p[1].toFixed(3)+'L'+q[0].toFixed(3)+' '+q[1].toFixed(3));}
  for(const {element,values} of labels){const p=project(values,0);element.setAttribute('x',(p[0]+values[3]).toFixed(3));element.setAttribute('y',(p[1]+15).toFixed(3));}
  angles.textContent='Rotation '+a+'° · Tilt '+b+'°';
 }
 const schedule=()=>{if(!pending)pending=requestAnimationFrame(rotate);};
 yaw.addEventListener('input',schedule);tilt.addEventListener('input',schedule);
 document.getElementById('surface-reset').onclick=()=>{if(pending)cancelAnimationFrame(pending);yaw.value=tilt.value='0';rotate();};
 panel.hidden=false;angles.textContent='Rotation 0° · Tilt 0°';
}
const travel=svg.querySelector('[data-mesh-animation]');
if(travel){
 const panel=document.getElementById('animation'),play=document.getElementById('play'),seek=document.getElementById('seek'),position=document.getElementById('position');
 const full=travel.getAttribute('d'),segments=full.match(/[ML][^ML]*/g)||[],frames=travel.getAttribute('data-mesh-animation').split(',').map(Number),ends=[];
 let end=0;for(const part of segments){end+=part.length;ends.push(end);}
 if(segments.length>100000||!frames.length||frames.some((v,i)=>!Number.isSafeInteger(v)||v<1||v>segments.length||(i>0&&v<=frames[i-1])))throw new Error('Invalid animation frames');
 let index=0,running=false,request=0,deadline=null;
 panel.hidden=false;seek.max=String(frames.length-1);play.disabled=frames.length<2;
 function frame(){travel.setAttribute('d',full.slice(0,ends[frames[index]-1]));seek.value=String(index);position.textContent='Point '+frames[index]+' / '+segments.length;}
 function pause(){running=false;cancelAnimationFrame(request);request=0;deadline=null;play.textContent='Play';play.setAttribute('aria-pressed','false');}
 function tick(now){if(!running)return;if(deadline===null)deadline=now+60;if(now>=deadline){index=Math.min(frames.length-1,index+Math.floor((now-deadline)/60)+1);deadline=now+60;frame();if(index===frames.length-1){pause();return;}}request=requestAnimationFrame(tick);}
 play.onclick=()=>{if(running){pause();return;}if(index===frames.length-1)index=0;frame();running=true;play.textContent='Pause';play.setAttribute('aria-pressed','true');request=requestAnimationFrame(tick);};
 seek.addEventListener('input',()=>{pause();const value=Number(seek.value);index=Number.isFinite(value)?Math.max(0,Math.min(frames.length-1,Math.trunc(value))):0;frame();});
 document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();});
 frame();
}
draw();
`;
 const hash=createHash('sha256').update(script).digest('base64');
 const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><title>Interactive diagnostic plot</title><style>body{margin:0;background:#edf1f5;color:#172033;font:16px system-ui,sans-serif}header,details,#animation,#surface-controls{padding:12px 20px;background:white;border-bottom:1px solid #ccd4df}h1{font-size:20px;margin:0 0 8px}button{padding:8px 14px;margin-right:8px;cursor:pointer}#viewport{margin:16px auto;max-width:1200px;background:white;overflow:hidden;outline-offset:3px}#viewport svg{touch-action:none;cursor:grab;user-select:none}#curves{display:flex;flex-wrap:wrap;gap:12px;padding-top:12px}#curves label{display:flex;gap:6px;align-items:center}p{margin:8px 0;font-size:14px}#status{margin-left:8px}</style></head><body><header><h1>Interactive diagnostic plot</h1><button id="in" aria-label="Zoom in">+</button><button id="out" aria-label="Zoom out">−</button><button id="reset">Reset view</button><span id="status" aria-live="polite"></span><p>Drag to pan. Ctrl + wheel to zoom. Keyboard: + / −, arrows, 0 to reset. Curves retain all exported points.</p></header><section id="surface-controls" hidden aria-label="3D surface view"><label>Rotation <input id="yaw" type="range" min="-180" max="180" value="0" step="1"></label><label>Tilt <input id="tilt" type="range" min="-80" max="80" value="0" step="1"></label><button id="surface-reset">Reset 3D view</button><output id="angles"></output><p>X/Y use the same physical scale. Z is exaggerated; rotation does not change measured values.</p></section><section id="animation" hidden aria-label="Probe path playback"><button id="play" aria-pressed="false">Play</button><label>Progress <input id="seek" type="range" min="0" max="0" value="0" step="1"></label><output id="position"></output><p>60 ms per reveal frame. Diagnostic playback, not physical motion timing.</p></section><details open><summary>Visible curves</summary><div id="curves"></div></details><main id="viewport" tabindex="0" aria-label="Diagnostic plot; use arrow keys to pan">${svg}</main><script>${script}</script></body></html>`;
 if(Buffer.byteLength(html)>64*1024**2)throw new RangeError('Interactive output capacity exceeded');return html;
}
