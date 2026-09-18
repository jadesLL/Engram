import test from 'node:test';
import assert from 'node:assert/strict';
import { SKILLS, findSkill } from './index.js';

test('skill 注册表：名称唯一、元数据齐全、正文非空', () => {
  assert.ok(SKILLS.length >= 2, '至少内置两份 skill');
  const names = SKILLS.map((s) => s.name);
  assert.equal(new Set(names).size, names.length, 'skill 名称必须唯一');

  for (const skill of SKILLS) {
    assert.match(skill.name, /^[a-z0-9][a-z0-9-]*$/, `名称须为 kebab-case: ${skill.name}`);
    assert.ok(skill.title.trim(), `缺少标题: ${skill.name}`);
    assert.ok(skill.description.trim(), `缺少用途: ${skill.name}`);
    assert.ok(skill.whenToUse.trim(), `缺少「何时用」: ${skill.name}`);
    assert.ok(Number.isInteger(skill.version) && skill.version >= 1, `版本须为正整数: ${skill.name}`);
    assert.ok(skill.body.length > 200, `正文过短: ${skill.name}`);
    assert.match(skill.body, /^# /, `正文应以一级标题开头: ${skill.name}`);
  }
});

test('首批两份 skill 已登记', () => {
  assert.ok(SKILLS.some((s) => s.name === 'docx-meeting-to-md'));
  assert.ok(SKILLS.some((s) => s.name === 'kb-ingest-discipline'));
});

test('findSkill：大小写与空白容错，未知名称返回 undefined', () => {
  assert.equal(findSkill('docx-meeting-to-md')?.name, 'docx-meeting-to-md');
  assert.equal(findSkill('  DOCX-MEETING-TO-MD  ')?.name, 'docx-meeting-to-md');
  assert.equal(findSkill(''), undefined);
  assert.equal(findSkill('   '), undefined);
  assert.equal(findSkill('not-a-skill'), undefined);
});

test('skill 正文承载纪律口径：原始资料无写权限、作业不打断、对话沉积须用户指示', () => {
  const discipline = findSkill('kb-ingest-discipline');
  assert.ok(discipline, 'kb-ingest-discipline 应存在');
  assert.match(discipline.body, /没有写权限/);
  // 全自动口径：拿不准自己定并标注，不停下来问用户
  assert.match(discipline.body, /不要停下来等用户/);
  assert.match(discipline.body, /待核实/);
  assert.doesNotMatch(discipline.body, /ask_user|list_questions|先问用户/);
  assert.match(discipline.body, /须用户指示/);
  assert.match(discipline.body, /可以被提炼/);
});
