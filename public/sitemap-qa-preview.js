const out = document.querySelector('#out');
const run = document.querySelector('#run');
const write = s => { out.textContent += '\n' + s; };
run.addEventListener('click', async () => {
  run.disabled = true; out.textContent = '안전 검증 중'; let id; let created = false;
  const password = 'synthetic-only-preview-test';
  const post = async payload => {
    const r = await fetch('/api/stores', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await r.json(); if (!r.ok) throw new Error(`가상 가게 요청 실패 (${r.status}: ${data.code || 'unknown'})`); return data;
  };
  const pageContains = async () => {
    const ix = await fetch('/sitemap-stores.xml', { cache: 'no-store' });
    if (!ix.ok || !/noindex/i.test(ix.headers.get('x-robots-tag') || '')) throw new Error('미리보기 사이트맵 안전 헤더 또는 응답 오류');
    const doc = new DOMParser().parseFromString(await ix.text(), 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('사이트맵 XML 오류');
    const pages = Array.from(doc.querySelectorAll('sitemap > loc')).map(n => n.textContent);
    if (!pages.length || pages.length > 10 || pages.some(p => new URL(p).origin !== location.origin)) throw new Error('미리보기 사이트맵 범위 오류');
    for (const url of pages) {
      const r = await fetch(url, { cache: 'no-store' }); if (!r.ok || !/noindex/i.test(r.headers.get('x-robots-tag') || '')) throw new Error('가게 사이트맵 요청 실패');
      const child = new DOMParser().parseFromString(await r.text(), 'application/xml'); if (child.querySelector('parsererror')) throw new Error('가게 사이트맵 XML 오류');
      if (Array.from(child.querySelectorAll('url > loc')).some(n => n.textContent === `${location.origin}/stores/${id}`)) return true;
    }
    return false;
  };
  try {
    if (!location.hostname.endsWith('.vercel.app')) throw new Error('Vercel 미리보기 주소가 아닙니다');
    const probe = await fetch('/api/stores?view=directory', { cache: 'no-store' });
    if (!probe.ok || !/noindex/i.test(probe.headers.get('x-robots-tag') || '')) throw new Error('운영과 분리된 미리보기임을 확인하지 못했습니다');
    write('통과: 운영과 분리된 미리보기 확인');
    id = crypto.randomUUID().replace(/-/g, '').slice(0, 22);
    const data = { name:'사이트맵 가상 검증 가게', address:'가상시 가상구 검증동 1', headline:'실제 가게가 아닌 테스트', intro:'미리보기에서 생성 후 삭제하는 가상 정보입니다.', sections:[], faqs:[] };
    await post({action:'create', id, password, consent:true, data}); created = true; write('통과: 가상 가게 생성');
    if (!(await pageContains())) throw new Error('가상 가게 주소가 사이트맵에 없습니다'); write('통과: 가게별 사이트맵 자동 추가');
    await post({action:'delete', id, password}); created = false; write('통과: 가상 가게 삭제');
    if (await pageContains()) throw new Error('삭제한 주소가 사이트맵에 남았습니다'); write('통과: 삭제 후 사이트맵 자동 제외');
    write('최종 결과: 전체 통과');
  } catch (e) { write('실패: ' + e.message); }
  finally { if (created) { try { await post({action:'delete', id, password}); write('정리: 가상 가게 삭제 완료'); } catch { write('주의: 가상 가게 정리를 확인하지 못함'); } } run.disabled = false; }
});
