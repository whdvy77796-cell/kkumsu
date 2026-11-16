// Values are unverified search suggestions until the owner checks them before publication.
export const BUSINESS_SECTION = '가게 이용 정보';
const str = x => typeof x === 'string' ? x.trim() : '';
export function initialBusinessDetails(candidate = {}) {
  const rows = Array.isArray(candidate.menu) ? candidate.menu.slice(0, 8) : [];
  return { phone: str(candidate.phone).slice(0, 30), hours: str(candidate.hours).slice(0, 200), menu: rows.filter(x => str(x?.name)).map(x => str(x.name) + (str(x.price) ? ': ' + str(x.price) : '')).join('\n').slice(0, 1500) };
}
export function businessSection(input = {}) {
  const phone = str(input.phone), hours = str(input.hours), menu = str(input.menu);
  if (!phone && !hours && !menu) return null;
  const lines = [];
  if (phone) lines.push('전화번호: ' + phone);
  if (hours) lines.push('영업시간: ' + hours);
  if (menu) lines.push('메뉴·가격:\n' + menu);
  return { heading: BUSINESS_SECTION, body: lines.join('\n') };
}
