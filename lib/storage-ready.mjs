import {fail} from './core.mjs';
// Reading or deleting purchased results must not depend on the AI provider being online.
export function ensureStorageReady(c){
 if(!c.redisURL||!c.redisToken)fail('REDIS_UNAVAILABLE','안전한 결과 보관 설정을 확인하고 있습니다.',503,true);
 if(!c.secret||c.secret.length<24)fail('SESSION_CONFIG','결과 접근을 위한 안전한 세션 설정이 필요합니다.',503);
}
