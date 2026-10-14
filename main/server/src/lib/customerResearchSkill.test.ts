import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installCustomerResearchSkill, removeCustomerResearchSkill, customerResearchSkillInstalled } from './customerResearchSkill.js';
import { registerCodexMcp, unregisterCodexMcp } from './codexConfig.js';
import { registerDshMcp, unregisterDshMcp } from './dshConfig.js';
import { registerExternalMcp, unregisterExternalMcp, externalMcpStatus } from './externalMcpConfig.js';

test('客户端入口只含服务端调用，安装幂等；不覆盖或删除用户自己的同名技能', () => {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'engram-research-skill-'));
  try {
    const root=path.join(tmp,'skills'), file=installCustomerResearchSkill(root);
    assert.equal(customerResearchSkillInstalled(root),true);
    const content=fs.readFileSync(file,'utf8'); assert.match(content,/begin_customer_research/); assert.doesNotMatch(content,/Bearer/);
    assert.equal(installCustomerResearchSkill(root),file);
    removeCustomerResearchSkill(root); assert.equal(fs.existsSync(file),false);
    fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'用户自己的技能');
    assert.throws(()=>installCustomerResearchSkill(root),/拒绝覆盖/);removeCustomerResearchSkill(root);
    assert.equal(fs.readFileSync(file,'utf8'),'用户自己的技能');
  } finally { fs.rmSync(tmp,{recursive:true,force:true}); }
});
test('Codex、DeepSeek Harness、WorkBuddy 和 Kimi Code 注册/注销同时维护入口技能且保留其他配置', () => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'engram-research-adapters-'));
  try {
    const codex=path.join(home,'.codex','config.toml'), dsh=path.join(home,'.dsh','cordis.patch.yml');
    registerCodexMcp('http://127.0.0.1:8080/mcp','test-token',codex);assert.equal(customerResearchSkillInstalled(path.join(home,'.codex','skills')),true);
    registerDshMcp('http://127.0.0.1:8080/mcp','test-token',dsh);assert.equal(customerResearchSkillInstalled(path.join(home,'.dsh','skills')),true);
    for(const dir of ['.workbuddy','.kimi-code']) {fs.mkdirSync(path.join(home,dir));fs.writeFileSync(path.join(home,dir,'config.toml'),'client configuration');fs.writeFileSync(path.join(home,dir,'mcp.json'),JSON.stringify({mcpServers:{keep:{url:'https://example.com/mcp'}}}));}
    for(const target of ['workbuddy','kimi'] as const) {
      const paths=registerExternalMcp(target,'http://127.0.0.1:8080/mcp','test-token',home);
      const config=JSON.parse(fs.readFileSync(paths[0],'utf8'));assert.ok(config.mcpServers.keep);assert.ok(config.mcpServers.engram);
      assert.equal(externalMcpStatus(target,home).researchSkill,true);
      unregisterExternalMcp(target,home);assert.equal(externalMcpStatus(target,home).researchSkill,false);assert.ok(JSON.parse(fs.readFileSync(paths[0],'utf8')).mcpServers.keep);
    }
    unregisterCodexMcp(codex);unregisterDshMcp(dsh);
    assert.equal(customerResearchSkillInstalled(path.join(home,'.codex','skills')),false);assert.equal(customerResearchSkillInstalled(path.join(home,'.dsh','skills')),false);
  } finally {fs.rmSync(home,{recursive:true,force:true});}
});

test('同名用户技能冲突在修改 MCP 配置前发现', () => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'engram-launcher-preflight-'));
  try {
    const config=path.join(home,'.codex','config.toml'),root=path.join(home,'.codex','skills');
    fs.mkdirSync(path.join(root,'engram-customer-research'),{recursive:true});fs.writeFileSync(config,'user configuration\n');
    fs.writeFileSync(path.join(root,'engram-customer-research','SKILL.md'),'user owned skill');
    assert.throws(()=>registerCodexMcp('http://127.0.0.1:8080/mcp','test-token',config),/拒绝覆盖/);
    assert.equal(fs.readFileSync(config,'utf8'),'user configuration\n');
  } finally {fs.rmSync(home,{recursive:true,force:true});}
});
