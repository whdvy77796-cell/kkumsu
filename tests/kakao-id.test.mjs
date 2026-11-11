import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kakaoIdFromJson } from '../lib/kakao-id.mjs';

test('Kakao exact decimal identity covers documented Long range without rounding', () => {
  for (const id of ['1', '12345', '9007199254740991', '9007199254740992', '9007199254740993', '9223372036854775806', '9223372036854775807']) {
    assert.equal(kakaoIdFromJson('{"id":' + id + '}'), id);
  }
  assert.equal(kakaoIdFromJson(' \r\n{ "other":null, "id" : 12345, "tail":true }\t'), '12345');
  assert.equal(kakaoIdFromJson('{"\\u0069\\u0064":12345}'), '12345');
});
test('Kakao rejects non-integer tokens, overflow, duplicate decoded IDs and error envelopes', () => {
  const values = ['0', '-0', '-1', '1.0', '1.5', '1e0', '1E2', '1e+3', '1e-3', '01', '+1', '0x1', 'NaN', 'Infinity', '9223372036854775808', '9999999999999999999', '10000000000000000000', '"123"', 'null', 'true', 'false', '{}', '[]'];
  for (const value of values) assert.throws(() => kakaoIdFromJson('{"id":' + value + '}'), /Invalid Kakao identity/);
  for (const raw of [
    '{"id":1,"id":2}', '{"id":1,"id":1}', '{"id":1,"\\u0069d":2}', '{"i\\u0064":1,"id":2}', '{"\\u0069d":1,"i\\u0064":2}',
    '{"id":1,"error":"sensitive"}', '{"id":1,"error":false}', '{"id":1,"code":0}', '{"id":1,"co\\u0064e":null}',
    '{"error":true,"error":false,"id":1}', '{"id":1,"error":{"id":2}}',
  ]) assert.throws(() => kakaoIdFromJson(raw), { message: 'Invalid Kakao identity' });
});
test('Kakao rejects non-objects, malformed JSON, suffix matches and nested/string decoys', () => {
  for (const raw of [undefined, {}, '', 'null', 'true', '123', '"id":123', '"{\\"id\\":123}"', '[]', '[{"id":1}]', '{}',
    '{"user_id":1}', '{"prefixid":1}', '{"id ":1}', '{"nested":{"id":1}}', '{"nested":[{"id":1}]}', '{"text":"\\\"id\\\":123"}',
    '{"id":123junk}', '{"id":123,"x":}', '{"id":123} garbage', '{"id":123}{"id":456}', '{"id":123,}', '{id:123}',
    '{/*x*/"id":123}', '{"id":1 //comment\n}', '{"id":1,"x":"\u0000"}', '\uFEFF{"id":1}',
  ]) assert.throws(() => kakaoIdFromJson(raw), { message: 'Invalid Kakao identity' });
  const nested = { id: 999, text: '"id":777, } ] \\ "', code: 0, array: [{ id: 2 }, '[]{}'] };
  assert.equal(kakaoIdFromJson('{"nested":' + JSON.stringify(nested) + ',"id":12345,"last":[{"id":7}]}'), '12345');
  assert.equal(kakaoIdFromJson('{"__proto__":{"id":7},"constructor":{"id":8},"id":12345}'), '12345');
});
test('Kakao parsing is byte-bounded and iterative under adversarial nesting', () => {
  const prefix = '{"id":1,"padding":"', suffix = '"}';
  assert.equal(kakaoIdFromJson(prefix + 'x'.repeat(65536 - prefix.length - suffix.length) + suffix), '1');
  assert.throws(() => kakaoIdFromJson(prefix + 'x'.repeat(65537 - prefix.length - suffix.length) + suffix));
  assert.throws(() => kakaoIdFromJson(prefix + '가'.repeat(22000) + suffix));
  assert.equal(kakaoIdFromJson('{"decoy":' + '['.repeat(15000) + '{"id":9}' + ']'.repeat(15000) + ',"id":1}'), '1');
});
