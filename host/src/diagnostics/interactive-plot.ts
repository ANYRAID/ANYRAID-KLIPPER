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
 const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><title>Interactive diagnostic plot</title><style>body{margin:0;background:#edf1f5;color:#172033;font:16px system-ui,sans-serif}header,details,#animation{padding:12px 20px;background:white;border-bottom:1px solid #ccd4df}h1{font-size:20px;margin:0 0 8px}button{padding:8px 14px;margin-right:8px;cursor:pointer}#viewport{margin:16px auto;max-width:1200px;background:white;overflow:hidden;outline-offset:3px}#viewport svg{touch-action:none;cursor:grab;user-select:none}#curves{display:flex;flex-wrap:wrap;gap:12px;padding-top:12px}#curves label{display:flex;gap:6px;align-items:center}p{margin:8px 0;font-size:14px}#status{margin-left:8px}</style></head><body><header><h1>Interactive diagnostic plot</h1><button id="in" aria-label="Zoom in">+</button><button id="out" aria-label="Zoom out">−</button><button id="reset">Reset view</button><span id="status" aria-live="polite"></span><p>Drag to pan. Ctrl + wheel to zoom. Keyboard: + / −, arrows, 0 to reset. Curves retain all exported points.</p></header><section id="animation" hidden aria-label="Probe path playback"><button id="play" aria-pressed="false">Play</button><label>Progress <input id="seek" type="range" min="0" max="0" value="0" step="1"></label><output id="position"></output><p>60 ms per reveal frame. Diagnostic playback, not physical motion timing.</p></section><details open><summary>Visible curves</summary><div id="curves"></div></details><main id="viewport" tabindex="0" aria-label="Diagnostic plot; use arrow keys to pan">${svg}</main><script>${script}</script></body></html>`;
 if(Buffer.byteLength(html)>64*1024**2)throw new RangeError('Interactive output capacity exceeded');return html;
}
