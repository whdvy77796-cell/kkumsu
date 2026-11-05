export default function handler(req,res){res.setHeader('Cache-Control','no-store');res.status(410).json({error:'꿈수 서비스는 종료되었습니다. 인소서는 홈페이지에서 이용해주세요.',code:'SERVICE_REPLACED'});}
