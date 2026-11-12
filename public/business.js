// 판매자(사업자) 정보. 전자상거래법에 따라 화면 아래와 약관·개인정보처리방침에 표시한다.
// 상호·대표자·사업자등록번호·주소·전화·이메일을 모두 채워야 실제 결제(토스페이먼츠 라이브 키)가 켜진다.
// 테스트 결제(미리보기 사이트, test_ 키)는 비어 있어도 동작한다.
export const BUSINESS = {
  name: '', // 상호
  owner: '', // 대표자
  bizNo: '', // 사업자등록번호 (예: 123-45-67890)
  mailOrderNo: '', // 통신판매업 신고번호 (면제 대상이면 비워 두기)
  address: '', // 사업장 주소
  phone: '', // 고객센터 전화번호
  email: '', // 고객센터 이메일
  privacyEmail: 'whdvy77796@gmail.com', // 사용자가 공개를 승인한 개인정보 문의 이메일
  privacyOfficer: '여기봐 AI 개인정보 담당', // 사용자가 승인한 개인정보 문의 담당 부서
  hosting: 'Vercel Inc.', // 호스팅 서비스 제공자
};

export const REQUIRED_BUSINESS = ['name', 'owner', 'bizNo', 'address', 'phone', 'email'];
export const businessReady = (b = BUSINESS) => REQUIRED_BUSINESS.every((k) => String(b?.[k] || '').trim());
