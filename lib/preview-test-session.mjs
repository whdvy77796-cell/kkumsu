import {timingSafeEqual} from 'node:crypto';
import {hmac,fail} from './core.mjs';
import {previewRepeat} from './preview-repeat.mjs';

// Header access is temporary and restricted to the approved payment-disabled Preview.
// Invalid or expired test credentials must never fall back to the user's session.
export function isolatedPreviewTestSid(req,c){
 const supplied=req.headers?.['x-insosoe-preview-test'];if(supplied===undefined)return null;
 const expected=c.env?.INSOSOE_PREVIEW_TEST_TOKEN,now=Date.now();
 if(!previewRepeat(c)||c.env?.INSOSOE_PREVIEW_UNLIMITED_BUDGET!=='1'||typeof supplied!=='string'||typeof expected!=='string')fail('TEST_SESSION_DENIED','가상 시험 세션을 확인할 수 없습니다.',403);
 const match=/^(\d{13})\.([a-f0-9-]{36})$/i.exec(expected);const until=match?Number(match[1]):0;
 if(!match||!Number.isSafeInteger(until)||until<now||until>now+1800000)fail('TEST_SESSION_DENIED','가상 시험 세션이 만료되었습니다.',403);
 const a=Buffer.from(supplied),b=Buffer.from(expected);if(a.length!==b.length||!timingSafeEqual(a,b))fail('TEST_SESSION_DENIED','가상 시험 세션을 확인할 수 없습니다.',403);
 return hmac(c.secret,'isolated-preview-test:'+expected);
}
