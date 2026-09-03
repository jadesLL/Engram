import assert from 'node:assert/strict';
import test from 'node:test';
import {
  imageInputStatusFromMetadata,
  inferImageInputStatus,
  resolveImageInputCapability,
} from './modelCapabilities.js';

test('image capability inference recognizes known visual and text-only model families', () => {
  assert.equal(inferImageInputStatus('gpt-4.1-mini'), 'supported');
  assert.equal(inferImageInputStatus('qwen3.5-plus'), 'supported');
  assert.equal(inferImageInputStatus('glm-4.6v-flash'), 'supported');
  assert.equal(inferImageInputStatus('glm-5.3-flash'), 'supported');
  assert.equal(inferImageInputStatus('glm-5.3'), 'supported');
  assert.equal(inferImageInputStatus('glm-5v'), 'supported');
  assert.equal(inferImageInputStatus('deepseek-v4-flash'), 'unsupported');
  assert.equal(inferImageInputStatus('qwen3.5-coder'), 'unknown');
  assert.equal(inferImageInputStatus('doubao-seed-2-0-code'), 'unknown');
  assert.equal(inferImageInputStatus('custom-vision-model'), 'unknown');
  assert.equal(inferImageInputStatus('custom-model'), 'unknown');
});

test('image capability metadata takes explicit input modalities and booleans', () => {
  assert.equal(
    imageInputStatusFromMetadata({ architecture: { input_modalities: ['text', 'image'] } }),
    'supported',
  );
  assert.equal(
    imageInputStatusFromMetadata({ input_modalities: ['text'] }),
    'unsupported',
  );
  assert.equal(
    imageInputStatusFromMetadata({ capabilities: { vision: true } }),
    'supported',
  );
});

test('stored image capability takes priority over catalog inference', () => {
  assert.deepEqual(
    resolveImageInputCapability({ model: 'gpt-4.1-mini', imageInput: 'unsupported' }),
    { status: 'unsupported', source: 'stored' },
  );
});
