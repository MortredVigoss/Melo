import { visualColor, visualRgb } from '../src/shared/visualTokens.js';
export const neuralIdentities = [
 {id:'chat',color:visualColor('chat'),light:visualColor('chat-light'),rgb:visualRgb('chat'),lightRgb:visualRgb('chat-light')},
 {id:'projects',color:visualColor('projects'),light:visualColor('projects-light'),rgb:visualRgb('projects'),lightRgb:visualRgb('projects-light')},
 {id:'agents',color:visualColor('agents'),light:visualColor('agents-light'),rgb:visualRgb('agents'),lightRgb:visualRgb('agents-light')},
 {id:'knowledge',color:visualColor('knowledge'),light:visualColor('knowledge-light'),rgb:visualRgb('knowledge'),lightRgb:visualRgb('knowledge-light')},
 {id:'system',color:visualColor('system'),light:visualColor('system-light'),rgb:visualRgb('system'),lightRgb:visualRgb('system-light')},
];

// An interrupted focus turn always starts at the current attitude. Free spin
// resumes from there, so leaving a target never jumps back to a clock angle.
const wrap=a=>Math.atan2(Math.sin(a),Math.cos(a));
export function createSatelliteMotion(group=0) {
 return {yaw:[.48,-.62,.56,-.46,.67][group],pitch:.18-group*.065,roll:0,focused:false,elapsed:0,from:[0,0,0]};
}
export function advanceSatelliteMotion(state,dt,focused,instant=false) {
 if(focused!==state.focused){state.focused=focused;state.elapsed=0;state.from=[wrap(state.yaw),wrap(state.pitch),wrap(state.roll)];}
 if(instant){state.yaw=state.pitch=state.roll=0;}
 else if(focused){
   state.elapsed=Math.min(.20,state.elapsed+dt);const remaining=(1-state.elapsed/.20)**3;
   [state.yaw,state.pitch,state.roll]=state.from.map(a=>a*remaining);
 }else{
   state.yaw=wrap(state.yaw+dt*.17);state.pitch=wrap(state.pitch+dt*.075);state.roll=wrap(state.roll+dt*.018);
 }
 return {cs:Math.cos(state.yaw),sn:Math.sin(state.yaw),cp:Math.cos(state.pitch),sp:Math.sin(state.pitch),cr:Math.cos(state.roll),sr:Math.sin(state.roll)};
}
export function rotateSatellitePoint(p,r,out) {
 const x=p[0]*r.cs+p[2]*r.sn,z=p[2]*r.cs-p[0]*r.sn;
 const y=p[1]*r.cp-z*r.sp;
 out[0]=x*r.cr-y*r.sr;out[1]=x*r.sr+y*r.cr;out[2]=p[1]*r.sp+z*r.cp;return out;
}

