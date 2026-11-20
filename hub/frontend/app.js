const $=id=>document.getElementById(id);
let session,task,projects=null,selection='',inspection=false,seen=0,lastRunning=false,diffData={changes:[]},filter='code',activeFile='',editor,models=[],selected=new Set(),polling=false,pending=false,lastVersion=0;
const themeSelect=$('theme'),themePreference='ave-workspace-theme';
function applyWorkspaceTheme(theme){
  if(!['original','blue','mono'].includes(theme))theme='mono';
  document.documentElement.dataset.theme=theme;themeSelect.value=theme;
  if(!editor)return;
  if(theme==='original'){monaco.editor.setTheme('vs');return;}
  const palette=getComputedStyle(document.documentElement);
  const color=token=>palette.getPropertyValue('--'+token).trim();
  monaco.editor.defineTheme('ave-'+theme,{base:'vs',inherit:true,rules:[],colors:{
    'editor.background':color('paper'),'editor.foreground':color('ink'),'editorGutter.background':color('surface'),
    'editor.lineHighlightBackground':color('surface'),'editorLineNumber.foreground':color('muted'),'diffEditor.border':color('line')
  }});
  monaco.editor.setTheme('ave-'+theme);
}
let savedTheme;
try{savedTheme=localStorage.getItem(themePreference);}catch{}
applyWorkspaceTheme(savedTheme);
themeSelect.onchange=()=>{
  applyWorkspaceTheme(themeSelect.value);
  try{localStorage.setItem(themePreference,themeSelect.value);}catch{}
};
let seenInteractiveSelection,interactiveOrigin='';
let previewInspectorReady=false,previewRecovering=false;
let chatSubmitting=false,lastReviewedRequestId;
let requestDiff;
const modelPicker=$('codex-model'),modelPreference='ave-codex-model';
const effortPicker=$('codex-effort'),effortPreference='ave-codex-effort';
let modelsRequested=false;
let availableModels=[];
modelPicker.onchange=()=>{
  updateEfforts(effortPicker.value);
  try{localStorage.setItem(modelPreference,modelPicker.value);}catch{}
  effortPicker.onchange();
};
effortPicker.onchange=()=>{
  try{localStorage.setItem(effortPreference,effortPicker.value);}catch{}
};
function updateEfforts(preferred){
  const model=availableModels.find(item=>modelPicker.value?item.id===modelPicker.value:item.isDefault);
  const efforts=model?.efforts??[];
  effortPicker.replaceChildren(new Option('기본',''));
  for(const effort of efforts){
    const label=effort==='xhigh'?'XHigh':effort[0].toUpperCase()+effort.slice(1);
    effortPicker.add(new Option(label,effort));
  }
  effortPicker.value=efforts.includes(preferred)?preferred:'';
  effortPicker.disabled=!efforts.length;
}
async function loadModels(){
  if(modelsRequested)return;
  modelsRequested=true;
  try{
    const available=await api('/api/models');
    if(!Array.isArray(available))throw Error('모델 목록 형식 오류');
    availableModels=available;
    for(const {id,name} of available)modelPicker.add(new Option(name||id,id));
    let savedModel,savedEffort;
    try{savedModel=localStorage.getItem(modelPreference);savedEffort=localStorage.getItem(effortPreference);}catch{}
    if(available.some(({id})=>id===savedModel))modelPicker.value=savedModel;
    updateEfforts(savedEffort);
  }catch{
    modelPicker.options[0].textContent='기본 모델 (목록 확인 실패)';
  }
}
function notice(text,success=false){$('notice').textContent=text;$('notice').hidden=false;$('notice').classList.toggle('success',success);}
async function api(url,body){const headers={};if(body!==undefined){headers['Content-Type']='application/json';headers[session.csrfHeader]=session.csrf;}const r=await fetch(url,{method:body===undefined?'GET':'POST',signal:AbortSignal.timeout(200000),headers,body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(data.error||data.message||`요청 실패 (${r.status})`);return data;}
async function action(name,body={}){if(!task)throw Error('새 작업을 먼저 시작하세요');return api(`/api/tasks/${task.id}/${name}`,body);}
function showDialog({title,message,details='',confirmLabel='확인',canCancel=true}){
  const dialog=$('app-dialog'), cancel=$('dialog-cancel'), confirm=$('dialog-confirm');
  if(dialog.open)return Promise.resolve(false);
  $('dialog-title').textContent=title;
  $('dialog-message').textContent=message;
  $('dialog-details').textContent=details;
  $('dialog-details').hidden=!details;
  cancel.hidden=!canCancel;
  confirm.textContent=confirmLabel;
  dialog.returnValue='';
  return new Promise(resolve=>{
    dialog.addEventListener('close',()=>resolve(dialog.returnValue==='confirm'),{once:true});
    dialog.showModal();
    (canCancel?cancel:confirm).focus();
  });
}
const confirmDialog=options=>showDialog(options);
const alertDialog=(title,message)=>showDialog({title,message,canCancel:false});

async function run(fn,previewMessage){
  try{
    pending=true;buttons();
    if(previewMessage){
      $('notice').hidden=true;
      $('preview-loading-text').textContent=previewMessage;
      $('preview-loading').hidden=false;
      $('task-state').textContent=previewMessage;
    }
    await fn();
  }catch(e){notice(e.message);}finally{
    if(previewMessage){$('preview-loading').hidden=true;if(task)showTaskState();else $('task-state').textContent='작업 없음';}
    pending=false;buttons();
  }
}
let eventStream,streamTaskId,lastRebuildSeq=0;
function syncEventStream(){
  const id=session?.connected&&task&&!['applied','discarded'].includes(task.state)?task.id:null;
  if(id===streamTaskId)return;
  eventStream?.close();
  eventStream=undefined;streamTaskId=id;
  if(!id||typeof EventSource==='undefined')return;
  const stream=new EventSource('/api/tasks/'+id+'/events');
  eventStream=stream;
  stream.onopen=()=>void poll();
  stream.onmessage=message=>{
    if(eventStream!==stream||task?.id!==id)return;
    let entry;
    try{entry=JSON.parse(message.data);}catch{return;}
    if(!entry||!Number.isSafeInteger(entry.seq)||entry.seq<=seen)return;
    // Let the next status response fill any gap before rendering later fragments.
    if(entry.seq!==seen+1){void poll();return;}
    events([entry]);
    if(entry.type==='request-diff')void poll();
  };
}
function buttons(){syncEventStream();const live=task&&!['applied','discarded'].includes(task.state),running=task?.running||task?.busy;
  $('create').disabled=pending||!session?.connected||!$('project').value;
  $('project').disabled=pending||!projects?.length;
  for(const id of ['inspect','reload','navigate','restart'])$(id).disabled=pending||!live||!task.previewReady;
  if(previewRefreshLocked()){
    $('reload').disabled=$('restart').disabled=true;
    addEventListener('beforeunload',protectSelection);
  }else removeEventListener('beforeunload',protectSelection);
  $('preview-power').disabled=pending||!session?.connected||!live||running;
  $('preview-power-label').textContent=live&&task.previewReady?'Preview 끄기':'Preview 켜기';
  $('send').disabled=pending||!session?.connected||!live||running;$('stop').disabled=pending||!running;
  const progress=chatSubmitting?'Codex에 요청을 보내는 중입니다':task?.state==='rebuilding'?'Preview 재빌드 중':task?.state==='refreshing'?'Preview 리소스 갱신 중':task?.running?'Codex 작업 중 · 다음 요청 작성 가능':'';
  const message=$('chat-progress-text');
  if(message.textContent!==progress)message.textContent=progress;
  $('chat-progress').hidden=!progress;
  $('discard').disabled=pending||!live||running;$('apply').disabled=pending||!live||running||!!requestDiff||!selected.size||!diffData.revision;
  $('refresh-diff').disabled=pending||!live||running||!!requestDiff;
  const latest=task?.requests?.findLast(request=>request.changed&&!request.reverted)?.id;
  for(const row of $('messages').querySelectorAll('.request-actions')){
    const request=task?.requests?.find(item=>item.id===row.dataset.requestId);
    const [view,undo,status]=row.children;
    row.hidden=!live;
    view.disabled=pending||!session?.connected||task?.state==='discarded';
    view.setAttribute('aria-pressed',String(requestDiff?.id===row.dataset.requestId));
    undo.hidden=!live||row.dataset.requestId!==latest;
    undo.disabled=pending||!session?.connected||running;
    status.hidden=!request?.reverted;
  }
}
function append(type,text){const d=document.createElement('div');d.className='message '+type;if(['user','assistant','error'].includes(type)){const who=document.createElement('span');who.className='author';who.textContent=type==='user'?'YOU':type==='assistant'?'CODEX':'ERROR';d.append(who);}const content=document.createElement('span');content.textContent=text;d.append(content);$('messages').append(d);$('messages').scrollTop=$('messages').scrollHeight;return content;}
let deltaNode;
function events(events){for(const e of events){
  if(e.seq<=seen)continue;seen=e.seq;
  if(e.type==='user'){append('user',e.text);deltaNode=null;continue;}
  if(e.type==='request-diff'){addRequestActions(e.requestId);deltaNode=null;continue;}
  if(e.type==='delta'){
    const chat=$('messages'),follow=chat.scrollHeight-chat.scrollTop-chat.clientHeight<24;
    if(!deltaNode)deltaNode=append('assistant','');
    deltaNode.textContent+=e.text;
    if(follow)chat.scrollTop=chat.scrollHeight;
  }
  else if(e.type==='error'||e.type==='approval'){append('error',e.text);}
  else if(e.type==='status'){ $('task-state').textContent=e.text;if(['completed','interrupted','failed'].includes(e.text))deltaNode=null;}
  if(e.type!=='delta')$('logs').textContent+=`[${e.type}] ${e.text}\n`;
}if($('logs').textContent.length>100000)$('logs').textContent=$('logs').textContent.slice(-100000);}
function addRequestActions(requestId){
  const row=document.createElement('div'),view=document.createElement('button'),undo=document.createElement('button'),status=document.createElement('span');
  row.className='request-actions';row.dataset.requestId=requestId;
  view.className=undo.className='tool';view.textContent='변경 보기';undo.textContent='이 요청 되돌리기';
  status.className='muted';status.textContent='되돌림 완료';status.hidden=undo.hidden=true;
  view.onclick=()=>run(async()=>{
    requestDiff={id:requestId,...await action('request-diff',{requestId})};
    selectReviewTab($('code-tab'));
  });
  undo.onclick=async()=>{
    if(!await confirmDialog({title:'요청 되돌리기',message:'이 요청의 변경을 작업 사본에서 되돌릴까요?',confirmLabel:'되돌리기'}))return;
    run(async()=>{
      task=await action('revert-request',{requestId,approved:true});
      requestDiff=undefined;renderFiles();
      setInspection(false);resetSelection();
      if(task.previewReady){if(previewFrame().hasAttribute('src'))refreshPreview();else await showReadyPreview();}
      else hidePreview();
      showTaskState();notice('요청을 되돌렸습니다.',true);
      await refreshDiff();lastVersion=task.version;
    });
  };
  row.append(view,undo,status);$('messages').append(row);$('messages').scrollTop=$('messages').scrollHeight;
}
function previewFrame(){return $(interactiveOrigin?'interactive-preview':'preview');}
function previewRefreshLocked(){return inspection||!!selection;}
function protectSelection(event){event.preventDefault();event.returnValue=true;}
function clearFrame(frame){frame.hidden=true;frame.removeAttribute('src');}
function loadPreview(){
  if(!task?.previewReady)return;
  const p=$('preview-path').value;
  if(!p.startsWith('/')||p.startsWith('//')||p.includes('\\'))throw Error('Preview 경로는 /로 시작해야 합니다');
  const frame=previewFrame(),url=(interactiveOrigin||task.previewBase)+p;
  previewInspectorReady=false;
  clearFrame($(interactiveOrigin?'preview':'interactive-preview'));
  frame.src=interactiveOrigin?url:url+(url.includes('?')?'&':'?')+'_ave='+Date.now();
  $('open-preview').href=url;frame.hidden=false;$('empty').hidden=true;$('preview-off').hidden=true;
  $('preview-status').textContent=interactiveOrigin?'Live · 로그인 가능':'Live · 작업 사본';
}
function refreshPreview(){
  if(previewRefreshLocked()&&previewFrame().hasAttribute('src'))return;
  if(interactiveOrigin&&previewInspectorReady)previewFrame().contentWindow.postMessage({type:'ave-refresh'},interactiveOrigin);
  else loadPreview();
}
function hidePreview(){const live=task&&!['applied','discarded'].includes(task.state);clearFrame($('preview'));clearFrame($('interactive-preview'));if(!live){setInspection(false);selectInfo('');}$('open-preview').href='#';$('empty').hidden=!!live;$('preview-off').hidden=!live;$('preview-status').textContent=live?'꺼짐 · 작업 사본 유지':'임시 작업 공간';}
function activateInteractive(url){
  const target=new URL(url);
  if(target.protocol!=='http:'||!/^ave-[a-f0-9]{32}\.localhost$/.test(target.hostname)||!target.port||target.username||target.password)throw Error('로컬 Preview 주소가 올바르지 않습니다');
  interactiveOrigin=target.origin;
}
function restorePreviewPath(){
  interactiveOrigin='';
  const savedPath=sessionStorage.getItem('ave-login-'+task.id);
  $('preview-path').value=task.interactiveOrigin&&savedPath?.startsWith('/')?savedPath:task.previewPath||'/';
}
async function showReadyPreview(){
  if(!task?.previewReady)return;
  if(task.interactiveAvailable&&!interactiveOrigin){
    try{activateInteractive(task.interactiveOrigin||(await action('interactive-preview')).url);}
    catch(error){notice('서버 기능 Preview를 열지 못해 기본 화면을 표시합니다. '+error.message);}
  }
  loadPreview();
}
function showTaskState(){$('task-state').textContent={ready:'작업 준비 완료',editing:'Codex 작업 중',rebuilding:'Preview 재빌드 중',refreshing:'Preview 리소스 갱신 중',review:'검토 대기',applied:'원본 적용 완료',discarded:'폐기 완료'}[task.state]||task.state;}
function selectInfo(info){
  const elements=Array.isArray(info?.elements)?info.elements:[];
  selection=elements.length?JSON.stringify(info,null,2):'';
  $('selection-card').hidden=!elements.length;
  $('selection-total').textContent=elements.length;
  $('selection-summary').replaceChildren(...elements.map((element,index)=>{
    const item=document.createElement('li'),number=document.createElement('span'),label=document.createElement('code');
    number.className='selection-number';number.textContent=index+1;
    label.textContent=element?.selector||element?.tag||'';
    item.append(number,label);return item;
  }));
  buttons();
}
function resetSelection(){
  selectInfo('');
  if(previewFrame().hasAttribute('src'))previewFrame().contentWindow.postMessage({type:'ave-reset-selection'},interactiveOrigin||'*');
}
function showInteractiveSelection(){
  const entry=task.interactiveSelection;
  if(!entry||!interactiveOrigin)return;
  const key=task.id+'/'+entry.id;
  if(key===seenInteractiveSelection)return;
  seenInteractiveSelection=key;
  selectInfo(entry.data);
}
function syncInspector(){previewFrame().contentWindow.postMessage({type:'ave-mode',active:inspection},interactiveOrigin||'*');}
function setInspection(active){inspection=active;$('inspect').setAttribute('aria-pressed',String(inspection));buttons();}
function escapePreview(){
  const previewExpanded=$('workbench').classList.contains('preview-expanded'),diffExpanded=$('review').classList.contains('expanded');
  if(previewExpanded||diffExpanded){
    $('workbench').classList.remove('preview-expanded');$('review').classList.remove('expanded');editor?.layout();
    (diffExpanded?$('expand-diff'):$('maximize')).focus({preventScroll:true});
    return true;
  }
  if(previewRefreshLocked()){resetSelection();return true;}
  return false;
}
for(const id of ['preview','interactive-preview'])$(id).addEventListener('load',e=>{if(e.target===previewFrame()&&e.target.hasAttribute('src')){previewInspectorReady=false;syncInspector();}});
addEventListener('message',e=>{
  if(e.source!==previewFrame().contentWindow||(interactiveOrigin&&e.origin!==interactiveOrigin))return;
  try{
    if(!interactiveOrigin&&e.data?.type==='ave-selection'){const text=JSON.stringify(e.data.selection);if(text?.length<=12000&&e.data.selection?.elements?.length<=12)selectInfo(e.data.selection);}
    if(e.data?.type==='ave-escape')escapePreview();
    if(interactiveOrigin&&e.data?.type==='ave-inspection')setInspection(e.data.active===true);
    if(e.data?.type==='ave-ready'){
      previewInspectorReady=true;
      $('preview-status').textContent=interactiveOrigin?'Live · 로그인 가능':'Live · 선택 기능 연결됨';
      if(interactiveOrigin&&typeof e.data.path==='string'&&/^\/(?!\/)[^?#\\\r\n]*$/.test(e.data.path)){
        $('preview-path').value=e.data.path;
        $('open-preview').href=interactiveOrigin+e.data.path;
        sessionStorage.setItem('ave-login-'+task.id,e.data.path);
      }
    }
  }catch{}
});
$('inspect').onclick=()=>{setInspection(!inspection);syncInspector();};
$('clear-selection').onclick=resetSelection;$('reload').onclick=()=>run(async()=>refreshPreview());$('navigate').onclick=()=>run(async()=>{resetSelection();loadPreview();});
$('preview-path').onkeydown=e=>{if(e.key==='Enter')$('navigate').click();};
$('maximize').onclick=()=>$('workbench').classList.toggle('preview-expanded');$('expand-diff').onclick=()=>{$('review').classList.toggle('expanded');editor?.layout();};
addEventListener('keydown',event=>{
  if(previewRefreshLocked()&&(event.key==='F5'||((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='r'))){
    event.preventDefault();event.stopImmediatePropagation();return;
  }
  if(event.key==='Escape'&&!tabDrag?.moved&&!document.querySelector('dialog[open]')&&escapePreview()){
    event.preventDefault();event.stopImmediatePropagation();
  }
},true);
function previewAction(method,message,previewMessage){return run(async()=>{
  try{await action(method);}finally{
    task=await api(`/api/tasks/${task.id}`);
    if(task.previewReady){if(previewFrame().hasAttribute('src'))refreshPreview();else await showReadyPreview();}else hidePreview();
  }
  notice(message,true);
},previewMessage);}
$('restart').onclick=()=>previewAction('restart','빌드 및 Preview 재시작 완료','Preview를 다시 시작하는 중입니다');
$('preview-power').onclick=()=>task.previewReady?previewAction('stop-preview','Preview를 껐습니다. 작업 사본은 유지됩니다.'):previewAction('start-preview','Preview를 켰습니다.','Preview 서버를 시작하는 중입니다');
$('create').onclick=()=>run(async()=>{
  if(task&&!['applied','discarded'].includes(task.state))throw Error('현재 작업을 적용하거나 폐기한 뒤 새 작업을 시작하세요');
  task=await api('/api/tasks',{projectId:$('project').value});lastReviewedRequestId=task.requests?.at(-1)?.id;restorePreviewPath();seen=0;lastRebuildSeq=0;lastRunning=task.running;lastVersion=-1;deltaNode=null;sessionStorage.setItem('ave-task-'+session.user,task.id);$('messages').replaceChildren();append('assistant','Preview에서 수정할 요소를 선택하거나 원하는 변경을 입력하세요. 기존 코드 구조를 유지하며 작업 사본만 수정합니다.');$('logs').textContent='';setInspection(false);selectInfo('');clearDiff();$('task-id').textContent=task.id.slice(0,8).toUpperCase();events(task.events);showTaskState();if(task.previewReady)await showReadyPreview();else{
    hidePreview();
    const startupError=task.events.find(event=>event.type==='error');
    if(startupError){notice(startupError.text);$('logs-tab').click();}
  }
},'프로젝트를 실행하는 중입니다');
$('chat-form').onsubmit=e=>{
  e.preventDefault();
  const input=$('prompt'),draft=input.value,prompt=draft.trim();
  if($('send').disabled||!prompt)return;
  const model=modelPicker.value||undefined,effort=effortPicker.value||undefined;
  chatSubmitting=true;input.value='';
  run(async()=>{
    try{
      const result=await action('chat',{prompt,selection:selection||$('manual-selection').value||undefined,model,effort});
      if(!result.requestId){append('user',prompt);deltaNode=null;}
      task={...task,running:true,state:'editing'};lastRunning=true;
      showTaskState();
    }catch(error){
      input.value=input.value?draft+'\n\n'+input.value:draft;
      throw error;
    }finally{chatSubmitting=false;}
  });
};
$('prompt').onkeydown=e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();if(!$('send').disabled)$('chat-form').requestSubmit();}};
$('stop').onclick=()=>run(async()=>{await action('stop');notice('Codex에 정지를 요청했습니다. 완료 상태를 기다려주세요.');});
function clearDiff(){diffData={changes:[]};requestDiff=undefined;selected.clear();$('file-count').textContent=$('sql-count').textContent='0';renderFiles();}
async function refreshDiff(){
  const id=task.id,diff=await action('diff');
  if(task?.id!==id||['applied','discarded'].includes(task.state))return;
  diffData=diff;selected=new Set(diffData.changes.map(c=>c.file));
  if(!requestDiff)renderFiles();
  $('file-count').textContent=diffData.changes.length;$('sql-count').textContent=diffData.changes.filter(c=>c.sql).length;
  buttons();
}
$('refresh-diff').onclick=()=>run(refreshDiff);
$('show-all-changes').onclick=()=>{requestDiff=undefined;selectReviewTab($('code-tab'));buttons();$('code-tab').focus();};
function renderFiles(){const list=$('file-list');list.replaceChildren();
 $('request-diff-scope').hidden=$('show-all-changes').hidden=!requestDiff||filter==='logs';
 $('request-diff-headings').hidden=!requestDiff;
 const changes=(requestDiff||diffData).changes.filter(c=>filter!=='sql'||c.sql);
 if(!changes.length){const p=document.createElement('p');p.className='muted';p.textContent='변경된 파일이 없습니다';list.append(p);}
 for(const c of changes){const row=document.createElement('div');row.className='file-row'+(c.file===activeFile?' active':'');const check=document.createElement('input');check.type='checkbox';check.checked=selected.has(c.file);check.hidden=!!requestDiff;check.setAttribute('aria-label',c.file+' 적용 선택');check.onchange=()=>{check.checked?selected.add(c.file):selected.delete(c.file);buttons();};const button=document.createElement('button');button.textContent=c.file;button.title=c.file;button.onclick=()=>{activeFile=c.file;renderFiles();};const kind=document.createElement('span');kind.className='kind';kind.textContent={added:'A',modified:'M',deleted:'D'}[c.kind];const counts=document.createElement('span');counts.className='counts';counts.textContent=`+${c.added} −${c.removed}`;row.append(check,kind,button,counts);list.append(row);}
 if(!changes.find(c=>c.file===activeFile))activeFile=changes[0]?.file||'';showFile(changes.find(c=>c.file===activeFile));
}
function showFile(c){$('diff-title').textContent=c?`${c.file}  ·  ${c.kind}  ·  +${c.added} −${c.removed}`:'파일을 선택하면 변경 전후 코드를 비교할 수 있습니다.';$('risk').hidden=!c?.risks.length;$('risk').textContent=c?.risks.join(' · ')||'';
 if(editor){for(const m of models)m.dispose();models=[];if(c){const ext=c.file.split('.').pop();const lang={js:'javascript',mjs:'javascript',ts:'typescript',tsx:'typescript',jsx:'javascript',sql:'sql',java:'java',json:'json',html:'html',css:'css',xml:'xml'}[ext]||'plaintext';models=[monaco.editor.createModel(c.original,lang),monaco.editor.createModel(c.modified,lang)];editor.setModel({original:models[0],modified:models[1]});}else editor.setModel(null);}else{$('original-code').textContent=c?.original||'';$('modified-code').textContent=c?.modified||'';$('fallback').hidden=!c;$('editor').hidden=!!c;}}
const reviewTablist=$('review-tabs'),reviewPanels=$('review-panels');
const reviewTabs=[...reviewTablist.children];
const reviewPanel=tab=>$(tab.getAttribute('aria-controls'));
const tabAnimations=new Map();
const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
const reviewOrderKey='ave-review-tab-order';
let tabDrag,suppressTabClick=false;

function moveReviewTab(tab,before,animate=false){
  if(tab.nextElementSibling===before)return;
  const positions=animate&&!reducedMotion.matches?new Map(reviewTabs.filter(other=>other!==tab).map(other=>[other,other.getBoundingClientRect().left])):[];
  reviewTablist.insertBefore(tab,before);
  reviewPanels.insertBefore(reviewPanel(tab),before?reviewPanel(before):null);
  for(const [other,oldPosition]of positions){
    tabAnimations.get(other)?.cancel();
    const offset=oldPosition-other.getBoundingClientRect().left;
    if(offset)tabAnimations.set(other,other.animate([{transform:`translateX(${offset}px)`},{transform:'none'}],{duration:170,easing:'ease-out'}));
  }
}
function saveReviewOrder(tab){
  const order=[...reviewTablist.children];
  try{localStorage.setItem(reviewOrderKey,JSON.stringify(order.map(item=>item.id)));}catch{}
  $('review-tab-order').textContent=`${tab.textContent.trim()} 탭을 ${order.indexOf(tab)+1}번째로 옮겼습니다.`;
}
try{
  const order=JSON.parse(localStorage.getItem(reviewOrderKey));
  if(Array.isArray(order)&&order.length===reviewTabs.length&&new Set(order).size===order.length&&order.every(id=>reviewTabs.some(tab=>tab.id===id))){
    for(const id of order)moveReviewTab($(id),null);
  }
}catch{}

function selectReviewTab(tab){
  filter=tab.id.slice(0,-4);
  for(const other of reviewTabs){
    const active=other===tab;
    other.classList.toggle('active',active);other.setAttribute('aria-selected',String(active));other.tabIndex=active?0:-1;
    reviewPanel(other).hidden=!active;
  }
  if(filter!=='logs'){
    const panel=reviewPanel(tab),content=$('diff-content');
    if(content.parentElement!==panel)panel.append(content);
    renderFiles();editor?.layout();
  }else $('request-diff-scope').hidden=$('show-all-changes').hidden=true;
}
for(const tab of reviewTabs)tab.onclick=()=>selectReviewTab(tab);
reviewTablist.addEventListener('click',event=>{
  if(suppressTabClick&&event.detail){event.preventDefault();event.stopImmediatePropagation();}
},true);
reviewTablist.addEventListener('pointerdown',event=>{
  const tab=event.target.closest('[role=tab]');
  if(!tab||!event.isPrimary||event.button!==0||tabDrag)return;
  suppressTabClick=false;
  const rect=tab.getBoundingClientRect();
  tabDrag={tab,pointer:event.pointerId,start:event.clientX,offset:event.clientX-rect.left,order:[...reviewTablist.children],moved:false};
});
addEventListener('pointermove',event=>{
  if(!tabDrag||event.pointerId!==tabDrag.pointer)return;
  const {tab,start,offset}=tabDrag;
  if(!tabDrag.moved){
    if(Math.abs(event.clientX-start)<5)return;
    reviewTablist.setPointerCapture(event.pointerId);
    tabAnimations.get(tab)?.cancel();
    tabDrag.moved=true;suppressTabClick=true;tab.classList.add('dragging');
  }
  const origin=reviewTablist.getBoundingClientRect().left-reviewTablist.scrollLeft;
  const left=event.clientX-offset,center=left+tab.offsetWidth/2;
  const before=[...reviewTablist.children].find(other=>other!==tab&&center<origin+other.offsetLeft+other.offsetWidth/2)||null;
  moveReviewTab(tab,before,true);
  tab.style.setProperty('--drag-x',(left-origin-tab.offsetLeft)+'px');
});
function finishTabDrag(event,cancel=false){
  if(!tabDrag||event.pointerId!==tabDrag.pointer)return;
  const {tab,pointer,order,moved}=tabDrag;
  tabDrag=undefined;
  if(!moved)return;
  if(cancel){for(const item of order)moveReviewTab(item,null);}
  else if(order.some((item,index)=>item!==reviewTablist.children[index]))saveReviewOrder(tab);
  tab.classList.remove('dragging');tab.style.removeProperty('--drag-x');
  if(reviewTablist.hasPointerCapture(pointer))reviewTablist.releasePointerCapture(pointer);
  tab.focus({preventScroll:true});
}
addEventListener('pointerup',event=>finishTabDrag(event));
addEventListener('pointercancel',event=>finishTabDrag(event,true));
reviewTablist.addEventListener('lostpointercapture',event=>finishTabDrag(event,true));
reviewTablist.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&tabDrag?.moved){event.preventDefault();finishTabDrag({pointerId:tabDrag.pointer},true);return;}
  const order=[...reviewTablist.children],index=order.indexOf(event.target);
  const direction={ArrowLeft:-1,ArrowRight:1}[event.key];
  if(index<0||(!direction&&event.key!=='Home'&&event.key!=='End'))return;
  event.preventDefault();
  const tab=order[index];
  if(event.altKey&&direction){
    const neighbor=order[index+direction];
    if(neighbor){moveReviewTab(tab,direction<0?neighbor:neighbor.nextElementSibling,true);saveReviewOrder(tab);tab.focus({preventScroll:true});}
    return;
  }
  const next=event.key==='Home'?order[0]:event.key==='End'?order.at(-1):order[(index+direction+order.length)%order.length];
  selectReviewTab(next);next.focus();
});
$('apply').onclick=async()=>{
  const taskId=task.id, revision=diffData.revision, files=[...selected];
  const unapplied=files.length<diffData.changes.length;
  const message='확정하면 선택한 파일을 원본에 적용하고 작업 사본과 백업을 폐기합니다. 현재 페이지에서는 롤백할 수 없습니다.'
    +(unapplied?' 선택하지 않은 변경도 폐기됩니다.':'');
  if(!await confirmDialog({title:'원본에 확정 적용할까요?',message,details:files.join('\n'),confirmLabel:'확정 적용하기'}))return;
  if(task?.id!==taskId||task.state==='applied'||task.state==='discarded')return;
  run(async()=>{
    const result=await action('apply',{revision,files,approved:true});
    task.state='applied';task.previewReady=false;clearDiff();hidePreview();showTaskState();
    if(result.cleanupFailed)void alertDialog('작업 사본 정리 실패','원본 적용은 완료했지만 일부 작업 파일을 정리하지 못했습니다.');
    else notice('선택한 파일을 원본에 적용하고 작업 사본을 폐기했습니다.',true);
  });
};
$('discard').onclick=async()=>{
  const taskId=task.id;
  if(!await confirmDialog({title:'작업을 폐기할까요?',message:'작업 사본과 적용하지 않은 변경을 삭제합니다.',confirmLabel:'폐기하기'}))return;
  if(task?.id!==taskId||task.state==='applied'||task.state==='discarded')return;
  run(async()=>{
    await action('discard');task.state='discarded';task.previewReady=false;
    clearDiff();hidePreview();showTaskState();notice('작업 사본을 폐기했습니다. 원본은 보존되었습니다.',true);
  });
};
$('guide').onclick=()=>$('guide-dialog').showModal();$('close-guide').onclick=()=>$('guide-dialog').close();
$('project').onchange=()=>{
  const project=projects?.find(project=>project.id===$('project').value);
  $('workspace-project').textContent=project?`${project.id} / ${project.name}`:(projects?.length===0?'등록된 프로젝트가 없습니다':'프로젝트 선택 대기');
  $('framework').textContent=project?.framework||'—';buttons();
};
function renderProjects(){
  const picker=$('project'), previous=picker.value || task?.projectId;
  const empty=projects?.length===0;
  picker.replaceChildren(...(projects?.length
    ? projects.map(project=>new Option(project.name,project.id))
    : [new Option(empty?'등록된 프로젝트가 없습니다':'Agent 연결 대기 중','')]));
  if(projects?.some(project=>project.id===previous))picker.value=previous;
  $('empty-title').textContent=empty?'등록된 프로젝트가 없습니다':'기존 화면을 새롭게.';
  $('empty-description').textContent=empty?'프로젝트 등록 안내에서 작업할 프로젝트를 추가하세요.':'프로젝트를 선택하고 새 작업을 시작하세요.';
  picker.onchange();
}
async function poll(){if(polling||pending||document.hidden)return;polling=true;try{session=await api('/api/session');$('connection').textContent=session.connected?'내 PC Agent 연결됨':'Agent 연결 끊김';$('connection').classList.toggle('online',session.connected);if(session.connected&&projects===null){
   projects=await api('/api/projects');
   renderProjects();
 }else if(!session.connected&&projects!==null){
   projects=null;
   renderProjects();
 }
 if(session.connected)void loadModels();
 if(task&&session.connected){
   const currentTask=task,s=await api(`/api/tasks/${task.id}${seen?'?after='+seen:''}`);
   if(pending||task!==currentTask||task.id!==s.id||(task.state==='discarded'&&s.state!=='discarded'))return;
   if(['applied','discarded'].includes(s.state)&&s.state!==task.state)clearDiff();
   const completed=lastRunning&&!s.running,previewChanged=task.previewReady!==s.previewReady;
   const wasRecovering=previewRecovering;
   const rebuildSeq=s.rebuildSeq??s.events.findLast(e=>e.type==='status'&&e.text==='Preview 재빌드 완료')?.seq??0;
   const rebuildFinished=s.state!=='rebuilding'&&(lastVersion>=0||task.state==='rebuilding')&&rebuildSeq>lastRebuildSeq;
   lastRebuildSeq=Math.max(lastRebuildSeq,rebuildSeq);
   events(s.events);task=s;showInteractiveSelection();lastRunning=s.running;
   const reviewReady=!s.running&&!s.busy&&!['applied','discarded'].includes(s.state);
   const request=s.requests?.at(-1);
   const changedRequest=reviewReady&&request?.id!==lastReviewedRequestId&&request?.changed;
   if(changedRequest&&s.previewReady&&previewRefreshLocked()){
     setInspection(false);resetSelection();syncInspector();
   }
   previewRecovering=s.state==='rebuilding'&&!s.previewReady;
   if(previewRecovering){
     $('preview-loading-text').textContent='Preview 서버를 다시 시작하는 중입니다';$('preview-loading').hidden=false;
   }else{
     if(wasRecovering)$('preview-loading').hidden=true;
     if(previewChanged||wasRecovering||rebuildFinished){
       if(!s.previewReady)hidePreview();
       else if(!previewFrame().hasAttribute('src'))await showReadyPreview();
       else if(interactiveOrigin&&!previewInspectorReady)loadPreview();
       else refreshPreview();
     }
   }
   if(reviewReady&&(changedRequest||completed||s.version!==lastVersion)){
     if((changedRequest||completed||lastVersion>=0)&&s.previewReady&&!previewChanged&&!wasRecovering&&!rebuildFinished)refreshPreview();
     lastReviewedRequestId=request?.id;
     await refreshDiff();lastVersion=s.version;
   }
   showTaskState();
 }
 }catch(e){notice(e.message);}finally{polling=false;buttons();}}
