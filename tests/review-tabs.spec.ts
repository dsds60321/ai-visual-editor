import { expect, test } from '@playwright/test';

test('review tabs move with their panels and preserve the chosen order',async({page})=>{
  await page.goto('/');
  const tabs=page.getByRole('tablist',{name:'검토 패널'});
  const code=tabs.getByRole('tab',{name:'Code Diff'});
  const logs=tabs.getByRole('tab',{name:'실행 로그'});
  const tabOrder=()=>tabs.getByRole('tab').evaluateAll(elements=>elements.map(element=>element.id));
  const panelOrder=()=>page.locator('#review-panels > [role=tabpanel]').evaluateAll(elements=>elements.map(element=>element.id));

  await tabs.scrollIntoViewIfNeeded();
  const start=(await code.boundingBox())!,end=(await logs.boundingBox())!;
  const y=start.y+start.height/2;
  await page.mouse.move(start.x+start.width/2,y);
  await page.mouse.down();
  await page.mouse.move(end.x+end.width/2+10,y,{steps:12});
  await expect(code).toHaveCSS('opacity','0.64');
  await page.mouse.up();

  expect(await tabOrder()).toEqual(['sql-tab','logs-tab','code-tab']);
  expect(await panelOrder()).toEqual(['sql-panel','logs-panel','code-panel']);
  await expect(page.getByRole('tabpanel',{name:'Code Diff'})).toBeVisible();
  await logs.click();
  await expect(page.getByRole('tabpanel',{name:'실행 로그'})).toBeVisible();
  await logs.press('Alt+ArrowLeft');
  expect(await tabOrder()).toEqual(['logs-tab','sql-tab','code-tab']);
  await expect(page.getByRole('tabpanel',{name:'실행 로그'})).toBeVisible();

  await page.reload();
  expect(await tabOrder()).toEqual(['logs-tab','sql-tab','code-tab']);
  expect(await panelOrder()).toEqual(['logs-panel','sql-panel','code-panel']);
  await tabs.getByRole('tab',{name:'SQL Diff'}).click();
  await expect(page.getByRole('tabpanel',{name:'SQL Diff'}).locator('#diff-content')).toBeVisible();
  const resize=page.getByRole('separator',{name:'Diff 및 실행 로그 패널 높이'});
  let expectedHeight=240;
  for(const [tab,selector,change] of [[logs,'#logs',90],[code,'#diff-content',-45],[tabs.getByRole('tab',{name:'SQL Diff'}),'#diff-content',45]] as const){
    await tab.click();
    const panelHeight=async()=>(await page.locator(selector).boundingBox())!.height;
    await expect.poll(panelHeight).toBeCloseTo(expectedHeight,0);
    await resize.scrollIntoViewIfNeeded();
    const handle=(await resize.boundingBox())!;
    const handleX=handle.x+handle.width/2,handleY=handle.y+handle.height/2;
    await page.mouse.move(handleX,handleY);
    await page.mouse.down();
    await page.mouse.move(handleX,handleY-change,{steps:8});
    await page.mouse.up();
    expectedHeight+=change;
    await expect.poll(panelHeight).toBeCloseTo(expectedHeight,0);
  }
});

test('discard clears both diffs even if an earlier refresh completes afterwards',async({page})=>{
  let discarded=false,version=1,releaseDiff=()=>{},diffDelayed=()=>{};
  const gate=new Promise<void>(resolve=>{releaseDiff=resolve;});
  const delayed=new Promise<void>(resolve=>{diffDelayed=resolve;});
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/session')return route.fulfill({json:{user:'tester',connected:true,csrf:'fixture',csrfHeader:'X-CSRF-TOKEN'}});
    if(path==='/api/projects')return route.fulfill({json:[{id:'demo',name:'Demo'}]});
    if(path.endsWith('/discard')){discarded=true;return route.fulfill({json:{ok:true}});}
    if(path.endsWith('/diff')){
      if(version===2){diffDelayed();await gate;}
      return route.fulfill({json:{revision:'fixture',changes:[{file:'query.sql',sql:true,kind:'modified',original:'SELECT 1;',modified:'SELECT 2;',removed:1,added:1,risks:[]}]}});
    }
    return route.fulfill({json:{id:'fixture',state:discarded?'discarded':'review',version,previewReady:false,running:false,busy:false,events:[]}});
  });
  await page.goto('/');
  await page.getByRole('button',{name:'새 작업 시작'}).click();
  await expect(page.locator('#file-count')).toHaveText('1');
  await expect(page.locator('#sql-count')).toHaveText('1');
  version=2;
  await delayed;
  await page.getByRole('button',{name:'작업 폐기'}).click();
  await page.getByRole('button',{name:'폐기하기',exact:true}).click();
  await expect(page.locator('#task-state')).toHaveText('폐기 완료');
  const refreshed=page.waitForResponse('**/api/tasks/fixture/diff');
  releaseDiff();
  await refreshed;
  await page.waitForResponse('**/api/tasks/fixture');
  await expect(page.locator('#file-count')).toHaveText('0');
  await expect(page.locator('#sql-count')).toHaveText('0');
  await expect(page.locator('#diff-title')).not.toContainText('query.sql');
  await expect(page.locator('#file-list')).toContainText('변경된 파일이 없습니다');
});

