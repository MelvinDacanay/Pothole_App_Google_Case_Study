import React,{useEffect,useState} from 'react';
import {useAuth} from '../context/AuthContext';

export function ProtectedImage({src,publicPhoto=false,...props}:React.ImgHTMLAttributes<HTMLImageElement>&{publicPhoto?:boolean}) {
  const {user}=useAuth(); const privateRoute=typeof src==='string'&&/^\/api\/media\/[A-Za-z0-9_-]{1,128}(?:\?variant=thumb)?$/.test(src);
  const [loaded,setLoaded]=useState<{source:string;uid:string;url:string}|null>(null);
  useEffect(()=>{
    if(publicPhoto||!privateRoute||!user||!src)return;
    const controller=new AbortController();let url:string|undefined;
    void(async()=>{try{const token=await user.getIdToken();const r=await fetch(src,{headers:{Authorization:`Bearer ${token}`},signal:controller.signal,cache:'default'});if(!r.ok||!/^image\/(jpeg|png|webp)$/.test(r.headers.get('content-type')||''))return;const b=await r.blob();if(controller.signal.aborted)return;url=URL.createObjectURL(b);setLoaded({source:src,uid:user.uid,url});}catch{/* image remains a placeholder */}})();
    return()=>{controller.abort();if(url)URL.revokeObjectURL(url);};
  },[src,user,privateRoute,publicPhoto]);
  const actual=!publicPhoto&&privateRoute&&user?(loaded?.source===src&&loaded?.uid===user.uid?loaded.url:undefined):src;
  return <img {...props} src={actual}/>;
}
