// Kakao documents service user IDs as Long, 1..9223372036854775807:
// https://developers.kakao.com/docs/ko/getting-started/security-guideline#cautions-when-mapping
// Never derive an identity from JSON.parse's rounded Number. Validate the whole
// bounded document, then scan only its root members for the original token.
const MAX_ID = '9223372036854775807';
const MAX_BYTES = 65536;
export function kakaoIdFromJson(text) {
  const invalid = () => { throw new Error('Invalid Kakao identity'); };
  if (typeof text !== 'string' || text.length > MAX_BYTES || Buffer.byteLength(text, 'utf8') > MAX_BYTES) invalid();
  let value;
  try { value = JSON.parse(text); } catch { invalid(); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.hasOwn(value, 'error') || Object.hasOwn(value, 'code')) invalid();
  let i = 0, id;
  const whitespace = () => { while (i < text.length && /[\x20\t\r\n]/.test(text[i])) i++; };
  // JSON.parse above already verifies all escapes and structural delimiters.
  const stringEnd = () => {
    i++;
    while (i < text.length) {
      if (text[i] === '"') { i++; return; }
      i += text[i] === '\\' ? 2 : 1;
    }
    invalid();
  };
  const skipValue = () => {
    if (text[i] === '"') { stringEnd(); return; }
    if (text[i] === '{' || text[i] === '[') {
      // Iterative, not recursive: adversarial nesting cannot exhaust our stack.
      let depth = 0;
      do {
        const c = text[i];
        if (c === '"') { stringEnd(); continue; }
        if (c === '{' || c === '[') depth++;
        else if (c === '}' || c === ']') depth--;
        i++;
      } while (depth > 0 && i < text.length);
      return;
    }
    while (i < text.length && !/[\x20\t\r\n,}\]]/.test(text[i])) i++;
  };
  whitespace(); i++; whitespace(); // validated root opening brace
  while (text[i] !== '}') {
    const keyStart = i;
    stringEnd();
    const key = JSON.parse(text.slice(keyStart, i));
    whitespace(); i++; whitespace(); // validated colon
    const start = i;
    skipValue();
    if (key === 'id') {
      // Decoded keys catch id + \u0069d and escaped/escaped duplicates too.
      if (id !== undefined) invalid();
      const token = text.slice(start, i);
      if (!/^[1-9][0-9]{0,18}$/.test(token) || (token.length === MAX_ID.length && token > MAX_ID)) invalid();
      id = token;
    }
    whitespace();
    if (text[i] === '}') break;
    i++; whitespace(); // validated comma
  }
  if (id === undefined) invalid();
  return id;
}
