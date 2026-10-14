import { workspaceLayout,overviewDockWidth } from './neuralLayout.js';
let watched=null,observer=null;
const flights=new WeakMap();
export function captureNeuralLayout(){
 const root=document.querySelector('.neural-shell');if(!root)return null;
 const panel=root.querySelector('.neural-dashboard');
 return {stage:root.dataset.neuralStage,panel:panel?.getBoundingClientRect()};
}
export function positionNeuralWorkspace(root){
 if(!root)return;
 const {width,height}=root.getBoundingClientRect(),stage=root.dataset.neuralStage;
 const panel=root.querySelector('.neural-dashboard');
 if(stage==='overview')Object.assign(panel.style,{width:`${overviewDockWidth(width)}px`,height:'auto'});
 const layout=workspaceLayout(width,height,stage,panel.offsetHeight||260);
 root.style.setProperty('--neural-brain-scale',layout.brainScale);
 root.style.setProperty('--neural-home-orb',`${Math.max(44,Math.min(96,width*.064,height*.103))}px`);
 const anchor=root.querySelector('.neural-core-anchor');
 anchor.style.translate=`${layout.core[0]}px ${layout.core[1]}px`;
 anchor.style.setProperty('--core-size',`${layout.coreSize}px`);
 root.querySelectorAll('.neural-cluster').forEach((el,i)=>{
   el.style.translate=`${layout.ports[i][0]}px ${layout.ports[i][1]}px`;
 });
 const rail=root.querySelector('.neural-branches');
 const [x,y,w,h]=layout.branch;Object.assign(rail.style,{left:`${x}px`,top:`${y}px`,width:`${w}px`,height:`${h}px`});
 rail.inert=layout.home;
 if(layout.detail){const [x,y,w,h]=layout.panel;Object.assign(panel.style,{left:`${x}px`,top:`${y}px`,width:`${w}px`,height:`${h}px`});}
 else Object.assign(panel.style,{left:layout.home?'50%':`${layout.branch[0]+layout.branch[2]+(width-layout.branch[0]-layout.branch[2])/2}px`,top:layout.home?'auto':'50%',width:layout.home?`${overviewDockWidth(width)}px`:`${Math.min(420,Math.max(180,width-layout.branch[0]-layout.branch[2]-72))}px`,height:'auto'});
 root.classList.toggle('is-compact',layout.compact);
}
export function animateNeuralLayout(before,still=false){
 const root=document.querySelector('.neural-shell');if(!root)return;
 root.classList.toggle('is-still',still);
 const reduced=still||matchMedia('(prefers-reduced-motion: reduce)').matches;
 if(reduced)flights.get(root.querySelector('.neural-dashboard'))?.cancel();
 positionNeuralWorkspace(root);
 if(watched!==root){requestAnimationFrame(()=>{if(root.isConnected)root.dataset.spatialReady='true';});observer?.disconnect();watched=root;observer=new ResizeObserver(()=>positionNeuralWorkspace(root));observer.observe(root);observer.observe(root.querySelector('.neural-dashboard'));}
 if(before&&before.stage!==root.dataset.neuralStage){
   const panel=root.querySelector('.neural-dashboard');
   flights.get(panel)?.cancel();
   const after=panel.getBoundingClientRect(),from=before.panel;
   // Layout resolves once; the compositor moves the persistent working surface.
   // Capture the visible in-flight rectangle so rapid reversals do not snap.
   if(!reduced&&from?.width&&from?.height&&after.width&&after.height&&panel.animate){
     const base=getComputedStyle(panel).transform;
     const transform=base==='none'?'':base;
     flights.set(panel,panel.animate([
       {transform:`translate(${from.left-after.left}px,${from.top-after.top}px) ${transform} scale(${from.width/after.width},${from.height/after.height})`},
       {transform:base},
     ],{duration:760,easing:'cubic-bezier(.22,.78,.18,1)'}));
   }
   root.dataset.flight='true';clearTimeout(root._flightTimer);
   root._flightTimer=setTimeout(()=>{root.dataset.flight='false';},820);
 }
}
