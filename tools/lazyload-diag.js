'use strict';

// Pure-CDP probe (no OS perms needed): scroll the inner <main> in steps and
// watch scrollHeight + content counts to confirm lazy-load / virtualization.

const CDP = require('chrome-remote-interface');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const MEASURE = `(() => {
  let b=null;
  for (const el of document.querySelectorAll('*')) { const cs=getComputedStyle(el);
    if((cs.overflowY==='auto'||cs.overflowY==='scroll')&&el.scrollHeight>el.clientHeight+50&&el.clientHeight>200){ if(!b||el.scrollHeight>b.scrollHeight)b=el; } }
  const sel = ['div.feed-shared-update-v2','[data-id^="urn:li:activity"]','[role="article"]','div.scaffold-finite-scroll__content > div'];
  const counts = {}; for (const s of sel) counts[s] = document.querySelectorAll(s).length;
  return { scrollTop: b?Math.round(b.scrollTop):null, scrollHeight: b?b.scrollHeight:null,
           clientHeight: b?b.clientHeight:null, domNodes: document.querySelectorAll('*').length, counts };
})()`;

async function measure(client){ const { result } = await client.Runtime.evaluate({ expression: MEASURE, returnByValue: true }); return result.value; }
async function scrollBy(client, dy){ await client.Runtime.evaluate({ expression:
  `(() => { let b=null; for (const el of document.querySelectorAll('*')){const cs=getComputedStyle(el); if((cs.overflowY==='auto'||cs.overflowY==='scroll')&&el.scrollHeight>el.clientHeight+50&&el.clientHeight>200){if(!b||el.scrollHeight>b.scrollHeight)b=el;}} if(b)b.scrollBy(0,${dy}); })()` }); }

async function main(){
  const targets = await CDP.List({ port: 9222 });
  console.log('page targets:', targets.filter(t=>t.type==='page').map(t=>t.url));
  const blocked = targets.some(t => /protechts|px-cloud|captcha|challenge|uc=scraping/i.test(t.url));
  console.log('bot-challenge frame present right now:', blocked, '\n');

  const feed = targets.find(t => t.type==='page' && /linkedin\.com\/feed/.test(t.url));
  const client = await CDP({ target: feed, port: 9222 });
  await client.Runtime.enable();

  let m = await measure(client);
  console.log('step  scrollTop  scrollHeight  domNodes  posts(v2/activity/article/finite)');
  const fmt = (m,i) => `${String(i).padStart(2)}    ${String(m.scrollTop).padStart(7)}   ${String(m.scrollHeight).padStart(8)}    ${String(m.domNodes).padStart(6)}   ${Object.values(m.counts).join(' / ')}`;
  console.log(fmt(m,0));

  for (let i=1;i<=8;i++){
    await scrollBy(client, 600);
    await sleep(1200);          // give lazy-load time to fetch+insert
    m = await measure(client);
    console.log(fmt(m,i));
  }

  await client.close(); process.exit(0);
}
main().catch(e=>{ console.error('ERROR:', e.message); process.exit(1); });
