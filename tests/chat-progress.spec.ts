import { expect, test } from '@playwright/test';

test('chat shows progress, keeps the next draft, and blocks overlapping submissions',async({page})=>{
  let state='ready',acknowledge=()=>{};
  const waiting=new Promise<void>(resolve=>{acknowledge=resolve;});
  const requests:string[]=[];
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/session')return route.fulfill({json:{user:'tester',connected:true,csrf:'fixture',csrfHeader:'X-CSRF-TOKEN'}});
    if(path==='/api/projects')return route.fulfill({json:[{id:'demo',name:'Demo'}]});
    if(path.endsWith('/chat')){
      requests.push(route.request().postDataJSON().prompt);
      if(requests.length===1){await waiting;return route.fulfill({json:{ok:true}});}
      return route.fulfill({status:400,json:{error:'테스트 전송 실패'}});
    }
    if(path.endsWith('/diff'))return route.fulfill({json:{changes:[]}});
    return route.fulfill({json:{id:'fixture',state,version:1,previewReady:false,running:state==='editing',busy:state==='rebuilding',events:[]}});
  });
  await page.goto('/');
  await page.getByRole('button',{name:'새 작업 시작'}).click();
  const input=page.getByLabel('Codex 수정 요청'),send=page.getByRole('button',{name:'수정 요청 보내기'});
  await input.fill('첫 요청');
  await send.click();
  await expect(page.getByRole('progressbar',{name:'Codex에 요청을 보내는 중입니다'})).toBeVisible();
  await input.fill('다음 요청 초안');
  state='editing';acknowledge();
  await expect(page.getByRole('progressbar',{name:/Codex 작업 중/})).toBeVisible();
  await expect(input).toHaveValue('다음 요청 초안');
  await expect(send).toBeDisabled();
  await input.press('Meta+Enter');
  await input.press('Control+Enter');

  state='rebuilding';
  await expect(page.getByRole('progressbar',{name:'Preview 재빌드 중'})).toBeVisible();
  await expect(send).toBeDisabled();
  await input.press('Control+Enter');
  expect(requests).toEqual(['첫 요청']);

  state='review';
  await expect(send).toBeEnabled();
  await expect(page.locator('#chat-progress')).toBeHidden();
  await expect(input).toHaveValue('다음 요청 초안');
  expect(requests).toEqual(['첫 요청']);
  await send.click();
  await expect(page.locator('#notice')).toHaveText('테스트 전송 실패');
  await expect(input).toHaveValue('다음 요청 초안');
  expect(requests).toEqual(['첫 요청','다음 요청 초안']);
});
