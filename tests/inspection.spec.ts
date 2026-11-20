import { expect, test } from '@playwright/test';

for(const interactive of [false,true]){
  test(`${interactive?'authenticated':'basic'} Preview keeps multiple selections and exits fullscreen with Escape`,async({page})=>{
    if(!interactive)await page.route(/\/api\/tasks(?:\/[^/]+)?$/,async route=>{
      const response=await route.fetch();
      await route.fulfill(response.ok()?{response,json:{...await response.json(),interactiveAvailable:false}}:{response});
    });
    await page.goto('/');
    await expect(page.locator('#connection')).toHaveText('내 PC Agent 연결됨');
    await page.locator('#project').selectOption('express-demo');
    await page.locator('#create').click();
    await expect(page.locator('#inspect')).toBeEnabled({timeout:120000});
    const frame=page.frameLocator(interactive?'#interactive-preview':'#preview');
    const heading=frame.getByRole('heading',{name:'주문 관리'});
    const keyInput=frame.getByRole('textbox',{name:'주문 검색'});
    await expect(heading).toBeVisible();
    if(interactive){
      const separator=page.getByRole('separator',{name:'Preview 패널 너비'});
      const viewport=page.locator('#interactive-preview');
      const viewportWidth=async()=>(await viewport.boundingBox())!.width;
      const startWidth=await viewportWidth();
      await heading.evaluate(element=>{element.setAttribute('data-resize-check','same document');});
      const box=(await separator.boundingBox())!;
      await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
      await page.mouse.down();
      await page.mouse.move(box.x+box.width/2-160,box.y+box.height/2,{steps:9});
      await expect.poll(async()=>Number(await separator.getAttribute('aria-valuenow'))).toBeLessThan(70);
      expect(await viewportWidth()).toBeCloseTo(startWidth,0);
      await page.mouse.up();
      await expect.poll(viewportWidth).toBeLessThan(startWidth-120);
      await expect(heading).toHaveAttribute('data-resize-check','same document');
      await separator.press('End');
      await expect(separator).toHaveAttribute('aria-valuenow','75');
    }
    await page.locator('#inspect').click();

    const form=frame.locator('#order-search');
    await form.dispatchEvent('mousedown',{button:0});
    await form.dispatchEvent('mouseup',{button:0});
    await keyInput.click({modifiers:['Alt']});
    await heading.click({modifiers:['Meta']});
    await expect(page.locator('#selection-total')).toHaveText('3');
    await expect(page.locator('#selection-summary .selection-number')).toHaveText(['1','2','3']);
    await expect(page.locator('#selection-total')).toHaveCSS('background-color','rgb(255, 255, 255)');
    await expect(page.locator('#selection-summary')).toContainText('form > input');

    await heading.click({modifiers:['Meta']});
    await expect(page.locator('#selection-total')).toHaveText('2');
    await expect(page.getByRole('button',{name:'Preview 새로고침'})).toBeDisabled();
    const refreshBlocked=await page.evaluate(()=>!window.dispatchEvent(new KeyboardEvent('keydown',{key:'r',metaKey:true,cancelable:true})));
    expect(refreshBlocked).toBe(true);

    await page.getByRole('button',{name:'Preview 최대화'}).click();
    await keyInput.press('Escape');
    await expect(page.locator('#workbench')).not.toHaveClass(/preview-expanded/);
    await expect(page.locator('#selection-total')).toHaveText('2');
    await page.getByRole('button',{name:'Diff 전체 화면'}).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('#review')).not.toHaveClass(/\bexpanded\b/);

    await page.locator('#inspect').click();
    await expect(page.getByRole('button',{name:'Preview 새로고침'})).toBeDisabled();
    await page.getByRole('button',{name:'선택 해제'}).click();
    await expect(page.locator('#selection-card')).toBeHidden();
    await expect(page.getByRole('button',{name:'Preview 새로고침'})).toBeEnabled();
    await page.locator('#discard').click();await page.getByRole('button',{name:'폐기하기',exact:true}).click();
    await expect(page.locator('#task-state')).toHaveText('폐기 완료');
  });
}
