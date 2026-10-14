// Reconcile only changed nodes. Scene, inputs, scroll containers and hydrated
// visualizations keep their identity across bootstrap polls and UI updates.
const rendered=new WeakMap(),forms=new WeakMap(),declared=new WeakMap();
const key=node=>node.nodeType===1?(node.id||node.getAttribute('data-neural-key')||node.getAttribute('data-message-id')||''):'';
function remember(node,next=node){
 rendered.set(node,next.nodeType===1?next.outerHTML:next.textContent);
 if(next.nodeType===1){declared.set(node,[...next.attributes].map(a=>a.name));if(/^(TEXTAREA|INPUT|SELECT)$/.test(next.tagName))forms.set(node,{value:next.value,checked:next.checked});}
}
function stamp(node){remember(node);for(const child of node.childNodes)stamp(child);}
function attributes(el,next){
 // Preserve attributes installed by runtime owners, such as measured positions.
 for(const name of declared.get(el)||[])if(!next.hasAttribute(name))el.removeAttribute(name);
 for(const attr of next.attributes)if(el.getAttribute(attr.name)!==attr.value)el.setAttribute(attr.name,attr.value);
}
function morph(el,next){
 if(next.nodeType===1&&next.hasAttribute('data-preserve-neural-region'))return;
 const html=next.nodeType===1?next.outerHTML:next.textContent;
 const oldForm=forms.get(el);
 if(rendered.get(el)===html)return;
 if(el.nodeType!==1){el.textContent=next.textContent;rendered.set(el,html);return;}
 attributes(el,next);
 // Canvas descendants and scene-owned nodes are never declarative children.
 if(!el.classList.contains('neural-cosmos')&&!el.hasAttribute('data-execution-owned')){
   if(el.tagName==='TEXTAREA'){
     if(oldForm?.value!==next.value&&el.value!==next.value)el.value=next.value;
     el.defaultValue=next.defaultValue;
   }else{
     reconcile(el,[...next.childNodes]);
     if(el.tagName==='INPUT'){
       if(el.type!=='file'&&oldForm?.value!==next.value&&el.value!==next.value)el.value=next.value;
       if(oldForm?.checked!==next.checked)el.checked=next.checked;
     }
     if(el.tagName==='SELECT'&&oldForm?.value!==next.value)el.value=next.value;
   }
 }
 remember(el,next);
}
function reconcile(parent,nextNodes){
 const old=[...parent.childNodes],used=new Set();let cursor=parent.firstChild;
 const keyed=new Map(old.filter(n=>key(n)).map(n=>[`${n.nodeName}:${key(n)}`,n]));
 for(const next of nextNodes){
   const k=key(next);
   let match=k?keyed.get(`${next.nodeName}:${k}`):null;
   if(used.has(match))match=null;
   if(!match&&!k&&cursor&&!used.has(cursor)&&!key(cursor)&&cursor.nodeName===next.nodeName)match=cursor;
   if(!match&&!k)match=old.find(n=>!used.has(n)&&!key(n)&&n.nodeName===next.nodeName);
   if(match){used.add(match);if(match!==cursor)parent.insertBefore(match,cursor);morph(match,next);cursor=match.nextSibling;}
   else{const added=next.cloneNode(true);stamp(added);parent.insertBefore(added,cursor);}
 }
 for(const node of old)if(!used.has(node))node.remove();
}
export function updateNeuralWorkspace(app,html){
 const template=app.ownerDocument.createElement('template');template.innerHTML=html;
 reconcile(app,[...template.content.childNodes]);
}

export function preserveNeuralRegion(node){
 if(!node)return '';
 const shell=node.cloneNode(false);shell.setAttribute('data-preserve-neural-region','');
 return shell.outerHTML;
}

// The composer is controlled by uiState, so an explicit send/reset also clears
// a user-edited value when its last rendered markup was already empty.
export function syncNeuralComposer(app,value){
 const input=app.querySelector('#composer');
 if(input&&input.value!==value)input.value=value;
}
