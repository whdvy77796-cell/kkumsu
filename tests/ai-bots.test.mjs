import test from 'node:test';
import assert from 'node:assert/strict';
import { identifyBot, classifyUserAgent, parseCidr, cidrContains, FEED_URLS, LIMITS } from '../lib/ai-bots.mjs';
const NOW = 1800000000000;
const feed = { prefixes: [{ ipv4Prefix: '192.0.2.0/24' }, { ipv6Prefix: '2001:db8:abcd::/48' }] };
const reply = data => new Response(JSON.stringify(data));
function fixture(data = feed) {
  const calls = [];
  const fetcher = async (...args) => { calls.push(args); return reply(data); };
  return { fetcher, calls };
}
const identify = (fetcher, options = {}) => identifyBot({ userAgent: 'GPTBot/1.4', clientIp: '192.0.2.42', now: NOW, fetcher, ...options });

test('all seven identities, purposes, fixed official feeds and fetch safeguards', async () => {
  for (const [bot, provider, purpose, key] of [
    ['OAI-SearchBot','openai','search','search'], ['GPTBot','openai','training','training'],
    ['ChatGPT-User','openai','user','user'], ['Claude-SearchBot','anthropic','search','anthropic'],
    ['ClaudeBot','anthropic','training','anthropic'], ['Claude-User','anthropic','user','anthropic'],
    ['Googlebot','google','search_engine','google']]) {
    const { fetcher, calls } = fixture();
    assert.deepEqual(await identify(fetcher, { userAgent: `Mozilla/5.0 (compatible; ${bot}/2.1; +https://example.test/bot)` }), { bot, provider, purpose, verification: 'verified' });
    assert.equal(calls[0][0], FEED_URLS[key]);
    assert.equal(calls[0][1].redirect, 'error');
    assert.equal(calls[0][1].credentials, 'omit');
    assert.ok(calls[0][1].signal instanceof AbortSignal);
  }
});
test('strict boundaries, malformed/overlong UAs and ambiguous identities', async () => {
  const { fetcher, calls } = fixture();
  for (const userAgent of [undefined,null,1,{},'', 'Mozilla/5.0','Googlebot-Image/1','GooglebotNews',
    'FakeGPTBot/1','GPTBotFake/1','GPTBot.foo','GPTBot_1','x.GPTBot/1','x/GPTBot/1',
    'https://evil.test/GPTBot','GPTBot/not-version','GPTBot/1evil','GPTBot/1.2evil','GPTBot+Fake',
    'GPTBot/1,Fake','GPTBot/1 ChatGPT-User/1','ClaudeBot-Search','GPTBot\n','GPTBot\t','GPTBot\0',
    'GPTBoté',' '.repeat(LIMITS.uaLength)+'GPTBot']) assert.equal(await identify(fetcher,{userAgent}),null,String(userAgent));
  assert.equal(calls.length,0);
  for(const ua of ['GPTBot','(GPTBot)','compatible;GPTBot/1.2;','gptbot/1.2','Googlebot/2.1']) assert.ok(classifyUserAgent(ua));
  assert.ok(classifyUserAgent('GPTBot '+'x'.repeat(LIMITS.uaLength-7)));
});
test('Googlebot nonmember never asserted spoof; invalid numeric IPs never fetched', async () => {
  const a=fixture();
  assert.equal((await identify(a.fetcher,{userAgent:'Googlebot',clientIp:'203.0.113.1'})).verification,'unverified');
  const {fetcher,calls}=fixture();
  for(const clientIp of [undefined,null,1,{},'','localhost','crawl.googlebot.com','https://evil.test',
    '192.0.2.1:80','[2001:db8:abcd::1]','192.0.2.1, 192.0.2.2',' 192.0.2.1','192.0.2.1 ',
    '192.000.2.1','0xc0000201','3221225985','192.2.1','999.1.1.1','fe80::1%eth0',
    '::ffff:192.0.2.1','::ffff:c000:201','2001:db8::192.0.2.1','x'.repeat(10000)])
    assert.equal((await identify(fetcher,{clientIp})).verification,'unverified',String(clientIp));
  for(const now of [NaN,Infinity,-1,'123',null]) assert.equal((await identify(fetcher,{now})).verification,'unverified');
  assert.equal(calls.length,0);
  assert.equal((await identify(null)).verification,'unverified');
  assert.equal(await identifyBot(),null);
});
test('IPv4 CIDR boundaries including /0 /25 /32 and host bits',()=>{
  for(const ip of ['192.0.2.0','192.0.2.255']) assert.ok(cidrContains('192.0.2.0/24',ip));
  for(const ip of ['192.0.1.255','192.0.3.0']) assert.equal(cidrContains('192.0.2.0/24',ip),false);
  assert.ok(cidrContains('0.0.0.0/0','255.255.255.255'));
  assert.ok(cidrContains('192.0.2.1/32','192.0.2.1'));
  assert.equal(cidrContains('192.0.2.1/32','192.0.2.0'),false);
  assert.ok(cidrContains('192.0.2.128/25','192.0.2.255'));
  assert.equal(cidrContains('192.0.2.128/25','192.0.2.127'),false);
  assert.ok(cidrContains('192.0.2.42/24','192.0.2.0'));
});
test('IPv6 CIDR compressed/expanded boundaries /0 /127 /128',async()=>{
  for(const clientIp of ['2001:db8:abcd::','2001:DB8:ABCD:ffff:ffff:ffff:ffff:ffff','2001:0db8:abcd:0000:0000:0000:0000:0001']) {
    assert.ok(cidrContains('2001:db8:abcd::/48',clientIp));
    assert.equal((await identify(fixture().fetcher,{clientIp})).verification,'verified');
  }
  for(const ip of ['2001:db8:abcc:ffff:ffff:ffff:ffff:ffff','2001:db8:abce::','192.0.2.1']) assert.equal(cidrContains('2001:db8:abcd::/48',ip),false);
  assert.ok(cidrContains('::/0','ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'));
  assert.ok(cidrContains('::1/128','0:0:0:0:0:0:0:1'));
  assert.equal(cidrContains('::1/128','::2'),false);
  assert.ok(cidrContains('2001:db8::/127','2001:db8::1'));
  assert.equal(cidrContains('2001:db8::/127','2001:db8::2'),false);
});
test('malformed CIDRs fail safely',()=>{
  for(const cidr of [null,{},12,'','192.0.2.1','host/24','192.0.2.1/33','::1/129','::1/-1','::1/01',
    '::1/1.5','::1/1e2','::1/+1','::1/128/1','::1/128 ','::ffff:c000:201/128','fe80::1%eth0/64','1::2::3/64','x'.repeat(10000)]) {
    assert.equal(parseCidr(cidr),null); assert.equal(cidrContains(cidr,'192.0.2.1'),false);
  }
});
test('malformed or mixed-invalid feeds and HTTP failures fail closed',async()=>{
  for(const data of [null,[],{},{prefixes:[]},{prefixes:{}},{prefixes:[null]},
    {prefixes:[{ipv4Prefix:'0.0.0.0/0'},{ipv4Prefix:'bad'}]}, {prefixes:[{ipv4Prefix:'::/0'}]},
    {prefixes:[{ipv6Prefix:'0.0.0.0/0'}]}, {prefixes:[{ipv4Prefix:'192.0.2.0/24',ipv6Prefix:'::/0'}]},
    {prefixes:[{ipv4Prefix:1}]},{prefixes:[{host:'evil.test'}]}]) assert.equal((await identify(fixture(data).fetcher)).verification,'unverified');
  for(const fetcher of [async()=>{throw Error('private');},async()=>null,async()=>new Response('bad'),
    async()=>new Response(new Uint8Array([255,254])),async()=>new Response('{}',{status:503}),
    async()=>new Response(null,{status:204}),async()=>({status:200,redirected:true}),
    async()=>({status:200,url:'https://evil.test'})]) assert.equal((await identify(fetcher)).verification,'unverified');
});
test('byte caps, lying lengths, UTF-8 size and prefix caps',async()=>{
  for(const fetcher of [fixture({prefixes:Array.from({length:LIMITS.prefixes+1},()=>({ipv4Prefix:'192.0.2.0/24'}))}).fetcher,
    async()=>new Response(JSON.stringify(feed),{headers:{'content-length':String(LIMITS.feedBytes+1)}}),
    async()=>new Response(JSON.stringify(feed),{headers:{'content-length':'NaN'}}),
    async()=>new Response(JSON.stringify({...feed,padding:'x'.repeat(LIMITS.feedBytes)}),{headers:{'content-length':'1'}}),
    async()=>new Response(JSON.stringify({...feed,padding:'한'.repeat(LIMITS.feedBytes/2)})),
    async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(LIMITS.feedBytes));c.enqueue(new Uint8Array(1));c.close();}}))])
    assert.equal((await identify(fetcher)).verification,'unverified');
  assert.equal((await identify(fixture({prefixes:Array.from({length:LIMITS.prefixes},()=>({ipv4Prefix:'192.0.2.0/24'}))}).fetcher)).verification,'verified');
});
test('exact six-hour TTL, failed refresh never uses stale data, retry',async()=>{
  let calls=0; const fetcher=async()=>{calls++;if(calls===2)throw Error('offline');return reply(feed);};
  assert.equal((await identify(fetcher)).verification,'verified');
  assert.equal((await identify(fetcher,{now:NOW+LIMITS.cacheMs-1})).verification,'verified');assert.equal(calls,1);
  assert.equal((await identify(fetcher,{now:NOW+LIMITS.cacheMs})).verification,'unverified');assert.equal(calls,2);
  assert.equal((await identify(fetcher,{now:NOW+LIMITS.cacheMs+1})).verification,'verified');assert.equal(calls,3);
});
test('invalid refresh cannot partially poison or retain cache',async()=>{
  let calls=0;const fetcher=async()=>reply(++calls===1?feed:{prefixes:[{ipv4Prefix:'0.0.0.0/0'},{}]});
  await identify(fetcher);
  assert.equal((await identify(fetcher,{now:NOW+LIMITS.cacheMs})).verification,'unverified');
  assert.equal((await identify(fetcher,{clientIp:'203.0.113.1',now:NOW+LIMITS.cacheMs+1})).verification,'unverified');assert.equal(calls,3);
});
test('inflight deduplication and shared Anthropic cache',async()=>{
  let release,calls=0;const gate=new Promise(r=>{release=r;});const fetcher=async()=>{calls++;await gate;return reply(feed);};
  const jobs=Array.from({length:20},(_,i)=>identify(fetcher,{userAgent:['ClaudeBot','Claude-User','Claude-SearchBot'][i%3]}));
  assert.equal(calls,1);release();assert.ok((await Promise.all(jobs)).every(x=>x.verification==='verified'));assert.equal(calls,1);
});
test('fetcher/feed isolation and no mutable cache exposure',async()=>{
  const first=fixture(),second=fixture({prefixes:[{ipv4Prefix:'203.0.113.0/24'}]});
  const result=await identify(first.fetcher);result.bot='poison';
  assert.equal((await identify(first.fetcher)).bot,'GPTBot');
  assert.equal((await identify(second.fetcher)).verification,'unverified');
  await identify(first.fetcher,{userAgent:'ChatGPT-User'});assert.equal(first.calls.length,2);
  assert.notEqual(first.calls[0][0],first.calls[1][0]);assert.ok(Object.isFrozen(FEED_URLS));assert.ok(Object.isFrozen(parseCidr('::/0')));
});
test('clock rewind refresh and inflight stale result isolation',async()=>{
  const {fetcher,calls}=fixture();await identify(fetcher);await identify(fetcher,{now:NOW-1});assert.equal(calls.length,2);
  let release;const gate=new Promise(r=>{release=r;});const delayed=async()=>{await gate;return reply(feed);};
  const early=identify(delayed),late=identify(delayed,{now:NOW+LIMITS.cacheMs});release();
  assert.equal((await early).verification,'verified');assert.equal((await late).verification,'unverified');
});
test('arbitrary host rejection, no raw UA/IP logged, returned or forwarded',async()=>{
  const {fetcher,calls}=fixture(),logs=[],originals={};
  for(const method of ['log','warn','error','info','debug']) {originals[method]=console[method];console[method]=(...args)=>logs.push(args);}
  try {
    const userAgent='GPTBot/1; +https://evil.test/unique-private-marker';
    const result=await identify(fetcher,{userAgent,feedUrl:'https://evil.test'});
    assert.deepEqual(Object.keys(result).sort(),['bot','provider','purpose','verification']);
    assert.equal(result.verification,'verified');assert.equal(calls[0][0],FEED_URLS.training);assert.equal(calls[0][1].body,undefined);
    for(const secret of ['192.0.2.42',userAgent,'evil.test','unique-private-marker']) assert.equal(JSON.stringify(calls).includes(secret),false);
    assert.equal(await identify(fetcher,{userAgent:'https://evil.test/Googlebot'}),null);assert.equal(calls.length,1);assert.deepEqual(logs,[]);
  } finally {for(const method of Object.keys(originals))console[method]=originals[method];}
});
test('timeout covers noncooperative fetch and stalled body, aborts and clears inflight',async()=>{
  let signal1,signal2,calls=0;
  const stalledFetch=async(_url,options)=>{signal1=options.signal;calls++;if(calls>1)return reply(feed);return new Promise(()=>{});};
  const stalledBody=async(_url,options)=>{signal2=options.signal;return new Response(new ReadableStream({pull(){return new Promise(()=>{});}}));};
  const results=await Promise.all([identify(stalledFetch),identify(stalledBody)]);
  assert.ok(results.every(x=>x.verification==='unverified'));assert.ok(signal1.aborted);assert.ok(signal2.aborted);
  assert.equal((await identify(stalledFetch)).verification,'verified');assert.equal(calls,2);
});
