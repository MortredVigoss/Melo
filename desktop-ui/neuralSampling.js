// Geometry is stable between interactions. Sample through transitions, then
// reuse it; an occasional refresh covers font/layout changes outside our shell.
export function createRouteSampler(read, {now=()=>performance.now(), settleMs=860, maxAgeMs=1200}={}) {
 let value=null,dirty=true,movingUntil=0,readAt=-Infinity,reads=0;
 return {
  invalidate(duration=settleMs){dirty=true;movingUntil=Math.max(movingUntil,now()+duration);},
  get(){const time=now();if(dirty||time<movingUntil||time-readAt>=maxAgeMs){value=read();readAt=time;dirty=false;reads++;}return value;},
  get reads(){return reads;},
 };
}
