// One spatial model drives the DOM controls and the GPU scene.
export function overviewDockWidth(width) {
 return Math.min(880,Math.max(620,width*.62),width-40);
}
export function workspaceLayout(width,height,stage='overview',dockHeight=260) {
 const w=Math.max(320,width),h=Math.max(420,height),compact=w<1100;
 const home=stage==='overview',detail=stage==='detail';
 // Reserve the measured composer, then grow the entire constellation together.
 // Short windows keep a usable input; large windows no longer freeze at 310px.
 const fieldH=Math.max(220,h-dockHeight-64),cx=w*.5,cy=fieldH*.53+10;
 const rx=Math.min(w*.34,fieldH*.9,650,w/2-82),ry=Math.min(fieldH*.37,300);
 const core=home?[cx,cy]:[compact?40:detail?78:125,h*.47];
 const ports=home?
   [[cx-rx,cy-ry*.23],[cx,Math.max(88,cy-ry-15)],[cx+rx,cy-ry*.23],[cx+rx*.79,cy+ry*.72],[cx-rx*.79,cy+ry*.72]]:
   Array.from({length:5},(_,i)=>[compact?58:detail?146:216,132+i*Math.min(100,(h-255)/4)]);
 const branchX=compact?(detail?116:142):(detail?210:290);
 const branchW=compact?(detail?154:Math.min(320,w*.34)):detail?192:Math.min(390,w*.28);
 const panelX=compact?290:422;
 const brainScale=home?Math.min(w*.23,fieldH*.48,340):compact?48:detail?70:88;
 const coreSize=home?brainScale*1.86:compact?74:detail?114:158;
 return {core,coreSize,brainScale,ports,branch:[branchX,100,branchW,Math.max(210,h-162)],panel:[panelX,16,Math.max(0,w-panelX-16),h-32],compact,home,detail};
}
export function resolveWorkspaceStage(overview,expanded) {return overview?(expanded?'module':'overview'):'detail';}
