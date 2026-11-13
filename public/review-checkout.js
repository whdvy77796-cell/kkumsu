// 테스트 전용 결제창 검토 화면. 직접 URL로만 접근합니다(사이트 어디에도 링크하지 않음).
// 서버 요청은 같은 출처의 읽기 전용 설정 API(GET) 한 가지뿐입니다. 주문 생성/승인 API 호출은 없습니다.
// 시크릿 키와 라이브 키는 사용하지 않습니다.

export const PRODUCT_NAME = '우리 가게 공개하기';
export const ORDER_NAME = '우리 가게 공개하기 (테스트 전용)';
export const PRICE_KRW = 3900;
export const ORDER_ID_PREFIX = 'review-test-';

// 키는 코드에 넣지 않고, 같은 출처의 읽기 전용 설정 API 에서만 받습니다.
export const CONFIG_ENDPOINT = '/api/review-checkout-config';
export const NOT_READY_MESSAGE = '토스 테스트 키를 연결하면 심사용 테스트창을 사용할 수 있어요. 실제 결제는 꺼져 있어요.';

// 결제창(구버전) payment() 는 test_ck_ 키만 허용.
// test_gck_(결제위젯용), live_*, 시크릿 키(*_sk_, *_gsk_)는 모두 거부합니다.
const TEST_CK = /^test_ck_[A-Za-z0-9_-]{10,100}(?![\s\S])/;

export function isTestClientKey(key) {
  return typeof key === 'string' && TEST_CK.test(key);
}

// 설정 응답에서 안전한 test_ck_ 키만 꺼냅니다. 그 외는 null (fail-closed).
export function keyFromConfig(data) {
  if (!data || typeof data !== 'object' || data.configured !== true) return null;
  return isTestClientKey(data.clientKey) ? data.clientKey : null;
}

