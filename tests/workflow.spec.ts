import {test,expect}from'@playwright/test';
import {readFile,writeFile}from'node:fs/promises';
import {createHash}from'node:crypto';
const file='tests/fixtures/express-ejs/views/index.ejs';
const digest=async()=>createHash('sha256').update(await readFile(file)).digest('hex');
let original:string;
test.beforeEach(async()=>{original=await readFile(file,'utf8');});
test.afterEach(async()=>{
 const modified=original.replace('>주문 관리</h1>','>주문 내역</h1>');
 if(modified!==original&&await readFile(file,'utf8')===modified)await writeFile(file,original);
});
async function openWorkspace(page){await page.goto('/');await expect(page.locator('#connection')).toHaveText('내 PC Agent 연결됨',{timeout:20000});}
test('real Express Preview and inspector, optional live Codex, reviewed final apply',async({page})=>{
 test.skip(!!process.env.AVE_RESUME_TASK,'existing live task recovery');const before=await digest();await openWorkspace(page);if(process.env.AVE_START_TASK){await page.evaluate(id=>sessionStorage.setItem('ave-task-developer',id),process.env.AVE_START_TASK);await page.reload();}else{await page.locator('#project').selectOption('express-demo');await page.locator('#create').click();}const frame=page.frameLocator('#interactive-preview');await expect(frame.getByRole('heading',{name:'주문 관리'})).toBeVisible({timeout:120000});await page.locator('#inspect').click();await frame.locator('#order-search').click();await expect(page.locator('#selection-card')).toBeVisible();await expect(page.locator('#selection-summary')).toContainText('form');await expect(page.locator('#selection-summary')).not.toContainText('김민수');
 await page.screenshot({path:'.data/workspace.png',fullPage:true});
 if(process.env.AVE_LIVE_CODEX!=='1'){await page.locator('#discard').click();await page.getByRole('button',{name:'폐기하기',exact:true}).click();return;}
 await page.locator('#prompt').fill('views/index.ejs에서 h1 제목 텍스트만 주문 관리에서 주문 내역으로 변경해 주세요. 파일 내용을 먼저 읽고 h1만 수정하세요. 다른 코드 변경, 테스트 실행, 외부 요청은 하지 마세요.');await page.locator('#send').click();await expect(page.locator('#task-state')).toHaveText('검토 대기',{timeout:180000});await expect(page.locator('#file-count')).toHaveText('1',{timeout:10000});expect(await digest()).toBe(before);await expect(frame.getByRole('heading',{name:'주문 내역'})).toBeVisible({timeout:15000});await expect(page.locator('#file-list')).toContainText('views/index.ejs');await page.locator('#apply').click();await expect(page.getByRole('dialog')).toContainText('현재 페이지에서는 롤백할 수 없습니다');await page.getByRole('button',{name:'확정 적용하기',exact:true}).click();await expect(page.locator('#task-state')).toHaveText('원본 적용 완료',{timeout:20000});expect(await digest()).not.toBe(before);await expect(page.locator('#file-count')).toHaveText('0');
});

test('resume a completed live task, verify Diff and final apply',async({page})=>{
 test.skip(!process.env.AVE_RESUME_TASK,'only for recovering a completed live test');const before=await digest();await openWorkspace(page);await page.evaluate(id=>sessionStorage.setItem('ave-task-developer',id),process.env.AVE_RESUME_TASK);await page.reload();await expect(page.locator('#file-count')).toHaveText('1',{timeout:20000});expect(await digest()).toBe(before);await expect(page.frameLocator('#interactive-preview').getByRole('heading',{name:'주문 내역'})).toBeVisible();await page.screenshot({path:'.data/review.png',fullPage:true});await page.locator('#apply').click();await expect(page.getByRole('dialog')).toContainText('현재 페이지에서는 롤백할 수 없습니다');await page.getByRole('button',{name:'확정 적용하기',exact:true}).click();await expect(page.locator('#task-state')).toHaveText('원본 적용 완료',{timeout:20000});expect(await digest()).not.toBe(before);await expect(page.locator('#file-count')).toHaveText('0');
});
