import {mediaPostRef} from '../../../shared/agent/media/mediaPostRef.js';

export function mediaLink(input) {
  let url;
  try{url=new URL(input);}catch{return null;}
  if(url.username || url.password || url.port || !['https:','http:'].includes(url.protocol))return null;
  url.protocol='https:';
  url.hash='';
  const post=mediaPostRef(url.href);
  if(!post)return null;
  return {...post,url:post.platform.id==='youtube'?'https://www.youtube.com/watch?v='+post.id:url.href};
}
