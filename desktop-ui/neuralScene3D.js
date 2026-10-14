import { createNeuralScene as createCanvasScene } from './neuralScene.js';
import { createSatelliteTopology, createSatelliteGlyph, createGlyphBridges, neuralIdentities, createSatelliteMotion, advanceSatelliteMotion, rotateSatellitePoint, lobeDepth, pickNeuralLobe } from './neuralSatellite.js';

// No CDN, textures, network requests or model calls. WebGL is optional.
export async function createNeuralScene(initialHost) {
 let current=null,disposed=false;
 const state={host:initialHost,provider:null,routes:[],still:false,depth:false};
 const currentScenePick=(x,y,region)=>current?.pickCore(x,y,region)??-1;
 const apply=()=>{current?.setRouteProvider(state.provider);current?.setRoutes(state.routes);current?.setDepth(state.depth);current?.setStill(state.still);};
 const fallback=()=>{if(disposed)return;current?.dispose();current=createCanvasScene(state.host);state.host.dataset.renderer='canvas';apply();};
 try {const THREE=await import('three');current=createGpuScene(THREE,initialHost,fallback);initialHost.dataset.renderer='webgl';}
 catch(error){initialHost.dataset.fallback=String(error.message).slice(0,100);fallback();}
 return {pickCore(x,y,current){return currentScenePick(x,y,current);},attach(host){state.host=host;current?.attach(host);},setRoutes(v){state.routes=v;current?.setRoutes(v);},setRouteProvider(v){state.provider=v;current?.setRouteProvider(v);},setDepth(v){state.depth=v;current?.setDepth(v);},setStill(v){state.still=v;current?.setStill(v);},dispose(){disposed=true;current?.dispose();current=null;}};
}

