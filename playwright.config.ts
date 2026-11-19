import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./tests',timeout:300000,workers:1,use:{baseURL:'http://127.0.0.1:8080',headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',viewport:{width:1512,height:1100},trace:'retain-on-failure'},reporter:'list'});
