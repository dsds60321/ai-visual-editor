import { expect, test } from '@playwright/test';

test('chat shows progress, keeps the next draft, and blocks overlapping submissions',async({page})=>{
  let state='ready',acknowledge=()=>{};
  const waiting=new Promise<void>(resolve=>{acknowledge=resolve;});
  const requests:{prompt:string;model?:string;effort?:string}[]=[];
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/session')return route.fulfill({json:{user:'tester',connected:true,csrf:'fixture',csrfHeader:'X-CSRF-TOKEN'}});
    if(path==='/api/projects')return route.fulfill({json:[{id:'demo',name:'Demo'}]});
    if(path==='/api/models')return route.fulfill({json:[
      {id:'model-a',name:'모델 A',isDefault:true,efforts:['low','high']},
      {id:'model-b',name:'모델 B',efforts:['medium']}
    ]});
    if(path.endsWith('/chat')){
      requests.push(route.request().postDataJSON());
      if(requests.length===1){await waiting;return route.fulfill({json:{ok:true}});}
      return route.fulfill({status:400,json:{error:'테스트 전송 실패'}});
    }
    if(path.endsWith('/diff'))return route.fulfill({json:{changes:[]}});
    return route.fulfill({json:{id:'fixture',state,version:1,previewReady:false,running:state==='editing',busy:state==='rebuilding',events:[]}});
  });
  await page.goto('/');
  await page.getByRole('button',{name:'새 작업 시작'}).click();
  const input=page.getByLabel('Codex 수정 요청'),send=page.getByRole('button',{name:'수정 요청 보내기'});
  const picker=page.getByRole('combobox',{name:'AI 모델'});
  const effort=page.getByRole('combobox',{name:'추론 강도'});
  await expect(picker).toHaveValue('');
  await expect(effort.getByRole('option',{name:'Low'})).toBeAttached();
  await picker.selectOption({label:'모델 A'});
  await effort.selectOption('high');
  await input.fill('첫 요청');
  await send.click();
  await expect(page.getByRole('progressbar',{name:'Codex에 요청을 보내는 중입니다'})).toBeVisible();
  await input.fill('다음 요청 초안');
  state='editing';acknowledge();
  await expect(page.getByRole('progressbar',{name:/Codex 작업 중/})).toBeVisible();
  await picker.selectOption({label:'모델 B'});
  await expect(effort).toHaveValue('');
  await expect(effort.getByRole('option',{name:'High'})).toHaveCount(0);
  await effort.selectOption('medium');
  await expect(input).toHaveValue('다음 요청 초안');
  await expect(send).toBeDisabled();
  await input.press('Meta+Enter');
  await input.press('Control+Enter');

  state='rebuilding';
  await expect(page.getByRole('progressbar',{name:'Preview 재빌드 중'})).toBeVisible();
  await expect(send).toBeDisabled();
  await input.press('Control+Enter');
  expect(requests).toEqual([{prompt:'첫 요청',model:'model-a',effort:'high'}]);

  state='review';
  await expect(send).toBeEnabled();
  await expect(page.locator('#chat-progress')).toBeHidden();
  await expect(input).toHaveValue('다음 요청 초안');
  expect(requests).toHaveLength(1);
  await send.click();
  await expect(page.locator('#notice')).toHaveText('테스트 전송 실패');
  await expect(input).toHaveValue('다음 요청 초안');
  expect(requests[1]).toEqual({prompt:'다음 요청 초안',model:'model-b',effort:'medium'});
});

