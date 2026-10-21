/* =========================================================
   꿈수 신당 · 쿠팡파트너스 링크
   - link  : 쿠팡파트너스 링크 (https://link.coupang.com/a/...)
   - widget: 쿠팡파트너스 "HTML" 코드의 <iframe src="..."> 주소 (https://coupa.ng/...)
             넣으면 쿠팡이 사진·이름·현재 가격을 직접 보여 주는 작은 상품 카드가 나와요.
   - image : (widget 이 없을 때만) 상품 사진 주소. 비우면 이모지가 나와요.
   - name  : 카드에 보이는 상품 이름 / copy: 카드 문구 (비우면 기본 문구)
   - badge : 작은 표시 (예: "로켓배송"). 비우면 안 보여요.
   - 가격은 직접 적지 마세요. 가격은 widget 이 실시간으로 보여 줘요.
   - 링크를 비워 둔 상품은 건너뛰고, 꿈에 맞는 상품이 없으면 default 가 나와요.

   ▶ 지금 켜진 상품: 생수(기본·물 꿈), 휴지(똥·화장실 꿈), 오뚜기밥(먹는 꿈)
   ========================================================= */
window.KKUMSU_COUPANG = {
  default: { name: "탐사수 생수 2L × 12병",       link: "https://link.coupang.com/a/h12a7BkDsW", widget: "https://coupa.ng/cqj4sr", badge: "로켓배송" },  // 그 밖의 모든 꿈
  water:   { name: "탐사수 생수 2L × 12병",       link: "https://link.coupang.com/a/h12a7BkDsW", widget: "https://coupa.ng/cqj4sr", badge: "로켓배송" },  // 물·바다·비 꿈
  tissue:  { name: "코멧 순백 3겹 두루마리 휴지", link: "https://link.coupang.com/a/h12i56iu3E", widget: "https://coupa.ng/cqj4yW", badge: "로켓배송" },  // 똥·화장실 꿈
  rice:    { name: "오뚜기밥 흰밥 210g × 6개",    link: "https://link.coupang.com/a/h12fM6LjCC", widget: "https://coupa.ng/cqj4wg", badge: "로켓배송" },  // 밥·먹는·잔치·요리 꿈

  // 아래는 나중에 필요하면 링크를 넣으세요 (비워 두면 생수가 대신 나와요)
  piggy:   { name: "황금 복돼지 저금통",        link: "", widget: "", badge: "" },  // 돼지·돈·황금 꿈
  lucky:   { name: "복을 담는 복주머니",        link: "", widget: "", badge: "" },  // 용·호랑이·대통령·뱀 꿈
  gift:    { name: "정성 담은 과일 선물세트",   link: "", widget: "", badge: "" },  // 조상·부모님 꿈
  tooth:   { name: "새 칫솔·치약 세트",         link: "", widget: "", badge: "" },  // 이빨 꿈
  plant:   { name: "푸른 기운 공기정화 화분",   link: "", widget: "", badge: "" },  // 꽃·나무 꿈
  towel:   { name: "뽀송한 호텔 수건 세트",     link: "", widget: "", badge: "" }   // 목욕·청소 꿈
};