test('request diff is read-only and undo refreshes the cumulative diff',async({page})=>{
  const requests=[{id:'first',changed:true,reverted:false},{id:'second',changed:true,reverted:false}];
  const events=[
    {seq:1,type:'user',text:'첫 번째 요청'},
    {seq:2,type:'request-diff',requestId:'first'},
    {seq:3,type:'user',text:'두 번째 요청'},
    {seq:4,type:'request-diff',requestId:'second'}
  ];
  const status=()=>({id:'fixture',state:'review',version:requests[1].reverted?2:1,previewReady:false,running:false,busy:false,events,requests});
  const change=(file:string)=>({file,kind:'modified',original:'before',modified:'after',removed:1,added:1,risks:[]});
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/session')return route.fulfill({json:{user:'tester',connected:true,csrf:'fixture',csrfHeader:'X-CSRF-TOKEN'}});
    if(path==='/api/projects')return route.fulfill({json:[{id:'demo',name:'Demo'}]});
    if(path==='/api/models')return route.fulfill({json:[]});
    if(path.endsWith('/request-diff')){
      expect(route.request().postDataJSON()).toEqual({requestId:'second'});
      return route.fulfill({json:{changes:[change('title.html')]}});
    }
    if(path.endsWith('/revert-request')){
      expect(route.request().postDataJSON()).toEqual({requestId:'second',approved:true});
      requests[1].reverted=true;
      return route.fulfill({json:status()});
    }
    if(path.endsWith('/diff')){
      const changes=[change('fields.html')];
      if(!requests[1].reverted)changes.push(change('title.html'));
      return route.fulfill({json:{revision:'fixture',changes}});
    }
    return route.fulfill({json:status()});
  });
  await page.goto('/');
  await page.getByRole('button',{name:'새 작업 시작'}).click();
  const first=page.locator('[data-request-id="first"]'),second=page.locator('[data-request-id="second"]');
  const apply=page.getByRole('button',{name:'선택 파일 적용하기'});
  await expect(apply).toBeEnabled();
  await expect(first.getByText('이 요청 되돌리기')).toBeHidden();
  await second.getByRole('button',{name:'변경 보기'}).click();
  await expect(page.getByText('요청 전',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'title.html',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'fields.html',exact:true})).toBeHidden();
  await expect(apply).toBeDisabled();
  await page.getByRole('button',{name:'전체 변경 보기'}).click();
  await expect(apply).toBeEnabled();
  await second.getByRole('button',{name:'이 요청 되돌리기'}).click();
  await page.getByRole('button',{name:'되돌리기',exact:true}).click();
  await expect(second.getByText('되돌림 완료')).toBeVisible();
  await expect(page.getByRole('button',{name:'title.html',exact:true})).toBeHidden();
  await expect(page.getByRole('button',{name:'fields.html',exact:true})).toBeVisible();
  await expect(first.getByRole('button',{name:'이 요청 되돌리기'})).toBeEnabled();
});

test('final apply warns about rollback and unselected edits, and Escape cancels',async({page})=>{
  let applied=false,applyCount=0;
  await page.route('**/api/**',route=>{
    const pathname=new URL(route.request().url()).pathname;
    if(pathname==='/api/session')return route.fulfill({json:{user:'tester',connected:true}});
    if(pathname==='/api/projects')return route.fulfill({json:[{id:'demo',name:'Demo'}]});
    if(pathname==='/api/models')return route.fulfill({json:[]});
    if(pathname.endsWith('/diff'))return route.fulfill({json:{revision:'fixture',changes:['first.html','second.html'].map(file=>({
      file,kind:'modified',original:'old',modified:'new',removed:1,added:1,risks:[],sql:false
    }))}});
    if(pathname.endsWith('/apply')){
      applyCount++;applied=true;
      expect(route.request().postDataJSON()).toEqual({revision:'fixture',files:['first.html'],approved:true});
      return route.fulfill({json:{ok:true}});
    }
    return route.fulfill({json:{id:'fixture',state:applied?'applied':'review',version:1,previewReady:false,events:[]}});
  });
  await page.goto('/');
  await page.getByRole('button',{name:'새 작업 시작'}).click();
  await expect(page.locator('#file-count')).toHaveText('2');
  await page.locator('#file-list input[type=checkbox]').nth(1).uncheck();
  const apply=page.getByRole('button',{name:'선택 파일 적용하기'}), dialog=page.getByRole('dialog');
  await apply.click();
  await expect(dialog).toContainText('현재 페이지에서는 롤백할 수 없습니다');
  await expect(dialog).toContainText('선택하지 않은 변경도 폐기됩니다');
  await expect(dialog.getByRole('button',{name:'취소'})).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(applyCount).toBe(0);
  await apply.click();
  await dialog.getByRole('button',{name:'확정 적용하기'}).click();
  await expect(page.locator('#task-state')).toHaveText('원본 적용 완료');
  await expect(page.locator('#file-count')).toHaveText('0');
  expect(applyCount).toBe(1);
});
