(() => {
  const previewBase=document.currentScript?.dataset.previewBase||'';
  const interactive=document.currentScript?.dataset.interactive==='true';
  const hubOrigins=(document.currentScript?.dataset.hubOrigins||'').split(' ');
  let active=false,hover,down,box,picked=[],highlights=[],sending=Promise.resolve();
  let toggle,hubOrigin;
  if(interactive){
    toggle=document.createElement('button');
    toggle.type='button';toggle.textContent='요소 선택';toggle.setAttribute('aria-pressed','false');
    Object.assign(toggle.style,{position:'fixed',right:'16px',bottom:'16px',zIndex:2147483647,padding:'8px 13px',border:'1px solid #146451',borderRadius:'6px',background:'#fff',color:'#146451',font:'600 13px system-ui',cursor:'pointer'});
    document.body.append(toggle);
    toggle.addEventListener('click',()=>{setActive(!active);if(hubOrigin)parent.postMessage({type:'ave-inspection',active},hubOrigin);});
  }
  const overlay=document.createElement('div');overlay.dataset.ave='overlay';Object.assign(overlay.style,{position:'fixed',pointerEvents:'none',border:'2px solid #137c66',background:'#137c6612',zIndex:2147483647,display:'none',boxSizing:'border-box'});document.documentElement.append(overlay);
  function setActive(value){active=value;down=undefined;overlay.style.display='none';updateHighlights();if(toggle){toggle.setAttribute('aria-pressed',String(value));toggle.textContent=value?'선택 취소':'요소 선택';}}
  const selector=el=>{const parts=[];while(el&&el!==document.documentElement&&parts.length<8){const tag=el.tagName.toLowerCase();const siblings=el.parentElement?[...el.parentElement.children].filter(e=>e.tagName===el.tagName):[];parts.unshift(tag+(siblings.length>1?`:nth-of-type(${siblings.indexOf(el)+1})`:''));el=el.parentElement;}return parts.join(' > ');};
  const structure=(el,depth=0)=>({tag:el.tagName.toLowerCase(),selector:selector(el),dataAttributes:[...el.attributes].filter(a=>a.name.startsWith('data-')).map(a=>a.name),children:depth<2?[...el.children].filter(e=>!['SCRIPT','STYLE','INPUT','TEXTAREA'].includes(e.tagName)).slice(0,8).map(e=>structure(e,depth+1)):[]});
  const draw=r=>{Object.assign(overlay.style,{display:'block',left:r.x+'px',top:r.y+'px',width:r.width+'px',height:r.height+'px'});};
  function updateHighlights(){
    picked.forEach((element,index)=>{
      const {x,y,width,height}=element.getBoundingClientRect();
      Object.assign(highlights[index].style,{display:active&&element.isConnected?'block':'none',left:x+'px',top:y+'px',width:width+'px',height:height+'px'});
    });
  }
  function showSelection(elements){
    for(const highlight of highlights)highlight.remove();
    picked=elements;
    highlights=picked.map((_,index)=>{
      const outline=document.createElement('div');outline.setAttribute('aria-hidden','true');
      Object.assign(outline.style,{position:'fixed',pointerEvents:'none',zIndex:2147483646,border:'2px solid #137c66',boxSizing:'border-box'});
      const number=document.createElement('span');number.textContent=String(index+1);
      Object.assign(number.style,{display:'inline-block',minWidth:'18px',padding:'1px 3px',border:'1px solid #137c66',background:'#fff',color:'#146451',textAlign:'center',font:'600 11px system-ui'});
      outline.append(number);document.documentElement.append(outline);return outline;
    });
    updateHighlights();
  }
  function publishSelection(){
    const bounds=picked.map(element=>element.getBoundingClientRect());
    const x=bounds.length?Math.min(...bounds.map(r=>r.left)):0,y=bounds.length?Math.min(...bounds.map(r=>r.top)):0;
    const rect={x,y,width:bounds.length?Math.max(...bounds.map(r=>r.right))-x:0,height:bounds.length?Math.max(...bounds.map(r=>r.bottom))-y:0};
    const selection={path:location.pathname.slice(previewBase.length)||'/',rect,elements:picked.map(element=>structure(element))};
    const encoder=new TextEncoder();
    if(encoder.encode(JSON.stringify(selection)).length>12000)selection.elements=selection.elements.map(({tag,selector,dataAttributes})=>({tag,selector,dataAttributes,children:[]}));
    if(encoder.encode(JSON.stringify(selection)).length>12000)selection.elements=selection.elements.map(element=>({...element,dataAttributes:[]}));
    if(!interactive){parent.postMessage({type:'ave-selection',selection},'*');return;}
    const body=JSON.stringify(selection);
    sending=sending.then(async()=>{
      try{
        const response=await fetch('/__ave/selection',{method:'POST',headers:{'Content-Type':'application/json'},body,credentials:'omit'});
        if(active)toggle.textContent=response.ok?'선택 전송됨 · 취소':'전송 실패 · 취소';
      }catch{if(active)toggle.textContent='전송 실패 · 취소';}
    });
  }
  function clearSelection(){showSelection([]);publishSelection();overlay.style.display='none';down=undefined;}
  addEventListener('scroll',updateHighlights,true);
  addEventListener('resize',updateHighlights);
  addEventListener('message',e=>{
    if(e.source!==parent)return;
    if(interactive){
      if(!hubOrigins.includes(e.origin))return;
      hubOrigin=e.origin;
      if(e.data?.type==='ave-refresh'){if(!active&&!picked.length)location.reload();return;}
    }
    if(e.data?.type==='ave-reset-selection'){clearSelection();return;}
    if(e.data?.type!=='ave-mode')return;
    setActive(!!e.data.active);
    parent.postMessage({type:'ave-ready',path:location.pathname},hubOrigin||'*');
  });
  addEventListener('mousemove',e=>{if(!active||e.target===toggle)return;hover=e.target;if(down){box={x:Math.min(down.x,e.clientX),y:Math.min(down.y,e.clientY),width:Math.abs(e.clientX-down.x),height:Math.abs(e.clientY-down.y)};draw(box);}else if(hover instanceof Element)draw(hover.getBoundingClientRect());},true);
  addEventListener('mousedown',e=>{if(active&&e.button===0&&e.target!==toggle){e.preventDefault();e.stopImmediatePropagation();down={x:e.clientX,y:e.clientY};box=undefined;}},true);
  addEventListener('mouseup',e=>{
    if(!active||!down||e.button!==0||e.target===toggle)return;
    e.preventDefault();e.stopImmediatePropagation();const el=e.target;if(!(el instanceof Element))return;
    const region=box&&box.width>8&&box.height>8?box:null;const r=region||el.getBoundingClientRect();
    const elements=region?[...document.querySelectorAll('body *')].filter(n=>{const b=n.getBoundingClientRect();return n!==toggle&&b.width&&b.height&&b.left>=r.x&&b.top>=r.y&&b.right<=r.x+r.width&&b.bottom<=r.y+r.height;}).slice(0,12):[el];
    down=undefined;
    const additive=e.altKey||e.metaKey;
    const next=additive&&!region&&picked.includes(el)?picked.filter(element=>element!==el):[...new Set([...(additive?picked:[]),...elements])].filter(element=>element.isConnected).slice(0,12);
    showSelection(next);publishSelection();
  },true);
  addEventListener('click',e=>{if(active&&e.target!==toggle){e.preventDefault();e.stopImmediatePropagation();}},true);
  addEventListener('keydown',e=>{
    if((active||picked.length)&&(e.key==='F5'||((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='r'))){e.preventDefault();e.stopImmediatePropagation();}
    if(e.key==='Escape'){
      if(parent!==window&&(!interactive||hubOrigin))parent.postMessage({type:'ave-escape'},hubOrigin||'*');
      else clearSelection();
    }
  },true);
  if(!interactive)parent.postMessage({type:'ave-ready'},'*');
})();
