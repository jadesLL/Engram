<template>
  <section class="settings-panel settings-native">
    <div class="panel-head">
      <div>
        <h3>IM / 飞书</h3>
        <p>配置飞书自建应用，把聊天消息直接接入助手 agent。</p>
      </div>
    </div>

    <div class="endpoint-block">
      <div>
        <span>飞书事件回调地址</span>
        <code>{{ webhookUrl }}</code>
      </div>
      <button class="btn" type="button" @click="copy(webhookUrl)">复制地址</button>
    </div>

    <div class="integration-note">
      在飞书开放平台「事件与回调」中订阅 <code>im.message.receive_v1</code>，回调地址填上方链接。
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
        <span>Encrypt Key</span>
        <input
          :type="revealed.encryptKey ? 'text' : 'password'"
          :value="displayValue('encryptKey')"
          @input="onSecretInput($event, 'encryptKey')"
          @focus="reveal('encryptKey')"
          @blur="hide('encryptKey')"
          placeholder="事件订阅加密密钥（可留空=不加密）"
          autocomplete="off"
        />
      </label>

      <label class="im-field">
        <span>Verification Token</span>
        <input
          :type="revealed.verifyToken ? 'text' : 'password'"
          :value="displayValue('verifyToken')"
          @input="onSecretInput($event, 'verifyToken')"
          @focus="reveal('verifyToken')"
          @blur="hide('verifyToken')"
          placeholder="事件订阅校验 token（可留空）"
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
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '../../api';
import { notify } from '../../lib/notify';

interface FeishuForm {
  appId: string;
  appSecret: string;
  encryptKey: string;
  verifyToken: string;
  apiBase: string;
}

const form = reactive<FeishuForm>({
  appId: '',
  appSecret: '',
  encryptKey: '',
  verifyToken: '',
  apiBase: 'https://open.feishu.cn',
});

// 用户编辑过的字段：新值；未编辑的保留空，保存时回退到已存值
const edited = reactive<Record<keyof FeishuForm, string>>({
  appId: '',
  appSecret: '',
  encryptKey: '',
  verifyToken: '',
  apiBase: '',
});

const revealed = reactive<Record<string, boolean>>({});
const saving = ref(false);
const testing = ref(false);

const webhookUrl = computed(() => `${location.origin}/api/im/feishu/webhook`);

// 已存值（onMounted 后填充），用于显示掩码和未编辑时的回退
const stored = reactive<FeishuForm>({ ...form });

function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return `${key.slice(0, 2)}****${key.slice(-2)}`;
  return `${key.slice(0, 4)}********${key.slice(-4)}`;
}

/** 输入框显示值：已编辑显示新值，未编辑显示掩码。 */
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

/** 用户输入时，若值等于已存原文则视为未改（存空），否则存新值。 */
function onSecretInput(event: Event, field: keyof FeishuForm): void {
  const value = (event.currentTarget as HTMLInputElement).value;
  edited[field] = value === stored[field] ? '' : value;
  revealed[field] = true;
}

/** 收集表单：已编辑字段用新值，未编辑用已存值。 */
function collectForm(): FeishuForm {
  return {
    appId: edited.appId || form.appId,
    appSecret: edited.appSecret || stored.appSecret,
    encryptKey: edited.encryptKey || stored.encryptKey,
    verifyToken: edited.verifyToken || stored.verifyToken,
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
    (['appSecret', 'encryptKey', 'verifyToken'] as const).forEach((f) => (edited[f] = ''));
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

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    notify.success('已复制');
  } catch {
    notify.error('复制失败');
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
.endpoint-block {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  margin: 22px 24px 12px;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
}
.endpoint-block > div { min-width: 0; }
.endpoint-block span {
  display: block;
  margin-bottom: 5px;
  color: var(--text-faint);
  font-size: 11px;
}
.endpoint-block code {
  display: block;
  overflow: hidden;
  padding: 0;
  background: transparent;
  color: var(--text);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.integration-note {
  margin: 0 24px 18px;
  color: var(--text-secondary);
  font-size: 12px;
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
  .endpoint-block { margin: 18px 18px 10px; }
  .integration-note { margin: 0 18px 16px; }
  .im-form, .im-actions { margin-left: 18px; margin-right: 18px; }
}
</style>
