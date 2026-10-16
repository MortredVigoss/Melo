import { createSatelliteTopology, createSatelliteGlyph, createGlyphBridges, neuralIdentities, createSatelliteMotion, advanceSatelliteMotion, rotateSatellitePoint, pickNeuralLobe } from './neuralSatellite.js';
// Full-workspace deep-sky field. A cached dust/stellar plate plus a bounded
// moving signal layer: foreground motion is continuous, hidden motion stops.
export function createNeuralScene(initialHost) {
 const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{alpha:false});
 const plate=document.createElement('canvas'),sky=plate.getContext('2d',{alpha:false});
 const mist=document.createElement('canvas'),cloud=mist.getContext('2d');
 if(!ctx||!sky||!cloud)return null;
 let host,width=0,height=0,raf=0,last=0,time=0,still=false,disposed=false,visible=true,draws=0;
 let network=null,lastFocus='',activation=0;
 let routes=[],routeProvider=null,depth=0,targetDepth=0,pointerX=0,pointerY=0,aimX=0,aimY=0;
 let seed=4281;
 const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
 const stars=Array.from({length:3800},()=>({x:rand(),y:rand(),r:rand(),phase:rand()*6.28}));
 const dust=Array.from({length:160},()=>({x:rand(),y:rand(),r:rand(),a:rand()}));
 // Hub-and-branch topology in world space, not a flat proximity mesh.
 const hubs=Array.from({length:5},(_,i)=>{const angle=[2.85,Math.PI/2,.30,-.90,-2.24][i];return {x:Math.cos(angle)*.55,y:-Math.sin(angle)*.6,z:1.4+(i%3)*.25};});
 const nodes=hubs.map((p,i)=>({...p,hub:true,group:i,phase:i*.8}));
 for(let i=0;i<460;i++){
   const group=i%5,h=hubs[group],angle=rand()*Math.PI*2,r=Math.pow(rand(),.7)*.58;
   nodes.push({x:h.x+Math.cos(angle)*r,y:h.y+Math.sin(angle)*r*.85,z:h.z+(rand()-.5)*.9,group,phase:rand()*6.28});
 }
 const grains=Array.from({length:13000},()=>({x:rand(),y:rand(),r:rand()}));
 const particles=Array.from({length:1600},()=>({x:(rand()-.5)*1.9,y:(rand()-.5)*1.9,z:.25+rand()*2.4,r:rand(),phase:rand()*6.28}));
 const edges=[];
 nodes.forEach((a,i)=>{
   if(a.hub){if(i)edges.push([i-1,i]);return;}
   const nearest=nodes.map((b,j)=>({j,d:Math.hypot((a.x-b.x)*1.4,a.y-b.y,(a.z-b.z)*.08)}))
     .filter(v=>v.j!==i&&nodes[v.j].group===a.group).sort((a,b)=>a.d-b.d).slice(0,2);
   for(const {j} of nearest)if(j<i||nodes[j].hub)edges.push([i,j]);
   if(i%6===0)edges.push([a.group,i]);
 });
 const arrivals=new Float32Array(nodes.length);
 const satellite=createSatelliteTopology(),satelliteProjection=satellite.nodes.map(()=>[0,0,0]);
 const glyphs=neuralIdentities.map((_,i)=>createSatelliteGlyph(i));
 glyphs.forEach(g=>{g.projection=g.nodes.map(()=>[0,0,0]);g.bridges=createGlyphBridges(g,satellite);});
 const satelliteMotion=neuralIdentities.map((_,i)=>createSatelliteMotion(i)),rotated=[0,0,0],anamorphic=[0,0,0];
 const lobeLift=new Float32Array(5),lobeZ=new Float32Array(5),coreRegions=Array.from({length:5},()=>({x:0,y:0,rx:0,ry:0}));
 const reduced=matchMedia('(prefers-reduced-motion: reduce)');
 function haze(context,x,y,r,rgb,a){
   const g=context.createRadialGradient(x,y,0,x,y,r);g.addColorStop(0,`rgba(${rgb},${a})`);g.addColorStop(.36,`rgba(${rgb},${a*.46})`);g.addColorStop(1,`rgba(${rgb},0)`);
   context.fillStyle=g;context.fillRect(x-r,y-r,r*2,r*2);
 }
 function cacheSky(){
   sky.fillStyle='#080807';sky.fillRect(0,0,width,height);
   // Cool charcoal recedes; warm silver rims reveal the edges of opaque dust.
   dust.forEach((p,i)=>{
     const x=width*(.27+(p.x-.5)*.48),y=height*(.5+(p.x-.5)*.60+(p.y-.5)*.28);
     haze(sky,x,y,(26+p.r*86)*Math.min(width/1200,1.5),i%5===0?'148,146,139':i%3===0?'53,58,65':'99,76,43',.006+p.a*p.a*.035);
   });
   haze(sky,width*.22,height*.51,Math.min(width,height)*.26,'98,76,35',.13);
   // Narrow dark absorption lanes cut through the cloudy long-lens field.
   for(let i=0;i<20;i++)haze(sky,width*(.10+i*.018),height*(.31+i*.021+Math.sin(i)*.04),height*.065,'5,5,4',.3);
   grains.forEach((p,i)=>{
     const x=width*(.28+(p.x-.5)*.72),y=height*(.50+(p.x-.5)*.66+(p.y-.5)*.25*Math.sin(p.x*8+1));
     sky.fillStyle=`rgba(${i%4===0?'151,148,139':'161,126,69'},${.018+Math.pow(p.r,3)*.14})`;sky.fillRect(x,y,.4+p.r*.6,.4+p.r*.6);
   });
   // Foreground extinction cuts holes through the denser luminous dust.
   for(let i=0;i<32;i++)haze(sky,width*(.055+i*.015),height*(.3+i*.014+Math.sin(i*.6)*.04),height*(.025+(i%4)*.008),'2,3,5',.48);
   cloud.clearRect(0,0,width,height);
   dust.slice(0,75).forEach((p,i)=>{
     const x=width*(.29+(p.x-.5)*.55),y=height*(.52+(p.x-.5)*.7+(p.y-.5)*.12);
     haze(cloud,x,y,16+p.r*50,i%3===0?'179,166,140':'87,91,98',.008+Math.pow(p.a,3)*.060);
   });
   stars.forEach(s=>{
     const x=s.x*width,y=s.y*height,a=.11+Math.pow(s.r,3)*.55;
     sky.fillStyle=`rgba(169,154,126,${a*.38})`;sky.beginPath();sky.arc(x,y,.25+Math.pow(s.r,6)*1.15,0,Math.PI*2);sky.fill();
     if(s.r>.985){haze(sky,x,y,4.5,'194,180,153',.18);sky.strokeStyle='rgba(221,211,192,.18)';sky.lineWidth=.5;sky.beginPath();sky.moveTo(x-4,y);sky.lineTo(x+4,y);sky.moveTo(x,y-4);sky.lineTo(x,y+4);sky.stroke();}
   });
 }
 function point(n){
   const z=n.z+depth*.6-lobeZ[n.group],scale=1/(.8+z*.42),angle=Math.sin(time*.055)*.075;
   const core=network?.core||[width*.17,height*.5];
   const radius=coreRadius();
   return [core[0]+(n.x*Math.cos(angle)+n.z*Math.sin(angle)*.12)*radius*scale+pointerX*5,
     core[1]+(n.y*radius+Math.sin(time*.16+n.phase)*1.4)*scale+pointerY*4,scale];
 }
 function coreRadius(){return network?.stage==='overview'?(network.brainScale?network.brainScale*1.22:Math.min(width*.25,height*.30,210)):width<1100?62:110;}
 function topology(value){
   network=Array.isArray(value)?null:value;
   routes=network?.routes||value||[];
   const key=network?`${network.focus}:${network.branch}:${network.working}`:'';
   if(key!==lastFocus){activation=1;lastFocus=key;}
 }
 function conduit(a,b,lit,phase=0,group=0){
   const identity=neuralIdentities[group];
   const bend=(b[0]-a[0])*.5;
   ctx.beginPath();ctx.moveTo(a[0],a[1]);ctx.bezierCurveTo(a[0]+bend,a[1],b[0]-bend*.3,b[1],b[0],b[1]);
   ctx.strokeStyle=`rgba(${lit?identity.lightRgb:identity.rgb},${lit?.46+activation*.15:.23})`;ctx.lineWidth=lit?1:.45;ctx.stroke();
   if(!lit)return;
   for(let j=0;j<3;j++){
     const t=(time*.23+phase+j/3)%1,u=1-t;
     const x=u*u*u*a[0]+3*u*u*t*(a[0]+bend)+3*u*t*t*(b[0]-bend*.3)+t*t*t*b[0];
     const y=u*u*u*a[1]+3*u*u*t*a[1]+3*u*t*t*b[1]+t*t*t*b[1];
     haze(ctx,x,y,4,identity.rgb,.28);ctx.fillStyle=`rgba(${identity.lightRgb},.85)`;ctx.fillRect(x-.6,y-.6,1.2,1.2);
   }
 }
 function draw(dt=1/30){
   if(disposed||document.hidden||!visible||!width||!height)return;
   const started=performance.now();
   ctx.globalAlpha=1;ctx.drawImage(plate,0,0,plate.width,plate.height,0,0,width,height);
   ctx.drawImage(mist,0,0,mist.width,mist.height,pointerX*10-depth*7,pointerY*7,width,height);
   if(routeProvider)topology(routeProvider());
   ctx.globalAlpha=.3;
   // Pinhole projection: distance controls size, speed, parallax and luminance.
   particles.forEach((p,i)=>{
     const scale=1/(.7+p.z+depth*.5),near=1/(.7+p.z);
     const x=width*.28+(p.x*width*.65+Math.sin(time*.09+p.phase)*9+pointerX*28*near)*scale;
     const y=height*.5+(p.y*height*.8+Math.cos(time*.06+p.phase)*7+pointerY*21*near)*scale;
     const radius=(.35+p.r*1.5)*scale,alpha=(.12+p.r*.42)*Math.min(1,near)*(1-depth*.25);
     if(p.z<.6&&p.r>.8)haze(ctx,x,y,radius*5,'156,117,46',alpha*.38);
     ctx.fillStyle=`rgba(${i%7===0?'158,159,161':i%5===0?'177,115,87':p.z<.8?'220,164,81':'151,105,41'},${alpha})`;ctx.beginPath();ctx.arc(x,y,radius,0,Math.PI*2);ctx.fill();
   });
   ctx.globalAlpha=1;
   if(network?.core)haze(ctx,network.core[0],network.core[1],network.stage==='overview'?62:30,'190,132,62',.16);
   const hover=network?.hoverFocus??-1,liftEase=still||reduced.matches?1:1-Math.exp(-dt*18);
   for(let group=0;group<5;group++){
     lobeLift[group]+=((hover===group?1:0)-lobeLift[group])*liftEase;
     lobeZ[group]=network?.stationaryNavigation?0:Math.sin(time*.32+group*1.37)*.085+lobeLift[group]*(.8+(hubs[group].z+depth*.6)*.42)/(11*.42);
   }
   const ps=nodes.map(point),radius=coreRadius();
   for(let group=0;group<5;group++)Object.assign(coreRegions[group],{x:ps[group][0],y:ps[group][1],rx:radius*ps[group][2]*.58,ry:radius*ps[group][2]*.49});
   arrivals.fill(0);
   edges.forEach(([i,j],k)=>{
     const a=ps[i],b=ps[j];ctx.beginPath();ctx.moveTo(a[0],a[1]);ctx.quadraticCurveTo((a[0]+b[0])/2+8,(a[1]+b[1])/2-5,b[0],b[1]);
     const lit=network&&nodes[i].group===network.focus;
     const near=(a[2]+b[2])*.5*(lit?1.7:.9);
     ctx.strokeStyle=`rgba(${neuralIdentities[nodes[i].group].rgb},${(.10+(k%4)*.034)*near})`;
     ctx.lineWidth=.35+near*.35;ctx.stroke();
     // Every lobe retains quiet traffic. Focus adds faster impulses with tails
     // and a brief response in the receiving neuron, along the same edge.
     if(k%(lit?2:5)===0){
       const t=(time*(lit?.38:.12)+nodes[i].group*.16+k*.031)%1;
       const tail=lit?5:2;
       for(let step=tail;step>=0;step--){
         const q=t-step*.022;if(q<0)continue;
         const u=1-q,x=u*u*a[0]+2*u*q*((a[0]+b[0])/2+8)+q*q*b[0],y=u*u*a[1]+2*u*q*((a[1]+b[1])/2-5)+q*q*b[1];
         const fade=(1-step/(tail+1))*(lit?.9:.27);
         if(step===0&&lit)haze(ctx,x,y,4,neuralIdentities[nodes[i].group].rgb,.3);
         ctx.fillStyle=`rgba(${neuralIdentities[nodes[i].group].lightRgb},${fade})`;ctx.beginPath();ctx.arc(x,y,step===0?(lit?1.1:.65):.65,0,Math.PI*2);ctx.fill();
       }
       if(lit&&t>.86)arrivals[j]=Math.max(arrivals[j],Math.sin((t-.86)/.14*Math.PI));
     }
   });
   ps.forEach(([x,y,scale],i)=>{
     const n=nodes[i],lit=network&&n.group===network.focus,pulse=(lit?.50:.30)+(lit?.15:.06)*(1+Math.sin(time*1.25-n.group*.9));
     if(arrivals[i]>.05)haze(ctx,x,y,6*scale,neuralIdentities[n.group].lightRgb,arrivals[i]*.42);
     if(n.hub){haze(ctx,x,y,18*scale,neuralIdentities[n.group].rgb,pulse*.32);haze(ctx,x,y,5*scale,neuralIdentities[n.group].lightRgb,pulse*.5);}
     ctx.fillStyle=`rgba(${n.hub?neuralIdentities[n.group].lightRgb:neuralIdentities[n.group].rgb},${pulse*Math.min(1,scale)})`;
     ctx.beginPath();ctx.arc(x,y,(n.hub?2.6:.45+(i%4)*.22)*scale,0,Math.PI*2);ctx.fill();
   });
   if(network){
     network.ports.forEach((port,group)=>{
       const radius=network.portRadii?.[group]??(network.stage==='overview'?30:17),lit=group===network.focus;
       const rotation=advanceSatelliteMotion(satelliteMotion[group],dt,!network?.stationaryNavigation&&lit,still||reduced.matches),identity=neuralIdentities[group];
       satellite.nodes.forEach((node,i)=>{
         const p=satelliteProjection[i];rotateSatellitePoint(node,rotation,rotated);
         const depth=rotated[2],perspective=845/(845-depth*radius);
         p[0]=port[0]+rotated[0]*radius*perspective;p[1]=port[1]-rotated[1]*radius*perspective;p[2]=depth;
         ctx.fillStyle=`rgba(${i%7===0?identity.lightRgb:identity.rgb},${(.38+depth*.13)*(lit?1.35:1)})`;
         ctx.beginPath();ctx.arc(p[0],p[1],i%17===0?1.1:.55,0,Math.PI*2);ctx.fill();
       });
       satellite.edges.forEach(([i,j],k)=>{
         const a=satelliteProjection[i],b=satelliteProjection[j];
         ctx.strokeStyle=`rgba(${identity.rgb},${lit?.44:.24})`;ctx.lineWidth=.5;
         ctx.beginPath();ctx.moveTo(a[0],a[1]);ctx.lineTo(b[0],b[1]);ctx.stroke();
         if(k%13===group%3){const t=(time*(lit?.40:.13)+k*.13)%1;ctx.fillStyle=lit?identity.light:identity.color;ctx.beginPath();ctx.arc(a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,lit?1:.65,0,Math.PI*2);ctx.fill();}
       });
       const glyph=glyphs[group];
       glyph.nodes.forEach((node,i)=>{
         const p=glyph.projection[i];
         const depth=node[2]*radius/845;anamorphic[0]=node[0]*(1-depth);anamorphic[1]=node[1]*(1-depth);anamorphic[2]=node[2];rotateSatellitePoint(anamorphic,rotation,rotated);
         const perspective=845/(845-rotated[2]*radius);
         p[0]=port[0]+rotated[0]*radius*perspective;p[1]=port[1]-rotated[1]*radius*perspective;p[2]=rotated[2];
       });
       for(const [i,j] of glyph.bridges){const a=glyph.projection[i],b=satelliteProjection[j];ctx.strokeStyle=`rgba(${identity.rgb},.26)`;ctx.lineWidth=.5;ctx.beginPath();ctx.moveTo(a[0],a[1]);ctx.lineTo(b[0],b[1]);ctx.stroke();}
       // A broad, faint pass supplies local bloom; the thin pass is the trunk.
       for(const [i,j] of glyph.edges){const a=glyph.projection[i],b=glyph.projection[j];
         ctx.beginPath();ctx.moveTo(a[0],a[1]);ctx.lineTo(b[0],b[1]);
         ctx.strokeStyle=`rgba(${identity.rgb},.18)`;ctx.lineWidth=3;ctx.stroke();
         ctx.strokeStyle=`rgba(${identity.lightRgb},${(lit?.98:.78)*(.72+(a[2]+b[2])*.18)})`;ctx.lineWidth=.9;ctx.stroke();
       }
       for(let i=0;i<3;i++){
         const path=glyph.routes[i%glyph.routes.length],step=((time*(lit?.17:.075)+i*.31)%1)*(path.length-1),k=Math.floor(step),t=step-k;
         const a=glyph.projection[path[k]],b=glyph.projection[path[k+1]],x=a[0]+(b[0]-a[0])*t,y=a[1]+(b[1]-a[1])*t;
         haze(ctx,x,y,3,identity.rgb,.24);ctx.fillStyle=identity.light;ctx.beginPath();ctx.arc(x,y,1.05,0,Math.PI*2);ctx.fill();
       }
     });
     network.ports.forEach((port,i)=>conduit(ps[i],port,i===network.focus,i*.12,i));
     routes.forEach(([a,b,lit],i)=>conduit(a,b,lit,i*.08,network.active??0));
     if(network.output)conduit(...network.output,true,.25,network.active??0);
     canvas.dataset.focus=String(network.focus);canvas.dataset.branch=network.branch;
     canvas.dataset.connections=String(network.ports.length);
     const core=network.core;
     ctx.font='7px system-ui';ctx.textAlign='center';ctx.fillStyle='rgba(173,151,115,.65)';ctx.fillText('M E L O',core[0],core[1]+Math.min(88,height*.14));
   }
   stars.forEach((s,i)=>{if(i%13)return;const x=s.x*width+Math.sin(time*.05+s.phase)*2,y=s.y*height;ctx.fillStyle=`rgba(226,217,200,${.12+.12*Math.sin(time*.6+s.phase)})`;ctx.beginPath();ctx.arc(x,y,.4+s.r*.8,0,Math.PI*2);ctx.fill();});
   canvas.dataset.coreRegions=JSON.stringify(coreRegions);canvas.dataset.lobeLift=Array.from(lobeLift,v=>v.toFixed(2)).join(',');canvas.dataset.glyphAngles=satelliteMotion.map(v=>v.yaw.toFixed(3)).join(',');
   draws++;canvas.dataset.draws=String(draws);canvas.dataset.drawMs=(performance.now()-started).toFixed(2);
 }
 function stop(){cancelAnimationFrame(raf);raf=0;canvas.dataset.animating='false';}
 function tick(now){raf=0;if(disposed||document.hidden||!visible||still||reduced.matches){canvas.dataset.animating='false';return;}
   if(now-last>=1000/30){const dt=Math.min((now-last)/1000,.1);time+=dt;activation=Math.max(0,activation-dt*.7);const smooth=1-Math.exp(-dt*5);depth+=(targetDepth-depth)*smooth;pointerX+=(aimX-pointerX)*smooth;pointerY+=(aimY-pointerY)*smooth;last=now;draw(dt);}raf=requestAnimationFrame(tick);
 }
 function start(){if(disposed||document.hidden||!visible||still||reduced.matches||raf)return;last=performance.now();canvas.dataset.animating='true';raf=requestAnimationFrame(tick);}
 function resize(){if(!host||disposed)return;const rect=host.getBoundingClientRect(),w=Math.round(rect.width),h=Math.round(rect.height);if(w===width&&h===height)return;width=w;height=h;
   // Dust stays soft; text remains independent native-resolution DOM.
   const dpr=Math.min(devicePixelRatio||1,1.25);canvas.width=plate.width=mist.width=Math.round(width*dpr);canvas.height=plate.height=mist.height=Math.round(height*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);sky.setTransform(dpr,0,0,dpr,0,0);cloud.setTransform(dpr,0,0,dpr,0,0);cacheSky();draw();}
 const observer=new ResizeObserver(resize),intersection=new IntersectionObserver(entries=>{visible=entries[0]?.isIntersecting??false;if(visible){draw();start();}else stop();});
 function visibility(){if(document.hidden)stop();else{draw();start();}}
 function preference(){stop();draw();start();}
 function pointer(event){aimX=event.clientX/(width||1)-.5;aimY=event.clientY/(height||1)-.5;}
 window.addEventListener('pointermove',pointer,{passive:true});
 document.addEventListener('visibilitychange',visibility);reduced.addEventListener('change',preference);
 function attach(next){if(disposed)return;observer.disconnect();intersection.disconnect();host=next;host.replaceChildren(canvas);observer.observe(host);intersection.observe(host);resize();start();}
 attach(initialHost);
 return {pickCore(x,y,current){const rect=host.getBoundingClientRect();return pickNeuralLobe(coreRegions,x-rect.left,y-rect.top,current);},attach,setDepth(value){targetDepth=value?1:0;if(still||reduced.matches)depth=targetDepth;},setRouteProvider(value){routeProvider=value;},setRoutes(value){topology(value);draw();},setStill(value){if(still===value)return;still=value;stop();draw();start();},dispose(){disposed=true;stop();observer.disconnect();intersection.disconnect();window.removeEventListener('pointermove',pointer);routeProvider=null;document.removeEventListener('visibilitychange',visibility);reduced.removeEventListener('change',preference);canvas.remove();canvas.width=canvas.height=plate.width=plate.height=mist.width=mist.height=0;host=null;}};
}
