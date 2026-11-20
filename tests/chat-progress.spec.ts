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
