// The login capability belongs to the local settings UI. Neither QR tokens nor
// upstream account responses enter the model, the transcript, or bootstrap.
const sessions = new WeakMap();
const readJson = raw => raw?.structuredContent || (raw?.content || []).map(b=>{try{return JSON.parse(b.text);}catch{return null;}}).find(Boolean) || {};
export async function socialLogin(client, id, action, hasSession = async()=>false) {
  const call = async (name,args={}) => {
    const raw=await client.callTool(name,args,AbortSignal.timeout(60000));
    if(raw?.isError) throw new Error('Platform login service unavailable. Try again in settings.');
    return raw;
  };
  if(action==='status') {
    const cached=sessions.get(client);
    if(cached && (Date.now()-cached.time)>180000) sessions.delete(client);
    else if(cached) {
      const state=readJson(await call('check_login_qrcode',{token:cached.token})).data?.status;
      if(state==='expired' || state==='confirmed') sessions.delete(client);
      if(state==='expired') return {status:'expired'};
    }
    const raw=await call('check_login_status');
    const logged=id==='melo-douyin' ? readJson(raw).logged_in===true && await hasSession() :
      (raw.content || []).some(b=>/✅.*已登录/u.test(b.text));
    return {status:logged?'authenticated':'login_required'};
  }
  if(action!=='start') throw new Error('Unknown login action.');
  const raw=await call('get_login_qrcode');
  const data=readJson(raw).data || {};
  const value=id==='melo-douyin' ? Object.values(data).find(v=>typeof v==='string' && v.startsWith('iVBORw0KGgo')) : raw.content?.find(b=>b.type==='image' && b.mimeType==='image/png')?.data;
  if(!value) {
    if((raw.content || []).some(b=>/已处于登录状态/.test(b.text))) return {status:'authenticated'};
    throw new Error('No QR image returned by platform.');
  }
  if(value.length>2_000_000 || !/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Invalid QR image.');
  if(id==='melo-douyin') {
    if(typeof data.token!=='string' || !data.token) throw new Error('Missing QR session.');
    sessions.set(client,{token:data.token,time:Date.now()});
  }
  return {status:'scan',image:'data:image/png;base64,'+value};
}