function createGpuScene(T,initialHost,onLost) {
 const canvas=document.createElement('canvas');canvas.dataset.engine='three.js r184';
 const renderer=new T.WebGLRenderer({canvas,alpha:false,antialias:false,powerPreference:'low-power'});
 renderer.setClearColor(0x05070b,1);
 const world=new T.Scene(),camera=new T.PerspectiveCamera(45,1,1,4000);camera.position.z=900;
 let host=initialHost,w=1,h=1,raf=0,last=0,time=0,still=false,dead=false,visible=true,provider=null,network=null;
 let rateStarted=0,rateFrames=0,lastDraw=0;
 let draws=0,measure=0,frameMax=0,quality=1,scale=140,brainDepth=-170,focus=0,px=0,py=0,aimX=0,aimY=0,flightUntil=0,activation=0,lastStage='',lastFocus=-1;
 const reduced=matchMedia('(prefers-reduced-motion: reduce)'),disposables=[];
 let seed=19841;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
 const palette=['#d3a459','#a97862','#737779','#b2a893','#edc786'].map(c=>new T.Color(c));
 const moduleColors=neuralIdentities.map(v=>new T.Color(v.color)),moduleLights=neuralIdentities.map(v=>new T.Color(v.light));
 const vertex=`attribute float aSize;attribute float aAlpha;attribute float aModule;uniform float uDpr;uniform float uTime;uniform float uFocus;uniform float uActivity;uniform float uStellar;varying vec3 vColor;varying float vAlpha;varying float vSpark;
 void main(){vec4 mv=modelViewMatrix*vec4(position,1.0);gl_Position=projectionMatrix*mv;float selected=1.0-step(.4,abs(aModule-uFocus));float pulse=.92+.08*sin(uTime*.65+position.x*.05);vColor=color;vSpark=uStellar*smoothstep(3.5,7.0,aSize);vAlpha=aAlpha*pulse*clamp(1100.0/-mv.z,.58,1.12)*(aModule<0.0?1.0:(.64+selected*.48+uActivity*.12));gl_PointSize=clamp(aSize*uDpr*900.0/-mv.z,1.0,100.0);}`;
 const fragment=`varying vec3 vColor;varying float vAlpha;varying float vSpark;void main(){vec2 p=gl_PointCoord*2.0-1.0;float r=dot(p,p);if(r>1.0)discard;float glow=exp(-r*5.0);glow+=vSpark*.22*(exp(-abs(p.x)*65.0-abs(p.y)*3.0)+exp(-abs(p.y)*65.0-abs(p.x)*3.0));gl_FragColor=vec4(pow(vColor,vec3(.4545)),vAlpha*glow);}`;
 function points(items,{additive=true,dynamic=false,stellar=false}={}){
   const g=new T.BufferGeometry(),pos=new Float32Array(items.length*3),colors=new Float32Array(items.length*3),sizes=new Float32Array(items.length),alphas=new Float32Array(items.length),modules=new Float32Array(items.length);
   items.forEach((p,i)=>{pos.set(p.pos,i*3);(p.color||palette[0]).toArray(colors,i*3);sizes[i]=p.size;alphas[i]=p.alpha;modules[i]=p.module??-1;});
   g.setAttribute('position',new T.BufferAttribute(pos,3).setUsage(dynamic?T.DynamicDrawUsage:T.StaticDrawUsage));
   g.setAttribute('color',new T.BufferAttribute(colors,3));g.setAttribute('aSize',new T.BufferAttribute(sizes,1));g.setAttribute('aAlpha',new T.BufferAttribute(alphas,1));g.setAttribute('aModule',new T.BufferAttribute(modules,1));
   const m=new T.ShaderMaterial({vertexShader:vertex,fragmentShader:fragment,uniforms:{uDpr:{value:1},uTime:{value:0},uFocus:{value:0},uActivity:{value:0},uStellar:{value:stellar?1:0}},vertexColors:true,transparent:true,depthWrite:false,blending:additive?T.AdditiveBlending:T.NormalBlending});
   const mesh=new T.Points(g,m);mesh.frustumCulled=false;disposables.push(g,m);return mesh;
 }
 // Three independent depth populations, with a curved dust lane and dark gaps.
 const silver=new T.Color('#91a0b3'),shadow=new T.Color('#080b13');
 const atmosphere=[];
 for(let i=0;i<16000;i++){
   const lane=i<11000,t=rand(),x=lane?(t-.5)*2.4:(rand()-.5)*3.8;
   const ridge=x*.40+.12*Math.sin(x*3.4),spread=(rand()+rand()+rand()-1.5)*(.10+.16*(1-Math.abs(t-.5)*2));
   const y=lane?ridge+spread+(i%3===0?.105:-.045):(rand()-.5)*3.1;
   const distance=lane?350+rand()*650:900+rand()*700;
   const rare=rand();
   atmosphere.push({pos:[x,y,-distance],size:lane?.7+rand()*1.9:rare>.985?5+rand()*3:1.1+rand()*2.6,alpha:lane?.16+rand()*.45:.3+rand()*.46,color:i%17===0?palette[1]:i%7===0?palette[0]:i%3===0?silver:palette[3]});
 }
 const stars=points(atmosphere,{stellar:true});world.add(stars);
 const cloudItems=Array.from({length:190},(_,i)=>{
   const t=rand(),x=(t-.5)*2.4,y=x*.4+.12*Math.sin(x*3.4)+(rand()-.5)*.17;
   return {pos:[x,y,-450-rand()*350],size:45+rand()*85,alpha:.028+rand()*.032,color:i%7===0?palette[1]:i%4===0?palette[0]:silver};
 });
 const clouds=points(cloudItems);world.add(clouds);
 // A sparse near plane moves further under the pointer than distant stars.
 const foreground=points(Array.from({length:150},(_,i)=>({pos:[(rand()-.5)*2.0,(rand()-.5)*1.9,-40-rand()*240],size:i%19===0?7+rand()*3:1.4+rand()*2,alpha:.20+rand()*.32,color:i%4===0?palette[4]:silver})),{stellar:true});world.add(foreground);
 const dust=points(Array.from({length:100},()=>{const x=(rand()-.5)*2.3;return {pos:[x,x*.4+.12*Math.sin(x*3.4)-.025+(rand()-.5)*.045,-200-rand()*150],size:45+rand()*60,alpha:.08+rand()*.09,color:shadow};}),{additive:false});world.add(dust);
 const brain=new T.Group();world.add(brain);
 const neurons=[],lobes=[];
 for(let i=0;i<5;i++){const a=[2.85,Math.PI/2,.30,-.90,-2.24][i];lobes.push(new T.Vector3(Math.cos(a)*.62,Math.sin(a)*.58,(i%2-.5)*.55));}
 const cortex=[];
 for(let i=0;i<10400;i++){
   const group=i%5,c=lobes[group],a=rand()*Math.PI*2,z=rand()*2-1,r=Math.sqrt(1-z*z),fold=1+.13*Math.sin(a*7+z*11);
   // Keep the folded surface, with a quieter inner population to fill its
   // volume at the larger overview scale without turning up the whole glow.
   const inner=i%4===0,radial=inner?.48+rand()*.4:1;
   const p=new T.Vector3(c.x+Math.cos(a)*r*.48*fold*radial,c.y+Math.sin(a)*r*.42*fold*radial,c.z+z*.52*radial);
   cortex.push({pos:p.toArray(),size:rand()>.99?6:1+rand()*2.2,alpha:.42+rand()*.32,color:i%5===0?moduleLights[group]:moduleColors[group],module:group});
   if(inner)cortex[cortex.length-1].alpha*=.72;
   if(i<420)neurons.push({p,group});
 }
 const cortexPoints=points(cortex,{dynamic:true});brain.add(cortexPoints);
 const tissue=points(Array.from({length:100},(_,i)=>{const c=lobes[i%5];return {pos:[c.x+(rand()-.5)*.7,c.y+(rand()-.5)*.65,c.z+(rand()-.5)*.55],size:18+rand()*36,alpha:.025+rand()*.04,color:moduleColors[i%5],module:i%5};}),{dynamic:true});brain.add(tissue);
 // A compact luminous interior gives the tissue volume without a screen-wide glow.
 const innerLight=points([
   {pos:[0,0,.06],size:116,alpha:.13,color:palette[0]},
   {pos:[.04,-.03,.16],size:44,alpha:.20,color:palette[4]},
   ...lobes.map((p,i)=>({pos:[p.x*.68,p.y*.68,p.z],size:48,alpha:.10,color:moduleColors[i],module:i})),
 ],{dynamic:true});brain.add(innerLight);
 const nucleus=points(Array.from({length:400},()=>{const a=rand()*Math.PI*2,z=(rand()-.5)*.3,r=rand()*.22;return {pos:[Math.cos(a)*r,Math.sin(a)*r,z],size:1+rand()*3.5,alpha:.55,color:palette[0]};}));brain.add(nucleus);
 const edges=[];
 neurons.forEach((n,i)=>{
   const candidates=neurons.map((m,j)=>({j,d:n.p.distanceToSquared(m.p)})).filter(v=>v.j!==i&&neurons[v.j].group===n.group).sort((a,b)=>a.d-b.d).slice(0,3);
   candidates.forEach(({j})=>{if(j>i)edges.push([i,j]);});
   if(i<5)edges.push([i,(i+1)%5]);
 });
 const edgePos=new Float32Array(edges.length*6),edgeColor=new Float32Array(edges.length*6);
 edges.forEach(([i,j],k)=>{neurons[i].p.toArray(edgePos,k*6);neurons[j].p.toArray(edgePos,k*6+3);palette[3].toArray(edgeColor,k*6);palette[3].toArray(edgeColor,k*6+3);});
 const eg=new T.BufferGeometry();eg.setAttribute('position',new T.BufferAttribute(edgePos,3).setUsage(T.DynamicDrawUsage));eg.setAttribute('color',new T.BufferAttribute(edgeColor,3).setUsage(T.DynamicDrawUsage));
 const em=new T.LineBasicMaterial({vertexColors:true,transparent:true,opacity:.20,depthWrite:false});const dendrites=new T.LineSegments(eg,em);brain.add(dendrites);disposables.push(eg,em);
 const impulses=points(edges.filter((_,i)=>i%2===0).flatMap(([i])=>Array.from({length:4},(_,j)=>({pos:[0,0,0],size:j?1.6:4,alpha:j?.3:.9,color:moduleLights[neurons[i].group],module:neurons[i].group}))),{dynamic:true});brain.add(impulses);
 const arrivals=points(neurons.map(n=>({pos:n.p.toArray(),size:9,alpha:0,color:moduleLights[n.group],module:n.group})),{dynamic:true});brain.add(arrivals);
 const routeLimit=40,steps=24,routeGeometry=new T.BufferGeometry(),routePos=new Float32Array(routeLimit*steps*6),routeColors=new Float32Array(routePos.length);
 routeGeometry.setAttribute('position',new T.BufferAttribute(routePos,3).setUsage(T.DynamicDrawUsage));routeGeometry.setAttribute('color',new T.BufferAttribute(routeColors,3).setUsage(T.DynamicDrawUsage));
 const rm=new T.LineBasicMaterial({vertexColors:true,transparent:true,opacity:.55,depthWrite:false});const lines=new T.LineSegments(routeGeometry,rm);lines.frustumCulled=false;world.add(lines);disposables.push(routeGeometry,rm);
 const pulses=points(Array.from({length:routeLimit*4},()=>({pos:[0,0,3000],size:4,alpha:.9,color:palette[4]})),{dynamic:true});world.add(pulses);
 // Five neural volumes share three batched draws; invisible DOM targets retain
 // pointer/keyboard handling and supply their measured center and radius.
 const satellite=createSatelliteTopology(),satelliteCount=satellite.nodes.length;
 const satellitePoints=points(Array.from({length:5*satelliteCount},(_,i)=>({pos:[0,0,3000],size:i%17===0?3.8:1.5,alpha:i%17===0?.9:.64,color:i%11===0?moduleLights[Math.floor(i/satelliteCount)]:moduleColors[Math.floor(i/satelliteCount)],module:Math.floor(i/satelliteCount)})),{dynamic:true});world.add(satellitePoints);
 const sg=new T.BufferGeometry(),sp=new Float32Array(5*satellite.edges.length*6),sc=new Float32Array(sp.length);
 sg.setAttribute('position',new T.BufferAttribute(sp,3).setUsage(T.DynamicDrawUsage));sg.setAttribute('color',new T.BufferAttribute(sc,3).setUsage(T.DynamicDrawUsage));
 const sm=new T.LineBasicMaterial({vertexColors:true,transparent:true,opacity:.36,depthWrite:false});
 const satelliteLinks=new T.LineSegments(sg,sm);satelliteLinks.frustumCulled=false;world.add(satelliteLinks);disposables.push(sg,sm);
 const satelliteSignals=points(Array.from({length:5*6},(_,i)=>({pos:[0,0,3000],size:i%2?1.8:3.8,alpha:i%2?.35:.85,color:moduleLights[Math.floor(i/6)],module:Math.floor(i/6)})),{dynamic:true});world.add(satelliteSignals);
 const glyphs=neuralIdentities.map((_,i)=>createSatelliteGlyph(i)),glyphOffsets=[];
 let glyphCount=0,glyphEdges=0;glyphs.forEach(g=>{glyphOffsets.push(glyphCount);g.bridges=createGlyphBridges(g,satellite);glyphCount+=g.nodes.length;glyphEdges+=g.edges.length+g.bridges.length;});
 const glyphPoints=points(glyphs.flatMap((g,group)=>g.nodes.map(()=>({pos:[0,0,3000],size:2.3,alpha:.72,color:moduleLights[group],module:group}))),{dynamic:true});world.add(glyphPoints);
 const gg=new T.BufferGeometry(),gp=new Float32Array(glyphEdges*6),gc=new Float32Array(gp.length);
 gg.setAttribute('position',new T.BufferAttribute(gp,3).setUsage(T.DynamicDrawUsage));gg.setAttribute('color',new T.BufferAttribute(gc,3).setUsage(T.DynamicDrawUsage));
 const gm=new T.LineBasicMaterial({vertexColors:true,transparent:true,opacity:.94,depthWrite:false,blending:T.AdditiveBlending});
 const glyphLines=new T.LineSegments(gg,gm);glyphLines.frustumCulled=false;world.add(glyphLines);disposables.push(gg,gm);
 const pulseColors=pulses.geometry.attributes.color.array;
 const satelliteMotion=neuralIdentities.map((_,i)=>createSatelliteMotion(i)),rotated=[0,0,0],anamorphic=[0,0,0];
 const lobeLift=new Float32Array(5),lobeZ=new Float32Array(5),coreRegions=Array.from({length:5},()=>({x:0,y:0,rx:0,ry:0}));
 const deformLayers=[cortexPoints,tissue,innerLight].map(mesh=>({mesh,base:mesh.geometry.attributes.position.array.slice()}));
 const pointLayers=[cortexPoints,tissue,innerLight,nucleus,impulses,arrivals,stars,clouds,foreground,dust,pulses,satellitePoints,satelliteSignals,glyphPoints];
 const routePool=Array.from({length:routeLimit},()=>({a:new T.Vector3(),b:new T.Vector3(),lit:false,group:0}));
 let coloredFocus=-2;
 const vector=new T.Vector3(),a=new T.Vector3(),b=new T.Vector3(),out=new T.Vector3();
 function pixel(point,z=0,target=new T.Vector3()){return target.set((point[0]-w/2)*(900-z)/900,(h/2-point[1])*(900-z)/900,z);}
 function curve(start,end,t,target){const u=1-t,dx=(end.x-start.x)*.52;return target.set(u*u*u*start.x+3*u*u*t*(start.x+dx)+3*u*t*t*(end.x-dx*.5)+t*t*t*end.x,u*u*u*start.y+3*u*u*t*start.y+3*u*t*t*end.y+t*t*t*end.y,u*start.z+t*end.z-Math.sin(t*Math.PI)*65);}
 function frame(dt){
   if(provider)network=provider();
   const home=network?.stage==='overview',targetScale=network?.brainScale??(home?Math.min(w*.19,h*.25,172):w<1100?48:network?.stage==='detail'?70:88);
   const smooth=still||reduced.matches?1:1-Math.exp(-dt*6);scale+=(targetScale-scale)*smooth;px+=(aimX-px)*smooth;py+=(aimY-py)*smooth;
   const core=network?.core||[w*.48,h*.43];brainDepth+=((home?-170:network?.stage==='detail'?-330:-260)-brainDepth)*smooth;pixel(core,brainDepth,brain.position);if(!network?.stationaryNavigation){brain.position.x+=px*4;brain.position.y-=py*3;}
   brain.scale.setScalar(scale);brain.rotation.set(Math.sin(time*.07)*.065,Math.sin(time*.055)*.16,.02*Math.sin(time*.08));brain.updateMatrixWorld(true);
   const stage=network?.stage||'overview';focus=network?.focus??0;
   if(stage!==lastStage||focus!==lastFocus){flightUntil=performance.now()+720;activation=1;lastStage=stage;lastFocus=focus;}
   activation=Math.max(0,activation-dt*.8);
   const hover=network?.hoverFocus??-1,liftEase=still||reduced.matches?1:1-Math.exp(-dt*18);
   for(let group=0;group<5;group++){
     lobeLift[group]+=((hover===group?1:0)-lobeLift[group])*liftEase;
     lobeZ[group]=network?.stationaryNavigation?0:lobeDepth(time,group,lobeLift[group],900-brainDepth,scale);
     vector.copy(lobes[group]);vector.z+=lobeZ[group];vector.applyMatrix4(brain.matrixWorld);
     const radius=scale*900/(900-vector.z);vector.project(camera);
     Object.assign(coreRegions[group],{x:(vector.x+1)*w/2,y:(1-vector.y)*h/2,rx:radius*.52,ry:radius*.46});
   }
   for(const {mesh,base} of deformLayers){
     const g=mesh.geometry,positions=g.attributes.position.array,groups=g.attributes.aModule.array;
     for(let i=0;i<groups.length;i++)positions[i*3+2]=base[i*3+2]+(groups[i]<0?0:lobeZ[groups[i]]);
     g.attributes.position.needsUpdate=true;
   }
   cortexPoints.material.uniforms.uFocus.value=focus;
   for(const obj of pointLayers){obj.material.uniforms.uTime.value=time;obj.material.uniforms.uFocus.value=focus;obj.material.uniforms.uActivity.value=network?.permission?0:network?.busy?1:activation;}
   stars.rotation.z=Math.sin(time*.015)*.007;stars.position.set(px*8,py*-5,0);clouds.position.set(px*14,py*-10,0);foreground.position.set(px*32,py*-23,0);dust.position.set(px*19,py*-14,0);
   const satellites=satellitePoints.geometry.attributes.position.array,signals=satelliteSignals.geometry.attributes.position.array,glyphPositions=glyphPoints.geometry.attributes.position.array;
   let glyphLineOffset=0;
   for(let group=0;group<5;group++){
     const port=network?.ports?.[group],radius=network?.portRadii?.[group]??(home?30:17);
     pixel(port||[-100,-100],55,vector);
     const rotation=advanceSatelliteMotion(satelliteMotion[group],dt,!network?.stationaryNavigation&&group===focus,still||reduced.matches),size=radius*845/900;
     satellite.nodes.forEach((p,i)=>{
       const offset=(group*satelliteCount+i)*3;rotateSatellitePoint(p,rotation,rotated);
       satellites[offset]=(network?.stationaryNavigation?vector.x*(900-vector.z-rotated[2]*size)/(900-vector.z):vector.x)+rotated[0]*size;
       satellites[offset+1]=(network?.stationaryNavigation?vector.y*(900-vector.z-rotated[2]*size)/(900-vector.z):vector.y)+rotated[1]*size;
       satellites[offset+2]=vector.z+rotated[2]*size;
     });
     satellite.edges.forEach(([i,j],k)=>{
       const offset=(group*satellite.edges.length+k)*6,ai=(group*satelliteCount+i)*3,bi=(group*satelliteCount+j)*3;
       const c=moduleColors[group],power=group===focus?.94:.54;
       for(let axis=0;axis<3;axis++){
         sp[offset+axis]=satellites[ai+axis];sp[offset+3+axis]=satellites[bi+axis];
         sc[offset+axis]=sc[offset+3+axis]=(axis===0?c.r:axis===1?c.g:c.b)*power;
       }
     });
     const glyph=glyphs[group],base=glyphOffsets[group];
     glyph.nodes.forEach((p,i)=>{
       const offset=(base+i)*3;
       const depth=p[2]*size/845;
       anamorphic[0]=p[0]*(1-depth)-(network?.stationaryNavigation?0:vector.x*p[2]/845);
       anamorphic[1]=p[1]*(1-depth)-(network?.stationaryNavigation?0:vector.y*p[2]/845);anamorphic[2]=p[2];
       rotateSatellitePoint(anamorphic,rotation,rotated);
       glyphPositions[offset]=(network?.stationaryNavigation?vector.x*(900-vector.z-rotated[2]*size)/(900-vector.z):vector.x)+rotated[0]*size;
       glyphPositions[offset+1]=(network?.stationaryNavigation?vector.y*(900-vector.z-rotated[2]*size)/(900-vector.z):vector.y)+rotated[1]*size;
       glyphPositions[offset+2]=vector.z+rotated[2]*size;
     });
     for(const [i,j] of glyph.edges){
       const ai=(base+i)*3,bi=(base+j)*3,c=moduleLights[group],depth=((glyphPositions[ai+2]+glyphPositions[bi+2])*.5-55)/size,power=(group===focus?1:.85)*(.72+depth*.36);
       for(let axis=0;axis<3;axis++){
         gp[glyphLineOffset+axis]=glyphPositions[ai+axis];gp[glyphLineOffset+3+axis]=glyphPositions[bi+axis];
         gc[glyphLineOffset+axis]=gc[glyphLineOffset+3+axis]=(axis===0?c.r:axis===1?c.g:c.b)*power;
       }
       glyphLineOffset+=6;
     }
     for(const [i,j] of glyph.bridges){
       const ai=(base+i)*3,bi=(group*satelliteCount+j)*3,c=moduleColors[group];
       for(let axis=0;axis<3;axis++){
         gp[glyphLineOffset+axis]=glyphPositions[ai+axis];gp[glyphLineOffset+3+axis]=satellites[bi+axis];
         gc[glyphLineOffset+axis]=gc[glyphLineOffset+3+axis]=(axis===0?c.r:axis===1?c.g:c.b)*.38;
       }
       glyphLineOffset+=6;
     }
     // Paired heads and short tails trace the actual identifying neural trunk.
     for(let i=0;i<6;i++){
       const path=glyph.routes[Math.floor(i/2)%glyph.routes.length];
       const phase=((time*(group===focus?.17:.075)+Math.floor(i/2)*.31-(i%2)*.02)%1+1)%1;
       const step=phase*(path.length-1),k=Math.floor(step),t=step-k;
       const a=base+path[k],b=base+path[k+1];
       for(let axis=0;axis<3;axis++)signals[(group*6+i)*3+axis]=glyphPositions[a*3+axis]*(1-t)+glyphPositions[b*3+axis]*t;
     }
   }
   satellitePoints.geometry.attributes.position.needsUpdate=true;satelliteSignals.geometry.attributes.position.needsUpdate=true;sg.attributes.position.needsUpdate=true;sg.attributes.color.needsUpdate=true;
   glyphPoints.geometry.attributes.position.needsUpdate=true;gg.attributes.position.needsUpdate=true;gg.attributes.color.needsUpdate=true;
   const ip=impulses.geometry.attributes.position.array,arrivalAlpha=arrivals.geometry.attributes.aAlpha.array;arrivalAlpha.fill(0);let index=0;
   edges.forEach(([i,j],k)=>{
     edgePos[k*6+2]=neurons[i].p.z+lobeZ[neurons[i].group];edgePos[k*6+5]=neurons[j].p.z+lobeZ[neurons[j].group];
     const lit=neurons[i].group===focus,c=lit?moduleLights[neurons[i].group]:moduleColors[neurons[i].group],power=lit?1:.82;
     if(coloredFocus!==focus)for(let n=0;n<2;n++){edgeColor[k*6+n*3]=c.r*power;edgeColor[k*6+n*3+1]=c.g*power;edgeColor[k*6+n*3+2]=c.b*power;}
     if(k%2)return;
     for(let tail=0;tail<4;tail++){
       const t=(time*(lit?.35:.10)+k*.071-tail*.026+1)%1;
       if(tail===0&&lit&&t>.88)arrivalAlpha[j]=Math.max(arrivalAlpha[j],Math.sin((t-.88)/.12*Math.PI)*.9);
       vector.lerpVectors(neurons[i].p,neurons[j].p,t);vector.z+=lobeZ[neurons[i].group]*(1-t)+lobeZ[neurons[j].group]*t;vector.toArray(ip,index);index+=3;
     }
   });
   const arrivalPositions=arrivals.geometry.attributes.position;
   neurons.forEach((n,i)=>{arrivalPositions.array[i*3+2]=n.p.z+lobeZ[n.group];});arrivalPositions.needsUpdate=true;
   eg.attributes.position.needsUpdate=true;arrivals.geometry.attributes.aAlpha.needsUpdate=true;
   if(coloredFocus!==focus){eg.attributes.color.needsUpdate=true;coloredFocus=focus;}impulses.geometry.attributes.position.needsUpdate=true;
   // Reuse route vectors and typed buffers; no per-frame path objects.
   let routeCount=0;
   if(network?.ports){for(let i=0;i<network.ports.length&&routeCount<routeLimit;i++){
     const r=routePool[routeCount++];r.a.copy(lobes[i]);r.a.z+=lobeZ[i];r.a.applyMatrix4(brain.matrixWorld);pixel(network.ports[i],55,r.b);r.lit=i===focus;r.group=i;
   }
   for(const [start,end,lit] of network.routes||[]){if(routeCount>=routeLimit)break;const r=routePool[routeCount++];pixel(start,55,r.a);pixel(end,75,r.b);r.lit=lit;r.group=network.active??0;}
   if(network.output&&routeCount<routeLimit){const r=routePool[routeCount++];pixel(network.output[0],75,r.a);pixel(network.output[1],100,r.b);r.lit=true;r.group=network.active??0;}}
   let ri=0,pi=0;const pp=pulses.geometry.attributes.position.array;
   for(let i=0;i<routeCount;i++){
     const r=routePool[i];
     const color=r.lit?moduleLights[r.group]:moduleColors[r.group],brightness=r.lit?1:.60;
     for(let j=0;j<steps;j++){
       curve(r.a,r.b,j/steps,a);curve(r.a,r.b,(j+1)/steps,b);a.toArray(routePos,ri);b.toArray(routePos,ri+3);
       for(let n=0;n<2;n++){routeColors[ri+n*3]=color.r*brightness;routeColors[ri+n*3+1]=color.g*brightness;routeColors[ri+n*3+2]=color.b*brightness;}ri+=6;
     }
     for(let j=0;j<4;j++){moduleLights[r.group].toArray(pulseColors,pi);if(r.lit){curve(r.a,r.b,(time*(network?.permission ? .07 : network?.busy ? .48 : .2)+i*.1+j*.25)%1,out);out.toArray(pp,pi);}else{pp[pi]=0;pp[pi+1]=0;pp[pi+2]=3000;}pi+=3;}
   }
   for(;pi<pp.length;pi+=3){pp[pi]=0;pp[pi+1]=0;pp[pi+2]=3000;}
   routeGeometry.setDrawRange(0,ri/3);routeGeometry.attributes.position.needsUpdate=true;routeGeometry.attributes.color.needsUpdate=true;pulses.geometry.attributes.position.needsUpdate=true;pulses.geometry.attributes.color.needsUpdate=true;
   renderer.render(world,camera);
   canvas.dataset.coreRegions=JSON.stringify(coreRegions);canvas.dataset.lobeLift=Array.from(lobeLift,v=>v.toFixed(2)).join(',');canvas.dataset.glyphAngles=satelliteMotion.map(v=>v.yaw.toFixed(3)).join(',');
   canvas.dataset.stage=stage;canvas.dataset.focus=String(focus);canvas.dataset.branch=network?.branch||'';canvas.dataset.connections=String(network?.ports?.length||0);
 }
 function draw(dt=1/30){if(dead||document.hidden||!visible)return;const start=performance.now();frame(dt);const cost=performance.now()-start;measure+=cost;frameMax=Math.max(frameMax,cost);draws++;rateFrames++;
   if(draws%15===0){canvas.dataset.draws=String(draws);canvas.dataset.drawMs=cost.toFixed(2);}
   if(draws%90===0){const elapsed=performance.now()-rateStarted;if(elapsed>0)canvas.dataset.fps=(rateFrames*1000/elapsed).toFixed(1);rateFrames=0;rateStarted=performance.now();}
   if(draws%90===0){canvas.dataset.meanMs=(measure/90).toFixed(2);canvas.dataset.maxMs=frameMax.toFixed(2);canvas.dataset.geometries=String(renderer.info.memory.geometries);canvas.dataset.textures=String(renderer.info.memory.textures);canvas.dataset.calls=String(renderer.info.render.calls);const average=measure/90;measure=0;frameMax=0;
     if(average>12&&quality>0.6){quality=Math.max(.6,quality-.1);resize();}}
 }
 function stop(){cancelAnimationFrame(raf);raf=0;canvas.dataset.animating='false';}
 function tick(now){raf=0;if(dead||document.hidden||!visible||still||reduced.matches)return;const fps=(network?.flight||now<flightUntil)?60:30,interval=1000/fps;
   // Retain fractional time instead of losing it on every missed vsync.
   if(now-last>=interval-1){const dt=Math.min((now-lastDraw)/1000,.1);last=now-(now-last>=interval?(now-last)%interval:0);lastDraw=now;time+=dt;draw(dt);}raf=requestAnimationFrame(tick);}
 function start(){if(dead||document.hidden||!visible||still||reduced.matches||raf)return;last=lastDraw=rateStarted=performance.now();rateFrames=0;canvas.dataset.animating='true';raf=requestAnimationFrame(tick);}
 function resize(){if(dead)return;const r=host.getBoundingClientRect();w=Math.max(1,r.width);h=Math.max(1,r.height);const dpr=Math.min(devicePixelRatio||1,1.35)*quality;renderer.setPixelRatio(dpr);renderer.setSize(w,h,false);camera.aspect=w/h;camera.fov=2*Math.atan(h/1800)*180/Math.PI;camera.updateProjectionMatrix();stars.scale.set(w*.8,h*.8,1);clouds.scale.set(w*.8,h*.8,1);foreground.scale.set(w*.8,h*.8,1);dust.scale.set(w*.8,h*.8,1);for(const obj of pointLayers)obj.material.uniforms.uDpr.value=dpr;canvas.dataset.dpr=dpr.toFixed(2);draw();}
 const ro=new ResizeObserver(resize),io=new IntersectionObserver(entries=>{visible=entries[0]?.isIntersecting??false;if(visible){draw();start();}else stop();});
 const onVisibility=()=>{if(document.hidden)stop();else{draw();start();}},onPreference=()=>{stop();draw();start();},onPointer=e=>{aimX=e.clientX/w-.5;aimY=e.clientY/h-.5;flightUntil=performance.now()+350;},onContextLost=e=>{e.preventDefault();stop();onLost();};
 document.addEventListener('visibilitychange',onVisibility);reduced.addEventListener('change',onPreference);window.addEventListener('pointermove',onPointer,{passive:true});canvas.addEventListener('webglcontextlost',onContextLost);
 function attach(next){if(dead||host===next&&canvas.parentNode===next)return;ro.disconnect();io.disconnect();host=next;host.replaceChildren(canvas);ro.observe(host);io.observe(host);resize();start();}
 attach(initialHost);
 return {pickCore(x,y,current){const rect=host.getBoundingClientRect();return pickNeuralLobe(coreRegions,x-rect.left,y-rect.top,current);},attach,setRouteProvider(v){provider=v;},setRoutes(v){network=Array.isArray(v)?null:v;if(still||reduced.matches)draw();else start();},setDepth(){},setStill(v){if(still===v)return;still=v;stop();draw();start();},dispose(){if(dead)return;dead=true;stop();ro.disconnect();io.disconnect();document.removeEventListener('visibilitychange',onVisibility);reduced.removeEventListener('change',onPreference);window.removeEventListener('pointermove',onPointer);canvas.removeEventListener('webglcontextlost',onContextLost);for(const resource of disposables)resource.dispose();renderer.dispose();renderer.forceContextLoss();canvas.remove();canvas.width=canvas.height=0;}};
}
