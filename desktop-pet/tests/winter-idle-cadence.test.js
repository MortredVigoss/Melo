const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
function setup(id = 'winter') {
  let now = 0;
  const math = Object.create(Math); math.random = () => .5;
  const ctx = vm.createContext({ Math: math, Date: {now: () => now}, console });
  vm.runInContext(fs.readFileSync(path.join(root,'upstream/runtime/electron-helper/shared-core.js'),'utf8')+';globalThis.S=PetShared;',ctx);
  vm.runInContext(fs.readFileSync(path.join(root,'upstream/runtime/electron-helper/sprite.js'),'utf8')+';globalThis.Sprite=PetSprite;',ctx);
  const pack = require('../skins/winter/winter-config.json');
  const plays=[];
  const s=Object.assign(Object.create(ctx.Sprite.prototype),{assetRoot:id,pet:{id,fixedEnabled:true},animations:pack.animations,weights:pack.animationWeights,anim:pack.animations.idle[0],frozen:false,playback:null,dragState:{active:false},workState:null,stopMove(){},playOnce(name){this.anim=name;plays.push(name);},facing:'left'});
  s.resetAutonomousCooldown();
  return {s,plays,advance:ms=>{now=ms},prototype:ctx.Sprite.prototype};
}
test('Winter remains idle across clip endings until its cooldown expires',()=>{
  const {s,plays,advance}=setup();assert.equal(s.nextAutoActionAt,45000);
  for(const now of [10000,20000,30000,40000]){advance(now);s.handleEnded();assert(s.animations.idle.includes(s.anim));assert.equal(s.nextAutoActionAt,45000);}
  advance(50000);s.handleEnded();assert(!s.animations.idle.includes(s.anim));assert.equal(plays.length,5);
});
test('one automatic action is followed by a fresh rest period, never back-to-back actions',()=>{
  const {s,advance}=setup();advance(50000);s.handleEnded();advance(60000);s.handleEnded();
  assert.equal(s.nextAutoActionAt,105000);assert(s.animations.idle.includes(s.anim));
});
test('explicit playback bypasses the autonomous cooldown without changing playback speed',()=>{
  const {s,prototype}=setup();let call;s.switchTo=(...args)=>{call=args};s.stopMove=()=>{};
  prototype.playOnce.call(s,'小提琴演奏','request-1');
  assert.equal(call[0],'小提琴演奏');assert.equal(call[1],true);assert.equal(call[2],'request-1');assert.equal(s.nextAutoActionAt,45000);
});
test('大肥鱼 keeps its upstream random schedule',()=>{
  const {s}=setup('main');assert.equal(s.nextAutoActionAt,undefined);s.handleEnded();assert(!s.animations.idle.includes(s.anim));
});
test('frozen Winter does not advance the random chain',()=>{
  const {s,plays,advance}=setup();advance(90000);s.frozen=true;s.handleEnded();assert.equal(plays.length,0);
});
