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