test('streamed chat fragments render before acknowledgement and deduplicate status replay',async({page})=>{
  const replay:{seq:number;type:string;text:string}[]=[];
  let acknowledge=()=>{};
  const waiting=new Promise<void>(resolve=>{acknowledge=resolve;});
  await page.addInitScript(()=>{
    class TestStream extends EventTarget {
      onmessage?: (message:MessageEvent)=>void;
      onopen?: ()=>void;
      constructor(){
        super();
        Object.assign(window,{pushChatEvent:(entry:unknown)=>this.onmessage?.(new MessageEvent('message',{data:JSON.stringify(entry)}))});
        queueMicrotask(()=>this.onopen?.());
      }
      close(){}
    }
    Object.defineProperty(window,'EventSource',{value:TestStream});
  });
  await page.route('**/api/**',async route=>{
    const pathname=new URL(route.request().url()).pathname;
    if(pathname==='/api/session')return route.fulfill({json:{user:'tester',connected:true}});
    if(pathname==='/api/projects')return route.fulfill({json:[{id:'demo',name:'Demo'}]});
    if(pathname==='/api/models')return route.fulfill({json:[]});
    if(pathname.endsWith('/chat')){await waiting;return route.fulfill({json:{requestId:'one'}});}
    if(pathname.endsWith('/diff'))return route.fulfill({json:{changes:[]}});
    return route.fulfill({json:{id:'fixture',state:'ready',version:1,previewReady:false,events:replay}});
  });
  const push=async(entry:{seq:number;type:string;text:string})=>{
    await page.evaluate(entry=>Reflect.get(window,'pushChatEvent')(entry),entry);
  };
  await page.goto('/');
  await page.getByRole('button',{name:'새 작업 시작'}).click();
  await page.getByLabel('Codex 수정 요청').fill('스트리밍 테스트');
  await page.getByRole('button',{name:'수정 요청 보내기'}).click();
  await expect(page.getByRole('progressbar',{name:'Codex에 요청을 보내는 중입니다'})).toBeVisible();
  const first={seq:1,type:'user',text:'스트리밍 테스트'};
  const second={seq:2,type:'delta',text:'즉시 수신'};
  await push(first);await push(second);
  await expect(page.getByText('즉시 수신',{exact:true})).toBeVisible();
  const acknowledged=page.waitForResponse('**/api/tasks/fixture/chat');
  acknowledge();await acknowledged;
  const third={seq:3,type:'delta',text:' · 다음 조각'};
  await push(third);
  await expect(page.getByText('즉시 수신 · 다음 조각',{exact:true})).toBeVisible();
  const missed={seq:4,type:'delta',text:' · 다시 받은 조각'};
  replay.push(first,second,third,missed);
  await push({seq:5,type:'delta',text:' · 다음 연결'});
  await expect(page.getByText('즉시 수신 · 다음 조각 · 다시 받은 조각',{exact:true})).toBeVisible();
  await push({seq:5,type:'delta',text:' · 다음 연결'});
  await expect(page.getByText('즉시 수신 · 다음 조각 · 다시 받은 조각 · 다음 연결',{exact:true})).toHaveCount(1);
});

test('a changed Codex request refreshes a selected Preview without a manual click',async({page})=>{
  let changed=false,submittedSelection:string|undefined;
  await page.route('**/preview/test/**',route=>route.fulfill({contentType:'text/html',body:changed?'<h1>Updated Preview</h1>':'<h1>Original Preview</h1>'}));
  await page.route('**/api/**',async route=>{
    const pathname=new URL(route.request().url()).pathname;
    if(pathname==='/api/session')return route.fulfill({json:{user:'tester',connected:true}});
    if(pathname==='/api/projects')return route.fulfill({json:[{id:'demo',name:'Demo'}]});
    if(pathname==='/api/models')return route.fulfill({json:[]});
    if(pathname.endsWith('/chat')){
      submittedSelection=route.request().postDataJSON().selection;
      changed=true;
      return route.fulfill({json:{requestId:'changed'}});
    }
    if(pathname.endsWith('/diff'))return route.fulfill({json:{revision:'fixture',changes:changed?[{
      file:'index.html',kind:'modified',original:'Original Preview',modified:'Updated Preview',added:1,removed:1,sql:false,risks:[]
    }]:[]}});
    return route.fulfill({json:{id:'fixture',state:changed?'review':'ready',version:changed?2:1,previewReady:true,
      previewBase:'/preview/test',previewPath:'/home',events:[],requests:changed?[{id:'changed',changed:true}]:[]}});
  });
  await page.goto('/');
  await page.getByRole('button',{name:'새 작업 시작'}).click();
  const frame=page.frameLocator('#preview');
  await expect(frame.getByRole('heading',{name:'Original Preview'})).toBeVisible();
  await page.locator('#inspect').click();
  await frame.locator('body').evaluate(()=>parent.postMessage({type:'ave-selection',selection:{elements:[{selector:'h1'}]}},'*'));
  await expect(page.locator('#selection-card')).toBeVisible();
  await expect(page.getByRole('button',{name:'Preview 새로고침'})).toBeDisabled();
  await page.getByLabel('Codex 수정 요청').fill('제목 변경');
  await page.getByRole('button',{name:'수정 요청 보내기'}).click();
  await expect(frame.getByRole('heading',{name:'Updated Preview'})).toBeVisible();
  await expect(page.locator('#selection-card')).toBeHidden();
  await expect(page.locator('#inspect')).toHaveAttribute('aria-pressed','false');
  await expect(page.locator('#file-count')).toHaveText('1');
  expect(submittedSelection).toContain('h1');
});
