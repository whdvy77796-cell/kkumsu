// 판매자(사업자) 정보. 전자상거래법에 따라 화면 아래와 약관·개인정보처리방침에 표시한다.
// 사업자등록증(간이과세자)과 같게 적는다. 토스페이먼츠·카드사 심사는 하단 정보가 등록증과 일치하는지 본다.
// 상호·대표자·사업자등록번호·주소·전화·이메일을 모두 채워야 실제 결제(라이브 키)가 켜진다.
export const BUSINESS = {
  name: '유즈풀쇼핑몰', // 상호
  owner: '임종표', // 대표자
  bizNo: '587-17-01601', // 사업자등록번호
  mailOrderNo: '2022-대구중구-0208', // 통신판매업 신고번호
  address: '대구광역시 중구 달구벌대로447길 34-35, 101호(삼덕동3가)', // 사업장 주소
  phone: '010-2995-8439', // 고객센터 전화번호
  email: 'whdvy778@naver.com', // 고객센터·개인정보 문의 이메일
  privacyOfficer: '임종표', // 개인정보 보호책임자
  hosting: 'Vercel Inc.', // 호스팅 서비스 제공자
};

export const REQUIRED_BUSINESS = ['name', 'owner', 'bizNo', 'address', 'phone', 'email'];
export const businessReady = (b = BUSINESS) => REQUIRED_BUSINESS.every((k) => String(b?.[k] || '').trim());
// 공정거래위원회 사업자정보 공개 페이지 (통신판매사업자 정보 확인)
export const bizCheckUrl = (b = BUSINESS) => `https://www.ftc.go.kr/bizCommPop.do?wrkr_no=${String(b?.bizNo || '').replace(/\D/g, '')}`;