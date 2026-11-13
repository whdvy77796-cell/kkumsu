// 판매자(사업자) 정보. 전자상거래법에 따라 화면 아래와 약관·개인정보처리방침에 표시한다.
// 상호·대표자·사업자등록번호·주소·전화·이메일을 모두 채워야 실제 결제(토스페이먼츠 라이브 키)가 켜진다.
// 테스트 결제(미리보기 사이트, test_ 키)는 비어 있어도 동작한다.
export const BUSINESS = {
  name: '유즈풀쇼핑몰', // 사업자등록증상 상호
  owner: '임종표', // 사업자등록증상 대표자
  bizNo: '587-17-01601', // 사업자등록번호
  mailOrderNo: '2022-대구중구-0208', // 공정위 등록정보에서 확인한 통신판매업 신고번호
  address: '대구광역시 중구 달구벌대로447길 34-35, 101호(삼덕동3가)', // 사업자등록증상 사업장 주소
  phone: '010-2995-8439', // 기존 사이트에 기재했던 고객센터 전화번호
  email: 'lookhereai@yahoo.com', // 여기봐 AI 문의 이메일
  privacyEmail: 'lookhereai@yahoo.com', // 개인정보 문의 이메일
  privacyOfficer: '', // 개인정보 보호책임자 (비우면 대표자)
  hosting: 'Vercel Inc.', // 호스팅 서비스 제공자
};

export const REQUIRED_BUSINESS = ['name', 'owner', 'bizNo', 'address', 'phone', 'email'];
export const businessReady = (b = BUSINESS) => REQUIRED_BUSINESS.every((k) => String(b?.[k] || '').trim());