// 같은 출처 GET 한 번. 실패/비정상 응답은 모두 null.
export async function loadClientKey(fetchFn) {
  try {
    const res = await fetchFn(CONFIG_ENDPOINT, { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!res || !res.ok) return null;
    return keyFromConfig(await res.json());
  } catch { return null; }
}

export function isAllowedOrigin(loc) {
  if (!loc) return false;
  if (loc.protocol === 'https:') return true;
  return loc.protocol === 'http:' && (loc.hostname === 'localhost' || loc.hostname === '127.0.0.1');
}

export function makeOrderId(cryptoObj) {
  const c = cryptoObj || globalThis.crypto;
  let rand;
  if (c && typeof c.randomUUID === 'function') rand = c.randomUUID();
  else if (c && typeof c.getRandomValues === 'function') {
    rand = Array.from(c.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  } else throw new Error('secure random unavailable');
  return ORDER_ID_PREFIX + rand; // 영문/숫자/-/_ , 6~64자
}

export function buildPaymentRequest(origin, orderId) {
  const page = String(origin).replace(/\/+$/, '') + '/review-checkout.html';
  return {
    method: 'CARD',
    amount: { currency: 'KRW', value: PRICE_KRW },
    orderId,
    orderName: ORDER_NAME,
    windowTarget: 'self',
    card: { useEscrow: false, flowMode: 'DEFAULT', useCardPoint: false, useAppCardOnly: false },
    successUrl: page + '?r=success',
    failUrl: page + '?r=fail',
  };
}

function clip(s, n) { return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n); }

// URL 파라미터 해석. paymentKey 는 읽지도 표시하지도 않으며, "승인됨"이라고 말하지 않습니다.
export function parseResult(search) {
  const p = new URLSearchParams(search || '');
  const r = p.get('r');
  if (r === 'success') {
    const amount = clip(p.get('amount'), 20);
    const orderId = clip(p.get('orderId'), 64);
    const amountOk = amount === String(PRICE_KRW);
    const orderOk = orderId.startsWith(ORDER_ID_PREFIX) && /^[A-Za-z0-9_=-]{6,64}$/.test(orderId);
    return { kind: 'success', amountOk, orderOk, valid: amountOk && orderOk, amount, orderId };
  }
  if (r === 'fail') {
    return { kind: 'fail', code: clip(p.get('code'), 60), message: clip(p.get('message'), 200) };
  }
  return { kind: 'start' };
}

export function describeResult(res) {
  if (res.kind === 'success') {
    if (!res.valid) {
      return { title: '확인할 수 없는 결과입니다', body: '돌아온 정보가 이 테스트의 값(3,900원, 테스트 주문번호)과 맞지 않아 아무것도 처리하지 않았습니다.', rows: [] };
    }
    return {
      title: '테스트 결제창에서 돌아온 주소입니다 (확인 필요)',
      body: '표시된 요청 정보만 확인했으며 테스트 인증이나 승인을 검증한 것은 아닙니다. 승인 요청을 보내지 않았으므로 실제 청구와 주문은 없습니다.',
      rows: [['테스트 주문번호', res.orderId], ['금액', '3,900원 (테스트)']],
    };
  }
  if (res.kind === 'fail') {
    const cancelled = res.code === 'PAY_PROCESS_CANCELED' || res.code === 'USER_CANCEL';
    return {
      title: cancelled ? '테스트 결제창을 닫았습니다' : '테스트 결제창이 완료되지 않았습니다',
      body: cancelled ? '결제창을 취소했습니다. 청구된 금액은 없습니다.' : '결제창이 완료되지 않았습니다. 청구된 금액은 없습니다.',
      rows: [['오류 코드', res.code || '-'], ['안내 메시지', res.message || '-']],
    };
  }
  return null;
}

function render(doc, res) {
  const d = describeResult(res);
  doc.getElementById('rc-start').hidden = true;
  doc.getElementById('rc-result').hidden = false;
  doc.getElementById('rc-root').dataset.view = res.kind;
  doc.getElementById('rc-result-title').textContent = d.title;
  doc.getElementById('rc-result-body').textContent = d.body;
  const dl = doc.getElementById('rc-result-detail');
  dl.textContent = '';
  for (const [k, v] of d.rows) {
    const dt = doc.createElement('dt'); dt.textContent = k;
    const dd = doc.createElement('dd'); dd.textContent = v;
    dl.append(dt, dd);
  }
  dl.hidden = d.rows.length === 0;
}

async function init() {
  const doc = document;
  const res = parseResult(location.search);
  if (res.kind !== 'start') {
    render(doc, res);
    // 주소창/기록에서 paymentKey 등 쿼리 제거
    try { history.replaceState(null, '', location.pathname); } catch { /* ignore */ }
    return;
  }
  const btn = doc.getElementById('rc-pay');
  const status = doc.getElementById('rc-status');
  btn.disabled = true; // 키가 확인되기 전에는 항상 비활성
  let key = null;
  let blocked = null;
  if (!isAllowedOrigin(location)) blocked = '이 주소에서는 테스트창을 열 수 없어요(https 또는 localhost 필요). 실제 결제는 꺼져 있어요.';
  else {
    key = await loadClientKey(typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
    if (!key) blocked = NOT_READY_MESSAGE;
    else if (typeof globalThis.TossPayments !== 'function') blocked = '토스페이먼츠 SDK를 불러오지 못해 테스트창을 열 수 없어요. 실제 결제는 꺼져 있어요.';
  }
  if (blocked) { status.textContent = blocked; return; }
  status.textContent = '';
  btn.disabled = false;

  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    status.textContent = '';
    try {
      const tp = globalThis.TossPayments(key);
      const payment = tp.payment({ customerKey: globalThis.TossPayments.ANONYMOUS });
      // 모바일·PC 모두 같은 창이 이동(redirect)합니다. 클릭 핸들러 안에서 바로 호출합니다.
      await payment.requestPayment(buildPaymentRequest(location.origin, makeOrderId()));
    } catch (e) {
      status.textContent = '테스트 결제창을 열지 못했습니다' + (e ? ' (' + clip(e.code, 60) + (e.message ? ': ' + clip(e.message, 120) : '') + ')' : '') + '. 청구된 금액은 없습니다.';
    } finally {
      btn.disabled = false;
    }
  });
}

if (typeof document !== 'undefined' && typeof location !== 'undefined' && document.getElementById('rc-root')) init();
