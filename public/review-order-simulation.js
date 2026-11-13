// 미리보기 전용 가상 실습. 모든 상태는 이 탭의 메모리에만 보관합니다.
// 토스 승인 API, 실제 주문 API, 가게 API 또는 저장소를 호출하지 않습니다.
const MS_PER_DAY = 86400000;
const TEST_KEY = /^test_ck_[A-Za-z0-9_-]{10,100}$/;
export const TEST_PRICE_KRW = 3900;

export function parseDay(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!m) throw new Error('날짜를 YYYY-MM-DD 형식으로 입력해 주세요.');
  const year = Number(m[1]), month = Number(m[2]), date = Number(m[3]);
  if (year < 2000 || year > 2098) throw new Error('2000년부터 2098년까지의 날짜만 사용할 수 있어요.');
  const ms = Date.UTC(year, month - 1, date);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) throw new Error('실제 존재하는 날짜를 입력해 주세요.');
  return Math.floor(ms / MS_PER_DAY);
}
export function formatDay(day) {
  if (!Number.isInteger(day)) throw new Error('날짜가 올바르지 않습니다.');
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}
export function addOneCalendarYear(day) {
  const d = new Date(day * MS_PER_DAY);
  const year = d.getUTCFullYear() + 1, month = d.getUTCMonth(), date = d.getUTCDate();
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Math.floor(Date.UTC(year, month, Math.min(date, last)) / MS_PER_DAY);
}
export function createMockOrder(day, id) {
  if (!Number.isInteger(day) || !/^SIM-[A-Za-z0-9-]{1,50}$/.test(String(id))) throw new Error('가상 주문 값이 올바르지 않습니다.');
  return Object.freeze({ label: '가상 실습', phase: 'created', amount: TEST_PRICE_KRW, createdDay: day, id: String(id) });
}
export function mockPayment(order, day) {
  if (!order || order.label !== '가상 실습' || order.phase !== 'created' || !Number.isInteger(day) || day < order.createdDay) throw new Error('가상 주문을 먼저 만들어 주세요.');
  return Object.freeze({ ...order, phase: 'mock-paid', mockPaidDay: day });
}
export function mockPublish(order, day) {
  if (!order || order.label !== '가상 실습' || order.phase !== 'mock-paid' || !Number.isInteger(day) || day < order.mockPaidDay) throw new Error('가상 결제를 먼저 가정해 주세요.');
  return Object.freeze({ ...order, phase: 'mock-published', mockPublishedDay: day, expiresExclusiveDay: addOneCalendarYear(day) });
}
export function refundExample(order, requestDay) {
  if (!order || order.label !== '가상 실습' || order.phase !== 'mock-published' || !Number.isInteger(requestDay)) throw new Error('가상 게시를 먼저 가정해 주세요.');
  const base = Math.max(order.mockPaidDay, order.mockPublishedDay);
  if (requestDay < base) throw new Error('가상 결제와 공개보다 빠른 요청일은 입력할 수 없어요.');
  const totalDays = order.expiresExclusiveDay - order.mockPublishedDay;
  const remainingDays = Math.max(0, Math.min(totalDays, order.expiresExclusiveDay - (requestDay + 1)));
  const full = requestDay - base <= 7;
  const refund = full ? TEST_PRICE_KRW : Math.ceil(TEST_PRICE_KRW * remainingDays / totalDays);
  return Object.freeze({ full, refund, totalDays, remainingDays });
}
export async function isPreviewReady(fetchFn, loc) {
  if (!loc || !(loc.protocol === 'https:' || (loc.protocol === 'http:' && (loc.hostname === 'localhost' || loc.hostname === '127.0.0.1')))) return false;
  if (typeof fetchFn !== 'function') return false;
  try {
    const r = await fetchFn('/api/review-checkout-config', { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!r || !r.ok) return false;
    const x = await r.json();
    return !!x && x.configured === true && typeof x.clientKey === 'string' && TEST_KEY.test(x.clientKey);
  } catch { return false; }
}
function todayInSeoul() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return get('year') + '-' + get('month') + '-' + get('day');
}
async function init() {
  const doc = document, $ = (id) => doc.getElementById(id);
  const status = $('sim-status'), orderBtn = $('sim-order'), payBtn = $('sim-pay'), pubBtn = $('sim-publish'), resetBtn = $('sim-reset');
  const ready = await isPreviewReady(typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null, location);
  if (!ready) { status.textContent = '검토용 미리보기에서만 사용할 수 있습니다. 실제 결제는 꺼져 있어요.'; return; }
  status.textContent = '검토용 미리보기입니다. 토스 결제나 실제 가게 공개와 연결되지 않아요.';
  let state = null;
  const progress = $('sim-progress');
  const reset = () => { state = null; orderBtn.disabled = false; payBtn.disabled = true; pubBtn.disabled = true; resetBtn.disabled = false; $('sim-result').hidden = true; $('sim-refund-result').textContent = ''; progress.textContent = '가상 주문을 먼저 만들어 주세요.'; };
  reset();
  orderBtn.addEventListener('click', () => {
    try { state = createMockOrder(parseDay(todayInSeoul()), 'SIM-' + Date.now()); orderBtn.disabled = true; payBtn.disabled = false; progress.textContent = '가상 주문만 만들었습니다. 실제 주문은 접수되지 않았어요.'; }
    catch (e) { progress.textContent = e.message; }
  });
  payBtn.addEventListener('click', () => {
    try { state = mockPayment(state, parseDay(todayInSeoul())); payBtn.disabled = true; pubBtn.disabled = false; progress.textContent = '가상 결제를 가정했습니다. 토스 결제·승인과는 무관하며 청구가 없어요.'; }
    catch (e) { progress.textContent = e.message; }
  });
  pubBtn.addEventListener('click', () => {
    try {
      state = mockPublish(state, parseDay(todayInSeoul())); pubBtn.disabled = true;
      $('sim-order-id').textContent = state.id;
      $('sim-start').textContent = formatDay(state.mockPublishedDay);
      $('sim-end').textContent = formatDay(state.expiresExclusiveDay) + ' 직전까지';
      $('sim-refund-date').value = formatDay(state.mockPublishedDay);
      $('sim-result').hidden = false;
      progress.textContent = '가상 게시 예시만 표시했습니다. 실제 가게나 공개 URL은 만들지 않았어요.';
    } catch (e) { progress.textContent = e.message; }
  });
  $('sim-refund').addEventListener('click', () => {
    try {
      const result = refundExample(state, parseDay($('sim-refund-date').value));
      $('sim-refund-result').textContent = (result.full ? '7일 이내 가상 전액 환불: ' : '7일 이후 가상 환불 예시: ') + result.refund.toLocaleString('ko-KR') + '원' + (result.full ? '' : ' (전체 ' + result.totalDays + '일 중 잔여 ' + result.remainingDays + '일)') + '. 실제 환불은 처리하지 않았어요.';
    } catch (e) { $('sim-refund-result').textContent = e.message; }
  });
  resetBtn.addEventListener('click', reset);
}
if (typeof document !== 'undefined' && typeof location !== 'undefined' && document.getElementById('sim-root')) init();
