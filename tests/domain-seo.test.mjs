import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
test('home metadata, robots and sitemap point to the verified new canonical host',async()=>{
 const [home,robots,sitemap]=await Promise.all(['public/index.html','site/robots.txt','site/sitemap.xml'].map(read));
 assert.ok(home.includes('<link rel="canonical" href="https://www.lookhereai.com/">'));
 assert.ok(home.includes('<meta property="og:url" content="https://www.lookhereai.com/">'));
 assert.match(robots,/Sitemap: https:\/\/www\.lookhereai\.com\/sitemap\.xml/);
 assert.ok(sitemap.includes('<loc>https://www.lookhereai.com/</loc>'));
 assert.ok(sitemap.includes('<loc>https://www.lookhereai.com/stores</loc>'));
 assert.ok(!sitemap.includes('www.kkumsu.com'));
});

test('home browser and newly saved bookmark title uses the requested wording',async()=>{
 const home=await read('public/index.html');
 assert.ok(home.includes('<title>여기봐 AI · AI가 우리 가게를 학습하는 곳</title>'));
 assert.ok(!home.includes('<title>여기봐 AI · 우리 가게 정보 확인</title>'));
});