document.addEventListener('visibilitychange',poll);
(async()=>{try{session=await api('/api/session');$('username').textContent=session.user;const id=sessionStorage.getItem('ave-task-'+session.user);if(id){try{task=await api('/api/tasks/'+id);lastReviewedRequestId=task.requests?.at(-1)?.id;restorePreviewPath();$('task-id').textContent=id.slice(0,8).toUpperCase();lastVersion=-1;if(task.previewReady)await showReadyPreview();else hidePreview();}catch{sessionStorage.removeItem('ave-task-'+session.user);task=undefined;}}await poll();setInterval(poll,1200);}catch(e){notice(e.message);}})();
if(window.require){require.config({paths:{vs:'/vs'}});require(['vs/editor/editor.main'],()=>{$('editor').replaceChildren();editor=monaco.editor.createDiffEditor($('editor'),{automaticLayout:true,readOnly:true,originalEditable:false,renderSideBySide:true,minimap:{enabled:false},fontSize:11,scrollBeyondLastLine:false,theme:'vs',renderIndicators:true});applyWorkspaceTheme(themeSelect.value);$('fallback').hidden=true;$('editor').hidden=false;showFile(diffData.changes.find(c=>c.file===activeFile));});}

const workbench=$('workbench'),previewPanel=$('preview-panel'),previewResize=$('preview-resize'),reviewResize=$('review-resize');
const previewCanvas=previewPanel.querySelector('.preview-canvas');
let previewWidth=70,reviewHeight=240;

