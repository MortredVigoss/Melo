// Extract evidence from returned platform data, never from the arguments or a
// search card. A Douyin description is not evidence of watching the video.
export function socialSource(name, raw) {
  if (raw?.isError || !['get_feed_detail','get_video_detail','get_video_comments'].includes(name)) return null;
  const docs = [raw.structuredContent, ...(raw.content || []).filter(x=>x.type==='text').map(b=>{
    try {return JSON.parse(b.text);} catch {return null;}
  })].filter(Boolean);
  for(const d of docs) {
    if(name==='get_feed_detail') {
      const note = d.data?.note || d.note;
      if(/^[a-z0-9]{8,40}$/i.test(note?.noteId || '') && typeof note.desc==='string' && note.desc.trim())
        return {url:'https://www.xiaohongshu.com/explore/'+note.noteId,text:note.desc,reading:'extracted'};
    } else if(name==='get_video_detail') {
      const video=d.aweme_detail || d.data?.aweme_detail || d.data || d;
      if (/^\d{8,25}$/.test(video.aweme_id || '') && typeof video.desc==='string' && video.desc.trim())
        return {url:'https://www.douyin.com/video/'+video.aweme_id,text:video.desc,reading:'partial'};
    } else {
      const comments=d.comments || d.data?.comments;
      if (!Array.isArray(comments)) continue;
      const first=comments.find(x=>/^\d{8,25}$/.test(x?.aweme_id || '') && typeof x?.text==='string' && x.text.trim());
      if(first) return {url:'https://www.douyin.com/video/'+first.aweme_id,text:comments.filter(x=>x?.aweme_id===first.aweme_id).map(x=>x.text).filter(Boolean).join('\n'),reading:'partial'};
    }
  }
  return null;
}
