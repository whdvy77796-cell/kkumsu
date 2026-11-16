// Structured data is generated only from the same owner-confirmed, visible public content.
const days = { 월:'Monday', 화:'Tuesday', 수:'Wednesday', 목:'Thursday', 금:'Friday', 토:'Saturday', 일:'Sunday' };
const dayOrder = ['월','화','수','목','금','토','일'];
function basicDetails(sections) {
  const section = Array.isArray(sections) ? sections.find(x => x?.heading === '가게 이용 정보' && typeof x.body === 'string') : null;
  if (!section) return {};
  const text = section.body, phone = text.match(/(?:^|\n)전화번호:\s*([^\n]+)/)?.[1]?.trim(), hours = text.match(/(?:^|\n)영업시간:\s*([^\n]+)/)?.[1]?.trim();
  const menu = text.match(/(?:^|\n)메뉴·가격:\s*\n([\s\S]*)$/)?.[1]?.trim();
  return { phone, hours, menu };
}
function openingHours(value) {
  if (!value) return null;
  const m = value.match(/^(매일|[월화수목금토일](?:\s*[,·]\s*[월화수목금토일])*|[월화수목금토일]\s*[-~–]\s*[월화수목금토일])\s+(\d{2}:\d{2})\s*[-~–]\s*(\d{2}:\d{2})$/);
  if (!m) return null;
  const valid = t => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t);
  if (!valid(m[2]) || !valid(m[3]) || m[2] >= m[3]) return null;
  let selected;
  if (m[1] === '매일') selected = dayOrder;
  else if (/[-~–]/.test(m[1])) { const chars = m[1].replace(/\s/g,'').split(/[-~–]/); const a = dayOrder.indexOf(chars[0]), b = dayOrder.indexOf(chars[1]); if (a < 0 || b < a) return null; selected = dayOrder.slice(a,b+1); }
  else selected = m[1].split(/[,·]/).map(x => x.trim());
  if (new Set(selected).size !== selected.length) return null;
  return { '@type':'OpeningHoursSpecification', dayOfWeek:selected.map(x => days[x]), opens:m[2], closes:m[3] };
}
function menuItems(menu) {
  if (!menu) return [];
  return menu.split(/\r?\n/).slice(0,8).map(line => {
    const m = line.trim().match(/^([^:：\n]{1,80})\s*[:：]\s*([0-9][0-9,]{0,11})\s*원$/);
    if (!m) return null; const n = Number(m[2].replace(/,/g,''));
    if (!Number.isSafeInteger(n) || n < 0 || n > 100000000) return null;
    return { '@type':'MenuItem', name:m[1].trim(), offers:{ '@type':'Offer', price:n, priceCurrency:'KRW' } };
  }).filter(Boolean);
}
export function storeStructuredData(scope, id, data) {
  const detail = basicDetails(data.sections);
  const business = { '@type':'LocalBusiness', name:data.name, address:{ '@type':'PostalAddress', streetAddress:data.address } };
  if (scope.production) { business.url = 'https://www.lookhereai.com/stores/' + id; business['@id'] = business.url + '#business'; }
  if (typeof detail.phone === 'string' && /^[+0-9()\-\s]{7,30}$/.test(detail.phone) && detail.phone.replace(/\D/g,'').length >= 7) business.telephone = detail.phone;
  const hours = openingHours(detail.hours); if (hours) business.openingHoursSpecification = hours;
  const items = menuItems(detail.menu); if (items.length) business.hasMenu = { '@type':'Menu', hasMenuSection:{ '@type':'MenuSection', hasMenuItem:items } };
  const graph = [business];
  if (Array.isArray(data.faqs) && data.faqs.length) graph.push({ '@type':'FAQPage', mainEntity:data.faqs.filter(x => x && typeof x.question==='string' && typeof x.answer==='string' && x.question && x.answer).map(x => ({ '@type':'Question', name:x.question, acceptedAnswer:{ '@type':'Answer', text:x.answer } })) });
  return { '@context':'https://schema.org', '@graph':graph };
}
export function safeJsonLd(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, c => ({'<':'\\u003c','>':'\\u003e','&':'\\u0026','\u2028':'\\u2028','\u2029':'\\u2029'}[c]));
}