function dragPanel(handle,prepare){
  let drag,frame;
  handle.addEventListener('pointerdown',event=>{
    if(!event.isPrimary||event.button!==0)return;
    drag={pointer:event.pointerId,...prepare(event)};
    handle.classList.add('dragging');workbench.classList.add('resizing');
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener('pointermove',event=>{
    if(event.pointerId!==drag?.pointer)return;
    drag.recent=event;
    if(frame)return;
    frame=requestAnimationFrame(()=>{frame=undefined;drag.move(drag.recent);});
  });
  for(const type of ['pointerup','pointercancel','lostpointercapture'])handle.addEventListener(type,event=>{
    if(event.pointerId!==drag?.pointer)return;
    if(frame)cancelAnimationFrame(frame);
    frame=undefined;
    if(type==='pointerup'&&drag.recent)drag.move(drag.recent);
    if(type!=='pointerup')drag.cancel();
    drag=undefined;
    handle.classList.remove('dragging');workbench.classList.remove('resizing');
    for(const axis of ['width','height'])workbench.style.removeProperty('--preview-drag-frame-'+axis);
  });
}
function setPreviewWidth(width){
  previewWidth=Math.min(75,Math.max(45,width));
  workbench.style.setProperty('--preview-width',previewWidth+'%');
  previewResize.setAttribute('aria-valuenow',String(Math.round(previewWidth)));
}
dragPanel(previewResize,event=>{
  const start=previewWidth,span=workbench.getBoundingClientRect().width,x=event.clientX;
  workbench.style.setProperty('--preview-drag-frame-width',previewCanvas.getBoundingClientRect().width+'px');
  return {move:next=>setPreviewWidth(start+(next.clientX-x)/span*100),cancel:()=>setPreviewWidth(start)};
});
previewResize.addEventListener('keydown',event=>{
  const width={ArrowLeft:previewWidth-2,ArrowRight:previewWidth+2,Home:45,End:75}[event.key];
  if(width===undefined)return;
  event.preventDefault();setPreviewWidth(width);
});
function setReviewHeight(height,total){
  const max=Math.max(120,total-320);
  reviewHeight=Math.min(max,Math.max(120,Math.round(height)));
  reviewPanels.style.setProperty('--review-height',reviewHeight+'px');
  workbench.style.setProperty('--workbench-min-height','320px');
  workbench.style.setProperty('--workbench-height',(total-reviewHeight)+'px');
  reviewResize.setAttribute('aria-valuemax',String(Math.round(max)));
  reviewResize.setAttribute('aria-valuenow',String(reviewHeight));
}
dragPanel(reviewResize,event=>{
  const start=reviewHeight,total=workbench.getBoundingClientRect().height+start,y=event.clientY;
  workbench.style.setProperty('--preview-drag-frame-height',previewCanvas.getBoundingClientRect().height+'px');
  return {move:next=>setReviewHeight(start+y-next.clientY,total),cancel:()=>setReviewHeight(start,total)};
});
reviewResize.addEventListener('keydown',event=>{
  const total=workbench.getBoundingClientRect().height+reviewHeight;
  const height={ArrowUp:reviewHeight+24,ArrowDown:reviewHeight-24,Home:120,End:total-320}[event.key];
  if(height===undefined)return;
  event.preventDefault();setReviewHeight(height,total);
});
