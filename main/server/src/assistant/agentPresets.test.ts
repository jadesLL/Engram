import test from 'node:test';
import assert from 'node:assert/strict';
import { pickDefaultPresetId } from './agentPresets.js';

const PRESETS = [{ id: 'standard' }, { id: 'ptc' }, { id: 'minimal' }, { id: 'cordis' }];

test('用户选过就用用户的选择（去首尾空白）', () => {
  assert.equal(pickDefaultPresetId(' minimal ', PRESETS), 'minimal');
  assert.equal(pickDefaultPresetId('ptc', PRESETS), 'ptc');
});

test('用户没选过时用 DSH 标记的 isDefault', () => {
  assert.equal(pickDefaultPresetId('', [{ id: 'ptc', isDefault: true }, { id: 'standard' }]), 'ptc');
  assert.equal(pickDefaultPresetId(undefined, [{ id: 'cordis', isDefault: true }]), 'cordis');
});

test('都没有时兜底标准模式', () => {
  assert.equal(pickDefaultPresetId('', PRESETS), 'standard');
  assert.equal(pickDefaultPresetId(undefined, PRESETS), 'standard');
  assert.equal(pickDefaultPresetId(null, PRESETS), 'standard');
});

test('空选择与空列表不产生假的预设 id', () => {
  assert.equal(pickDefaultPresetId('', []), '');
  assert.equal(pickDefaultPresetId('   ', [{ id: 'minimal' }]), '');
  assert.equal(pickDefaultPresetId(42, PRESETS), 'standard');
});
