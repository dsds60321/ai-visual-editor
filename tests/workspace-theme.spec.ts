import { expect, test } from '@playwright/test';

test('workspace shows the selected project and remembers its visual theme',async({page})=>{
  await page.route('**/api/session',route=>route.fulfill({json:{user:'tester',connected:true}}));
  await page.route('**/api/projects',route=>route.fulfill({json:[{id:'first',name:'첫 프로젝트'},{id:'tb-admin',name:'관리자사이트'}]}));
  await page.goto('/');
  await expect(page.locator('#workspace-project')).toHaveText('first / 첫 프로젝트');
  await page.getByLabel('프로젝트',{exact:true}).selectOption('tb-admin');
  await expect(page.locator('#workspace-project')).toHaveText('tb-admin / 관리자사이트');
  for(const icon of ['.folder-icon','.actionbar .shield']){
    expect(await page.locator(icon).evaluate(element=>(element as SVGGraphicsElement).getBBox().width)).toBeGreaterThan(0);
  }

  const theme=page.getByRole('combobox',{name:'테마',exact:true}),root=page.locator('html');
  await expect(theme).toHaveValue('mono');
  await expect(root).toHaveCSS('background-color','rgb(241, 241, 241)');
  await theme.selectOption('blue');
  await expect(root).toHaveCSS('background-color','rgb(232, 243, 255)');
  await expect(root).toHaveCSS('color','rgb(25, 31, 40)');
  await expect(page.locator('header')).toHaveCSS('background-color','rgb(255, 255, 255)');
  await expect(page.locator('.preview-canvas')).toHaveCSS('background-color','rgb(242, 248, 255)');
  await page.reload();
  await expect(theme).toHaveValue('blue');
  await theme.selectOption('mono');
  await expect(root).toHaveCSS('background-color','rgb(241, 241, 241)');
  await theme.selectOption({label:'그린'});
  await expect(root).toHaveCSS('background-color','rgb(245, 246, 242)');
});

test('workspace distinguishes an empty project list from a disconnected Agent',async({page})=>{
  let connected=true;
  let projects:{id:string;name:string}[]=[];
  await page.route('**/api/session',route=>route.fulfill({json:{user:'tester',connected}}));
  await page.route('**/api/projects',route=>route.fulfill({json:projects}));
  await page.route('**/api/models',route=>route.fulfill({json:[]}));
  await page.goto('/');
  const picker=page.getByLabel('프로젝트',{exact:true});
  await expect(picker.locator('option')).toHaveText('등록된 프로젝트가 없습니다');
  await expect(picker).toBeDisabled();
  await expect(page.getByRole('heading',{name:'등록된 프로젝트가 없습니다'})).toBeVisible();
  await expect(page.getByRole('button',{name:'새 작업 시작'})).toBeDisabled();

  connected=false;
  await expect(picker.locator('option')).toHaveText('Agent 연결 대기 중');
  projects=[{id:'tb-admin',name:'관리자사이트'}];
  connected=true;
  await expect(picker).toHaveValue('tb-admin');
  await expect(page.getByRole('button',{name:'새 작업 시작'})).toBeEnabled();
});