// Curves are cut into short filaments separated by physical gaps. Independent
// depths make all five canonical front views anamorphic, including the solids.
export function createSatelliteGlyph(group) {
 const paths=[];
 const line=(a,b,n=24)=>Array.from({length:n+1},(_,i)=>a.map((v,k)=>v+(b[k]-v)*i/n));
 if(group===0)paths.push(Array.from({length:161},(_,i)=>{const a=i*Math.PI/80;return [.62*Math.cos(a),.62*Math.sin(a),0];}));
 if(group===1){const corners=[[0,.73,0],[.60,0,0],[0,-.73,0],[-.60,0,0],[0,.73,0]];paths.push(corners.slice(0,-1).flatMap((p,i)=>line(p,corners[i+1]).slice(i?1:0)));}
 if(group===2)paths.push(Array.from({length:161},(_,i)=>{const a=i*Math.PI/80;return [.69*Math.cos(a)**3,.76*Math.sin(a)**3,0];}));
 if(group===3){
   // A regular tetrahedron: four equilateral faces, tilted to expose its
   // rear vertex in the canonical view rather than reading as a flat triangle.
   const r=.78,base=Math.sqrt(8/9)*r;
   const tetra=[[0,r,0],...Array.from({length:3},(_,i)=>{const a=Math.PI/6+i*Math.PI*2/3;return [base*Math.cos(a),-r/3,base*Math.sin(a)];})];
   const orient=p=>[p[0],p[1]*Math.cos(.38)-p[2]*Math.sin(.38),p[1]*Math.sin(.38)+p[2]*Math.cos(.38)];
   tetra.forEach((p,i)=>{for(let j=i+1;j<tetra.length;j++)paths.push(line(orient(p),orient(tetra[j])));});
 }
 if(group===4){
   // A faceted synaptic processor: a real cube with a small central junction,
   // replacing the six circles. An isometric rest view exposes three axes.
   const cube=Array.from({length:8},(_,i)=>[(i&1?1:-1)*.40,(i&2?1:-1)*.40,(i&4?1:-1)*.40]);
   const orient=p=>{const x=(p[0]-p[2])*Math.SQRT1_2,z=(p[0]+p[2])*Math.SQRT1_2;return [x,p[1]*.82-z*.57,p[1]*.57+z*.82];};
   cube.forEach((p,i)=>{for(let axis=0;axis<3;axis++){const j=i^(1<<axis);if(j>i)paths.push(line(orient(p),orient(cube[j])));}});
   for(const i of [1,2,4,7])paths.push(line([0,0,0],orient(cube[i])));
 }
 const nodes=[],edges=[],routes=[];
 paths.forEach((path,pathIndex)=>{
   const lengths=[0];for(let i=1;i<path.length;i++)lengths.push(lengths.at(-1)+Math.hypot(...path[i].map((v,k)=>v-path[i-1][k])));
   const total=lengths.at(-1),count=Math.max(2,Math.round(total/.20)),stride=total/count,route=[];
   const at=d=>{let i=1;while(i<lengths.length-1&&lengths[i]<d)i++;const t=(d-lengths[i-1])/(lengths[i]-lengths[i-1]||1);return path[i].map((v,k)=>path[i-1][k]+(v-path[i-1][k])*t);};
   for(let part=0;part<count;part++){
     const depth=.53*Math.sin(part*2.399+group*.9+pathIndex*1.31),slope=.13*Math.cos(part*1.73+pathIndex);
     for(let end=0;end<3;end++){
       const p=at((part+end*.33)*stride);
       p[2]=depth+slope*(end-1);
       const index=nodes.length;nodes.push(p);route.push(index);if(end)edges.push([index-1,index]);
     }
   }
   routes.push(route);
 });
 return {nodes,edges,routes};
}

// Perspective distance / 11 moves a lobe close enough to appear 10% larger.
export function lobeDepth(time,group,lift,distance,scale) {
 return Math.sin(time*.32+group*1.37)*.085+lift*distance/(11*Math.max(1,scale));
}
export function pickNeuralLobe(regions,x,y,current=-1) {
 let winner=-1,best=Infinity;
 for(let i=0;i<regions.length;i++){
   const r=regions[i];if(!r)continue;
   const d=((x-r.x)/r.rx)**2+((y-r.y)/r.ry)**2;
   if(d<1.12&&d-(i===current?.12:0)<best){best=d-(i===current?.12:0);winner=i;}
 }
 return winner;
}

export function createGlyphBridges(glyph,tissue) {
 return Array.from({length:8},(_,k)=>{
   const i=Math.floor(k*glyph.nodes.length/8),p=glyph.nodes[i];let best=0,distance=Infinity;
   tissue.nodes.forEach((q,j)=>{const d=p.reduce((sum,v,axis)=>sum+(v-q[axis])**2,0);if(d<distance){distance=d;best=j;}});
   return [i,best];
 });
}

// Shared local tissue for the five navigation targets. Coordinates are unit
// volume samples, never a circular outline. Both renderers use the same graph.
export function createSatelliteTopology() {
 const nodes=Array.from({length:240},(_,i)=>{
   const y=1-2*(i+.5)/240,a=i*2.399963229728653,r=Math.sqrt(1-y*y);
   const fold=(i%4===0?.48:.82)+.12*Math.sin(i*1.71);
   return [Math.cos(a)*r*fold,y*fold,Math.sin(a)*r*fold];
 });
 const neurons=Array.from({length:32},(_,i)=>i*7),edges=[];
 neurons.forEach((i)=>{
   const nearest=neurons.filter(j=>j!==i).map(j=>({j,d:nodes[i].reduce((sum,v,k)=>sum+(v-nodes[j][k])**2,0)})).sort((a,b)=>a.d-b.d).slice(0,3);
   for(const {j} of nearest)if(j>i)edges.push([i,j]);
 });
 return {nodes,edges};
}
