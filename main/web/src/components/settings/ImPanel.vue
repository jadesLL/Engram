<template>
  <section class="settings-panel settings-native">
    <div class="panel-head">
      <div>
        <h3>IM / 飞书</h3>
        <p>配置飞书自建应用，通过长连接接收消息并直接接入助手 agent（无需公网回调地址）。</p>
      </div>
    </div>

    <div class="integration-note">
      在飞书开放平台创建自建应用，在「事件与回调」中选择<strong>长连接</strong>模式并订阅
      <code>im.message.receive_v1</code>。填写下方凭证后保存，服务重启即自动建立长连接。
    </div>

    <div class="im-form">
      <label class="im-field">
        <span>App ID</span>
        <input type="text" v-model="form.appId" placeholder="cli_xxxxxxxxxxxx" autocomplete="off" />
      </label>

      <label class="im-field">
        <span>App Secret</span>
        <input
          :type="revealed.appSecret ? 'text' : 'password'"
          :value="displayValue('appSecret')"
          @input="onSecretInput($event, 'appSecret')"
          @focus="reveal('appSecret')"
          @blur="hide('appSecret')"
          placeholder="应用凭证页的 App Secret"
          autocomplete="off"
        />
      </label>

      <label class="im-field">
        <span>API Base</span>
        <input type="text" v-model="form.apiBase" placeholder="https://open.feishu.cn" autocomplete="off" />
      </label>
    </div>

    <div class="im-actions">
      <button class="btn primary" type="button" :disabled="saving" @click="save">
        {{ saving ? '保存中…' : '保存' }}
      </button>
      <button class="btn" type="button" :disabled="testing || !form.appId || !form.appSecret" @click="test">
        {{ testing ? '测试中…' : '测试连接' }}
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { api } from '../../api';
import { notify } from '../../lib/notify';

interface FeishuForm {
  appId: string;
  appSecret: string;
  apiBase: string;
}

const form = reactive<FeishuForm>({
  appId: '',
  appSecret: '',
  apiBase: 'https://open.feishu.cn',
});

const edited = reactive<Record<keyof FeishuForm, string>>({
  appId: '',
  appSecret: '',
  apiBase: '',
});

const revealed = reactive<Record<string, boolean>>({});
const saving = ref(false);
const testing = ref(false);

const stored = reactive<FeishuForm>({ ...form });

function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return `${key.slice(0, 2)}****${key.slice(-2)}`;
  return `${key.slice(0, 4)}********${key.slice(-4)}`;
}

function displayValue(field: keyof FeishuForm): string {
  if (edited[field]) return edited[field]!;
  if (revealed[field]) return stored[field];
  return maskKey(stored[field]);
}

function reveal(field: string): void {
  if (stored[field as keyof FeishuForm]) revealed[field] = true;
}

function hide(field: string): void {
  revealed[field] = false;
}

function onSecretInput(event: Event, field: keyof FeishuForm): void {
  const value = (event.currentTarget as HTMLInputElement).value;
  edited[field] = value === stored[field] ? '' : value;
  revealed[field] = true;
}

function collectForm(): FeishuForm {
  return {
    appId: edited.appId || form.appId,
    appSecret: edited.appSecret || stored.appSecret,
    apiBase: form.apiBase || stored.apiBase || 'https://open.feishu.cn',
  };
}

async function save(): Promise<void> {
  saving.value = true;
  try {
    const collected = collectForm();
    await api.put('/api/settings', { feishu_config: JSON.stringify(collected) });
    Object.assign(stored, collected);
    Object.assign(form, collected);
    edited.appSecret = '';
    notify.success('飞书配置已保存');
  } catch (e) {
    notify.error('保存失败');
    console.error(e);
  } finally {
    saving.value = false;
  }
}

async function test(): Promise<void> {
  testing.value = true;
  try {
    const collected = collectForm();
    const { data } = await api.post('/api/settings/test-feishu', collected);
    if (data.ok) {
      notify.success(`连接成功（token: ${data.token}）`);
    } else {
      notify.error(`连接失败：${data.error}`);
    }
  } catch (e) {
    notify.error('测试请求失败');
    console.error(e);
  } finally {
    testing.value = false;
  }
}

onMounted(async () => {
  try {
    const { data } = await api.get('/api/settings');
    const raw = data.settings?.feishu_config;
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<FeishuForm>;
      Object.assign(form, { apiBase: 'https://open.feishu.cn', ...parsed });
      Object.assign(stored, form);
    }
  } catch (e) {
    console.error('加载飞书配置失败', e);
  }
});
</script>

<style scoped>
.integration-note {
  margin: 22px 24px 18px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
}
.im-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin: 0 24px 18px;
}
.im-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.im-field span {
  color: var(--text-faint);
  font-size: 12px;
}
.im-field input {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-input);
  color: var(--text);
  font-size: 13px;
}
.im-field input:focus {
  outline: none;
  border-color: var(--accent);
}
.im-actions {
  display: flex;
  gap: 10px;
  margin: 0 24px 24px;
}

@media (max-width: 768px) {
  .integration-note { margin: 18px 18px 16px; }
  .im-form, .im-actions { margin-left: 18px; margin-right: 18px; }
}
</style>
