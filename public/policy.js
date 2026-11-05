// Static policy content remains readable without this optional enhancement.
const legalFields = ['businessName','representative','businessNumber','commerceNumber','address','supportEmail','phone'];
const text = value => typeof value === 'string' ? value.trim() : '';
const statusNode = document.querySelector('#merchant-status');
async function loadPolicyInformation() {
 const controller = new AbortController();
 const timeout = setTimeout(() => controller.abort(), 8000);
 try {
  const response = await fetch('/api/insosoe', {credentials:'same-origin', cache:'no-store', signal:controller.signal});
  if (!response.ok) throw new Error('STATUS_UNAVAILABLE');
  const status = await response.json();
  const legal = status.paymentLegal && typeof status.paymentLegal === 'object' ? status.paymentLegal : {};
  for (const key of legalFields) {
   const node = document.querySelector('[data-legal="'+key+'"]');
   if (node && text(legal[key])) node.textContent = text(legal[key]);
  }
  for (const key of ['refundPolicy','deliveryTerms','financialRetention']) {
   const block = document.querySelector('[data-policy-detail="'+key+'"]');
   if (block && text(legal[key])) { block.querySelector('p').textContent = text(legal[key]); block.hidden = false; }
  }
  let hasLink = false;
  for (const key of ['termsUrl','privacyUrl']) {
   const node = document.querySelector('[data-policy-url="'+key+'"]');
   if (!node || !text(legal[key])) continue;
   try {
    const url = new URL(legal[key], location.origin);
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && url.origin === location.origin)) || url.username || url.password) continue;
    node.href = url.href; node.target = '_blank'; node.rel = 'noopener noreferrer';
    node.textContent += ' (새 창)'; node.hidden = false; hasLink = true;
   } catch { /* Invalid policy links stay hidden. */ }
  }
  const links = document.querySelector('#server-policy-links'); if (links) links.hidden = !hasLink;
  const provider = typeof status.provider === 'object' ? text(status.provider?.name)||text(status.provider?.id) : text(status.provider);
  const providerNode = document.querySelector('#provider-name'); if (providerNode && provider) providerNode.textContent = provider;
  const modelNode = document.querySelector('#provider-model'); if (modelNode && text(status.model)) modelNode.textContent = text(status.model);
  if (statusNode) {
   const merchantAvailable = ['businessName','representative','businessNumber','address','supportEmail'].every(key => text(legal[key]));
   if (status.paymentReady === true && status.paymentMode === 'live' && merchantAvailable) {
    statusNode.textContent = '서비스 서버가 제공한 사업자·문의 정보입니다. 실제 결제 가능 여부는 결제 직전에 다시 확인합니다.';
    statusNode.classList.remove('warning');
   } else if (status.paymentMode === 'test') {
    statusNode.textContent = '현재 테스트 환경입니다. 실제 구매·청구가 아닙니다. 준비되지 않은 사업자·문의 정보는 아래에 표시하지 않습니다.';
   } else {
    statusNode.textContent = '실결제 준비 중입니다. '+(text(status.paymentDisabledReason)||'사업자 정보와 결제·운영 조건이 준비되기 전에는 실제 결제를 받지 않습니다.');
   }
  }
 } catch {
  if (statusNode) statusNode.textContent = '결제 준비 정보 확인이 필요합니다. 지금은 서버의 사업자·문의 정보를 확인할 수 없습니다. 아래 정책 본문은 계속 읽을 수 있으며, 결제 가능한 상태로 간주하지 마세요.';
 } finally { clearTimeout(timeout); }
}
loadPolicyInformation();
