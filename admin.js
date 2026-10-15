const API='/api/wechat';
const $=(selector)=>document.querySelector(selector);
const loginCard=$('#login-card'),editorCard=$('#editor-card'),loginForm=$('#login-form'),draftForm=$('#draft-form');
const loginStatus=$('#login-status'),draftStatus=$('#draft-status'),coverInput=$('#cover-file'),coverState=$('#cover-state'),coverPreview=$('#cover-preview');
let coverMediaId='',coverObjectUrl='',uploadedImageUrls=[],savedMediaId='';

async function api(action,{method='POST',body,headers={}}={}){
  const options={method,credentials:'same-origin',headers:{...headers}};
  if(body instanceof FormData)options.body=body;
  else if(body!==undefined){options.headers['content-type']='application/json';options.body=JSON.stringify(body);}
  const response=await fetch(`${API}?action=${encodeURIComponent(action)}`,options);
  const data=await response.json().catch(()=>({error:'服务器返回了无法读取的结果。'}));
  if(!response.ok)throw new Error(data.error||'请求失败，请稍后重试。');
  return data;
}

function setStatus(element,message,tone='error'){
  element.textContent=message;element.dataset.tone=tone;
}

function setBusy(button,busy,label){
  if(busy){button.dataset.originalText=button.textContent;button.disabled=true;button.textContent=label;}
  else{button.disabled=false;if(button.dataset.originalText)button.textContent=button.dataset.originalText;}
}

async function checkSession(){
  try{
    const response=await fetch(`${API}?action=status`,{credentials:'same-origin',cache:'no-store'});
    if(!response.ok)return;
    const data=await response.json();
    if(data.authenticated){loginCard.hidden=true;editorCard.hidden=false;}
  }catch{}
}

loginForm.addEventListener('submit',async(event)=>{
  event.preventDefault();
  const button=loginForm.querySelector('button[type=submit]');setBusy(button,true,'正在验证…');setStatus(loginStatus,'');
  try{
    await api('login',{body:{password:$('#admin-password').value}});
    loginForm.reset();loginCard.hidden=true;editorCard.hidden=false;setStatus(draftStatus,'已安全登录。草稿保存后仍需你在公众号平台手动发布。','success');
  }catch(error){setStatus(loginStatus,error.message);}
  finally{setBusy(button,false);}
});

$('#logout-button').addEventListener('click',async()=>{
  try{await api('logout',{});}catch{}
  coverMediaId='';uploadedImageUrls=[];editorCard.hidden=true;loginCard.hidden=false;setStatus(loginStatus,'已退出后台。','success');
});

function updateCounters(){
  document.querySelectorAll('[data-count]').forEach(input=>{
    const counter=document.querySelector(`[data-count="${input.id}"]`);counter.textContent=`${[...input.value].length} / ${counter.dataset.max}`;
  });
  const text=$('#article-content').innerText||'';$('#body-count').textContent=`${[...text].length.toLocaleString()} 字 · ${new Blob([$('#article-content').innerHTML]).size.toLocaleString()} B`;
}
document.querySelectorAll('[data-count]').forEach(input=>input.addEventListener('input',updateCounters));$('#article-content').addEventListener('input',updateCounters);

document.querySelectorAll('.toolbar [data-command]').forEach(button=>button.addEventListener('click',()=>{
  $('#article-content').focus();document.execCommand(button.dataset.command,false,button.dataset.value||null);updateCounters();
}));
$('#link-button').addEventListener('click',()=>{
  const url=prompt('输入要插入的 https:// 链接');if(!url)return;
  try{const parsed=new URL(url);if(parsed.protocol!=='https:')throw new Error();$('#article-content').focus();document.execCommand('createLink',false,parsed.href);updateCounters();}
  catch{setStatus(draftStatus,'请使用有效的 HTTPS 链接。');}
});

coverInput.addEventListener('change',async()=>{
  const file=coverInput.files?.[0];if(!file)return;
  if(coverObjectUrl)URL.revokeObjectURL(coverObjectUrl);coverObjectUrl=URL.createObjectURL(file);coverPreview.src=coverObjectUrl;coverPreview.hidden=false;
  coverMediaId='';coverState.textContent='正在上传到公众号…';coverState.dataset.tone='pending';
  try{
    const form=new FormData();form.set('image',file);
    const data=await api('upload-cover',{body:form});coverMediaId=data.media_id;coverState.textContent='封面上传成功';coverState.dataset.tone='success';
  }catch(error){coverState.textContent=error.message;coverState.dataset.tone='error';}
});

$('#inline-file').addEventListener('change',async(event)=>{
  const file=event.target.files?.[0];if(!file)return;
  const selection=window.getSelection();const savedRange=selection?.rangeCount?selection.getRangeAt(0).cloneRange():null;
  setStatus(draftStatus,'正在上传正文图片…','pending');
  try{
    const form=new FormData();form.set('image',file);const data=await api('upload-inline',{body:form});
    uploadedImageUrls.push(data.url);
    const img=document.createElement('img');img.src=data.url;img.alt=file.name||'文章配图';img.loading='lazy';
    const editor=$('#article-content');editor.focus();
    if(savedRange&&editor.contains(savedRange.commonAncestorContainer)){selection.removeAllRanges();selection.addRange(savedRange);}
    else{const range=document.createRange();range.selectNodeContents(editor);range.collapse(false);selection.removeAllRanges();selection.addRange(range);}
    document.execCommand('insertHTML',false,`${img.outerHTML}<p><br></p>`);updateCounters();setStatus(draftStatus,'正文图片已上传并插入。','success');
  }catch(error){setStatus(draftStatus,error.message);}
  finally{event.target.value='';}
});

draftForm.addEventListener('submit',async(event)=>{
  event.preventDefault();
  if(!coverMediaId){setStatus(draftStatus,'请先成功上传公众号封面。');return;}
  const content=$('#article-content').innerHTML.trim();
  const visibleText=$('#article-content').innerText.trim();
  if(!visibleText){setStatus(draftStatus,'请先填写文章正文。');return;}
  if([...visibleText].length>=20_000||new Blob([content]).size>=1_000_000){setStatus(draftStatus,'正文超过微信接口限制，请精简后再保存。');return;}
  const payload={title:$('#article-title').value,author:$('#article-author').value,digest:$('#article-digest').value,content,thumb_media_id:coverMediaId,uploaded_image_urls:uploadedImageUrls};
  const button=$('#save-draft');setBusy(button,true,'正在保存草稿…');setStatus(draftStatus,'');$('#draft-success').hidden=true;
  try{
    const data=await api('save-draft',{body:payload});savedMediaId=data.media_id;$('#draft-success').hidden=false;setStatus(draftStatus,'保存成功：已进入公众号草稿箱，尚未发布。','success');
  }catch(error){setStatus(draftStatus,error.message);}
  finally{setBusy(button,false);}
});

$('#copy-media-id').addEventListener('click',async()=>{
  try{await navigator.clipboard.writeText(savedMediaId);$('#copy-media-id').textContent='已复制';}
  catch{$('#copy-media-id').textContent=savedMediaId||'复制失败';}
});
$('#new-draft').addEventListener('click',()=>{
  draftForm.reset();$('#article-content').innerHTML='';coverMediaId='';uploadedImageUrls=[];savedMediaId='';coverState.textContent='尚未上传';coverPreview.hidden=true;$('#draft-success').hidden=true;setStatus(draftStatus,'');updateCounters();window.scrollTo({top:0,behavior:'smooth'});
});

checkSession();updateCounters();
