import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DOXENT_CONFIG,
  DOXENT_CONFIG_KEY,
  normalizeDoxentConfigInput,
  parseDoxentConfig,
  serializeDoxentConfig,
} from './doxentConfig.js';

test('doxentConfig：缺省 / 空串 / 坏 JSON / 未知品牌都退回讯飞', () => {
  assert.equal(DOXENT_CONFIG_KEY, 'doxent_config');
  assert.deepEqual(parseDoxentConfig(null), DEFAULT_DOXENT_CONFIG);
  assert.deepEqual(parseDoxentConfig(''), DEFAULT_DOXENT_CONFIG);
  assert.deepEqual(parseDoxentConfig('{'), DEFAULT_DOXENT_CONFIG);
  assert.deepEqual(parseDoxentConfig('{"provider":"unknown"}'), DEFAULT_DOXENT_CONFIG);
  assert.deepEqual(parseDoxentConfig({ provider: 1 }), DEFAULT_DOXENT_CONFIG);
  assert.deepEqual(parseDoxentConfig('[]'), DEFAULT_DOXENT_CONFIG);
});

test('doxentConfig：合法品牌原样读出，序列化稳定', () => {
  assert.deepEqual(parseDoxentConfig('{"provider":"iflytek"}'), { provider: 'iflytek' });
  assert.deepEqual(parseDoxentConfig({ provider: 'iflytek' }), { provider: 'iflytek' });
  assert.equal(serializeDoxentConfig({ provider: 'iflytek' }), '{"provider":"iflytek"}');
});

test('doxentConfig 写入校验：未知品牌 / 缺字段 / 非对象一律拒绝（不能静默改成讯飞）', () => {
  assert.deepEqual(normalizeDoxentConfigInput({ provider: 'iflytek' }), { provider: 'iflytek' });
  assert.equal(normalizeDoxentConfigInput({ provider: 'unknown' }), null);
  assert.equal(normalizeDoxentConfigInput({}), null);
  assert.equal(normalizeDoxentConfigInput(null), null);
  assert.equal(normalizeDoxentConfigInput('iflytek'), null);
  assert.equal(normalizeDoxentConfigInput(['iflytek']), null);
});
