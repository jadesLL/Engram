import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_OFFICIAL_INPUT_MODALITIES,
  MODEL_INPUT_MODALITIES,
  normalizeInputModalities,
} from './modelCapabilities.js';

/**
 * 输入能力（模态）是「模型支持图片」的唯一判定依据：
 * 只认 text / image，去重、过滤脏值；空/非法一律退回 fallback，避免把空能力写进 dsh 配置。
 */

test('只暴露 text / image 两种输入能力', () => {
  assert.deepEqual([...MODEL_INPUT_MODALITIES], ['text', 'image']);
  assert.deepEqual(DEFAULT_OFFICIAL_INPUT_MODALITIES, ['text', 'image']);
});

test('合法数组保留首次出现顺序并去重', () => {
  assert.deepEqual(normalizeInputModalities(['text', 'image'], ['text']), ['text', 'image']);
  assert.deepEqual(normalizeInputModalities(['image'], ['text']), ['image']);
  assert.deepEqual(normalizeInputModalities(['image', 'text', 'image'], ['text']), ['image', 'text']);
  assert.deepEqual(normalizeInputModalities([' text '], ['image']), ['text']);
});

test('过滤未知类型与非字符串', () => {
  assert.deepEqual(normalizeInputModalities(['text', 'audio', 'video'], []), ['text']);
  assert.deepEqual(normalizeInputModalities(['text', null, 1, {}, 'IMAGE'], []), ['text']);
});

test('非数组 / 空数组 / 全部非法时退回 fallback', () => {
  assert.deepEqual(normalizeInputModalities(undefined, ['text']), ['text']);
  assert.deepEqual(normalizeInputModalities(null, ['text']), ['text']);
  assert.deepEqual(normalizeInputModalities('image', ['text']), ['text']);
  assert.deepEqual(normalizeInputModalities([], ['text']), ['text']);
  assert.deepEqual(normalizeInputModalities(['audio'], ['text']), ['text']);
});

test('返回新数组：改结果不会污染 fallback', () => {
  const fallback = ['text'];
  const empty = normalizeInputModalities([], fallback);
  assert.notEqual(empty, fallback);
  empty.push('image');
  assert.deepEqual(fallback, ['text']);

  const kept = normalizeInputModalities(['image'], fallback);
  kept.push('text');
  assert.deepEqual(fallback, ['text']);
});
