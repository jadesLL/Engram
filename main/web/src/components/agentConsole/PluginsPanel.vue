<template>
  <section class="console-panel settings-native">
    <header class="panel-head">
      <div>
        <h3>插件</h3>
        <p>内置插件的参数在卡片里直接改；实验性插件在这里启用或停用，插件清单只读展示当前的运行状态。</p>
      </div>
      <span v-if="payload && !payload.writable" class="readonly-badge">只读</span>
    </header>

    <div v-if="loading && !payload" class="panel-loading" aria-busy="true">
      <span class="skeleton-line" />
      <span class="skeleton-line short" />
      <span class="skeleton-line" />
    </div>
    <div v-else-if="error && !payload" class="panel-error">
      <p><Icon name="alert" :size="15" /> 插件配置读取失败：{{ error }}</p>
      <button class="btn small" type="button" @click="emit('retry')">重试</button>
    </div>

    <template v-else>
      <p v-if="error" class="state-strip tone-warn panel-strip">
        <span class="state-dot" aria-hidden="true" />
        <span>刷新失败：{{ error }}（仍显示上一次读取的配置）</span>
      </p>
      <p v-if="payload && !payload.writable" class="state-strip panel-strip">
        <span class="state-dot" aria-hidden="true" />
        <span>当前环境不允许修改插件配置：以下内容仅供查看。</span>
      </p>

      <!-- 内置插件配置 -->
      <article class="console-card">
        <div class="card-head">
          <div>
            <h4>内置插件配置</h4>
            <p>点击卡片展开表单；保存后对聊天 Agent 生效（部分插件只影响新会话）。</p>
          </div>
        </div>
        <div class="card-body">
          <p v-if="!data.cards.length" class="empty-hint">服务端没有返回可配置的内置插件。</p>
          <div v-for="card in data.cards" :key="card.key" class="plugin-card" :class="{ 'is-open': isExpanded(card.key) }">
            <button
              class="plugin-card-head"
              type="button"
              :aria-expanded="isExpanded(card.key)"
              @click="toggleCard(card.key)"
            >
              <span class="plugin-icon" aria-hidden="true"><Icon :name="iconName(card.icon)" :size="17" /></span>
              <span class="plugin-copy">
                <strong>{{ card.title }}</strong>
                <span>{{ card.description }}</span>
              </span>
              <Icon class="plugin-caret" name="chevron-down" :size="14" />
            </button>
            <div v-if="isExpanded(card.key)" class="plugin-form">
              <p v-if="!card.fields.length" class="empty-hint">这个插件没有可配置项。</p>
              <ConsoleField v-for="field in card.fields" :key="field.key" :label="field.label" :hint="field.hint || ''">
                <label v-if="field.type === 'boolean'" class="switch-control">
                  <input
                    type="checkbox"
                    :checked="formBoolean(card.key, field.key)"
                    :disabled="!writable || savingCard === card.key"
                    @change="setFormBoolean(card.key, field.key, $event)"
                  />
                  <span aria-hidden="true"></span>
                  <em>{{ formBoolean(card.key, field.key) ? '已开启' : '已关闭' }}</em>
                </label>
                <AppSelect
                  v-else-if="field.type === 'select'"
                  :model-value="formText(card.key, field.key)"
                  :options="field.options ?? []"
                  :aria-label="field.label"
                  :disabled="!writable || savingCard === card.key"
                  @update:model-value="setFormText(card.key, field.key, $event)"
                />
                <SecretField
                  v-else-if="field.type === 'secret'"
                  v-model="secrets[card.key][field.key]"
                  :stored="field.configured ? '已配置（服务端不回显）' : ''"
                  :placeholder="field.configured ? '已配置（留空不改）' : '未配置'"
                  :disabled="!writable || savingCard === card.key"
                />
                <input
                  v-else
                  :value="formText(card.key, field.key)"
                  :type="field.type === 'number' ? 'number' : 'text'"
                  :min="field.min"
                  :max="field.max"
                  :step="field.step"
                  :placeholder="field.placeholder || ''"
                  :disabled="!writable || savingCard === card.key"
                  @input="setFormTextFromInput(card.key, field.key, $event)"
                />
              </ConsoleField>
              <div class="card-actions">
                <button
                  class="btn primary small"
                  type="button"
                  :disabled="!writable || Boolean(savingCard) || !card.fields.length"
                  @click="saveCard(card)"
                >
                  {{ savingCard === card.key ? '保存中…' : '保存' }}
                </button>
                <span class="action-hint">密钥类字段留空表示保持现有配置</span>
              </div>
            </div>
          </div>
        </div>
      </article>

      <!-- 实验性插件 -->
      <article v-if="data.experimental.length" class="console-card">
        <div class="card-head">
          <div>
            <h4>实验性插件</h4>
            <p>这些功能仍在验证中，可能改变行为或界面；切换后对之后的任务生效。</p>
          </div>
        </div>
        <div class="card-body">
          <div v-for="item in data.experimental" :key="item.key" class="experimental-row">
            <div class="experimental-copy">
              <div class="experimental-title">
                <strong>{{ item.title }}</strong>
                <span class="tag">{{ item.tag || '实验性' }}</span>
              </div>
              <p v-if="item.description">{{ item.description }}</p>
            </div>
            <label class="switch-control">
              <input
                type="checkbox"
                :checked="experimentalEnabled(item)"
                :disabled="!writable || togglingKey === experimentalKey(item)"
                @change="toggleExperimental(item)"
              />
              <span aria-hidden="true"></span>
              <em>{{ togglingKey === experimentalKey(item) ? '处理中…' : experimentalEnabled(item) ? '已启用' : '已停用' }}</em>
            </label>
          </div>
        </div>
      </article>

      <!-- 插件清单（只读） -->
      <article class="console-card">
        <div class="card-head">
          <div>
            <h4>插件清单</h4>
            <p>只读：当前鉴权与所有会话加载的插件及运行状态，按作用域分组。</p>
          </div>
          <button class="btn small" type="button" :aria-expanded="inventoryOpen" @click="inventoryOpen = !inventoryOpen">
            {{ inventoryOpen ? '收起清单' : `展开清单（${data.inventory.length}）` }}
          </button>
        </div>
        <div class="card-body">
          <p v-if="!data.inventory.length" class="empty-hint">暂时没有可展示的插件。</p>
          <p v-else-if="!inventoryOpen" class="inventory-summary">
            共 {{ data.inventory.length }} 个插件：会话插件 {{ inventoryGroups[0].items.length }} 个 · 全局插件 {{ inventoryGroups[1].items.length }} 个。
          </p>
          <div v-else class="inventory">
            <section v-for="group in inventoryGroups" :key="group.key" class="inventory-group">
              <h5>{{ group.label }}（{{ group.items.length }}）</h5>
              <p v-if="!group.items.length" class="faint small">这一类没有插件。</p>
              <div v-for="item in group.items" :key="item.entryId" class="inventory-row">
                <span class="status-dot" :class="`tone-${inventoryStatusLabel(item.status, item.enabled).tone}`" aria-hidden="true" />
                <div class="inventory-copy">
                  <div class="inventory-title">
                    <strong>{{ item.title }}</strong>
                    <code>{{ item.entryId }}</code>
                  </div>
                  <div class="inventory-meta">
                    <span>{{ inventoryStatusLabel(item.status, item.enabled).text }}</span>
                    <span v-if="item.module">{{ item.module }}</span>
                  </div>
                  <p v-if="item.description" class="inventory-desc">{{ item.description }}</p>
                </div>
              </div>
            </section>
          </div>
        </div>
      </article>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import AppSelect from '../ui/AppSelect.vue';
import Icon from '../Icon.vue';
import SecretField from '../SecretField.vue';
import ConsoleField from './ConsoleField.vue';
import { notify } from '../../lib/notify';
import {
  errorMessage,
  patchPluginConfig,
  togglePlugin,
  type ExperimentalPluginPayload,
  type PluginCardPayload,
  type PluginsPayload,
} from '../../lib/agentConsoleApi';
import {
  groupInventory,
  inventoryStatusLabel,
  normalizePlugins,
  pluginConfigPayload,
  pluginFormDefaults,
  revisionConflict,
  type PluginFormState,
  type PluginSecretState,
} from '../../lib/agentConsoleUi';

/**
 * 插件面板：内置插件配置（可按卡片展开表单）/ 实验性插件开关 / 只读插件清单。
 * 数据由父级统一加载，写接口返回完整 payload 后经 saved 事件回传父级；409 交给父级刷新。
 */

const props = defineProps<{
  payload: PluginsPayload | null;
  loading: boolean;
  error: string;
}>();

const emit = defineEmits<{
  (e: 'saved', payload: PluginsPayload): void;
  (e: 'conflict'): void;
  (e: 'retry'): void;
}>();

const data = computed<PluginsPayload>(() => props.payload ?? normalizePlugins(null));
const writable = computed(() => props.payload?.writable === true);

const expanded = reactive<Record<string, boolean>>({});
const forms = reactive<Record<string, PluginFormState>>({});
const secrets = reactive<Record<string, PluginSecretState>>({});
const savingCard = ref('');
const togglingKey = ref('');
const inventoryOpen = ref(false);
/** 实验性插件的乐观开关：请求返回前先按用户操作显示，失败回滚 */
const experimentalOverride = ref<Record<string, boolean>>({});

const inventoryGroups = computed(() => {
  const grouped = groupInventory(data.value.inventory);
  return [
    { key: 'session', label: '会话插件', items: grouped.session },
    { key: 'global', label: '全局插件', items: grouped.global },
  ];
});

const ICON_NAMES: Record<string, string> = {
  subagent: 'subagent',
  'web-search': 'globe',
  'agent-loop': 'refresh',
  terminal: 'monitor',
};

function iconName(name: string): string {
  return ICON_NAMES[name] || 'plug';
}

function experimentalKey(item: ExperimentalPluginPayload): string {
  return `${item.kind}:${item.id}`;
}

function experimentalEnabled(item: ExperimentalPluginPayload): boolean {
  const override = experimentalOverride.value[experimentalKey(item)];
  return override === undefined ? item.enabled : override;
}

function isExpanded(key: string): boolean {
  return expanded[key] === true;
}

/*
 * 表单值读写走显式 getter/setter 而不是模板里的 as 断言：
 * v-model 要求可赋值成员表达式，带 TS 断言的写法在编译器里不稳；这里让表单值保持
 * string | boolean 联合类型，按字段类型取用并在写回时收窄。
 */
function formValue(cardKey: string, fieldKey: string): string | boolean {
  return forms[cardKey]?.[fieldKey] ?? '';
}

function formText(cardKey: string, fieldKey: string): string {
  const value = formValue(cardKey, fieldKey);
  return typeof value === 'string' ? value : '';
}

function formBoolean(cardKey: string, fieldKey: string): boolean {
  return formValue(cardKey, fieldKey) === true;
}

function setFormValue(cardKey: string, fieldKey: string, value: string | boolean): void {
  if (!forms[cardKey]) forms[cardKey] = {};
  forms[cardKey][fieldKey] = value;
}

function setFormText(cardKey: string, fieldKey: string, value: string): void {
  setFormValue(cardKey, fieldKey, value);
}

function setFormBoolean(cardKey: string, fieldKey: string, event: Event): void {
  const target = event.target as HTMLInputElement | null;
  setFormValue(cardKey, fieldKey, target?.checked === true);
}

function setFormTextFromInput(cardKey: string, fieldKey: string, event: Event): void {
  const target = event.target as HTMLInputElement | null;
  setFormValue(cardKey, fieldKey, target?.value ?? '');
}

function toggleCard(key: string): void {
  expanded[key] = !expanded[key];
}

/** schema → 表单/密钥默认值（payload 每次变化都重建，保存成功后展示服务端最新值） */
function buildCardState(cards: PluginCardPayload[]): void {
  for (const card of cards) {
    forms[card.key] = pluginFormDefaults(card);
    const secret: PluginSecretState = {};
    for (const field of card.fields) {
      if (field.type === 'secret') secret[field.key] = '';
    }
    secrets[card.key] = secret;
  }
}

watch(
  () => props.payload,
  (payload) => {
    if (!payload) return;
    buildCardState(payload.cards);
    experimentalOverride.value = {};
  },
  { immediate: true },
);

async function saveCard(card: PluginCardPayload): Promise<void> {
  if (!writable.value || savingCard.value) return;
  savingCard.value = card.key;
  try {
    const body = pluginConfigPayload(card, forms[card.key] ?? {}, secrets[card.key] ?? {});
    const next = await patchPluginConfig(card.key, body);
    emit('saved', normalizePlugins(next));
    notify.success('已保存，聊天 Agent 下一轮对话生效');
  } catch (error) {
    handleMutationError(error);
  } finally {
    savingCard.value = '';
  }
}

async function toggleExperimental(item: ExperimentalPluginPayload): Promise<void> {
  const key = experimentalKey(item);
  if (!writable.value || togglingKey.value) return;
  const nextEnabled = !experimentalEnabled(item);
  experimentalOverride.value = { ...experimentalOverride.value, [key]: nextEnabled };
  togglingKey.value = key;
  try {
    const next = await togglePlugin({ kind: item.kind, id: item.id, enabled: nextEnabled });
    emit('saved', normalizePlugins(next));
    notify.success(nextEnabled ? `「${item.title}」已启用` : `「${item.title}」已停用`);
  } catch (error) {
    // 失败回滚开关
    const rolledBack = { ...experimentalOverride.value };
    delete rolledBack[key];
    experimentalOverride.value = rolledBack;
    handleMutationError(error);
  } finally {
    togglingKey.value = '';
  }
}

function handleMutationError(error: unknown): void {
  if (revisionConflict(error)) {
    notify.error('配置已在别处被修改，已刷新为最新版本，请重试');
    emit('conflict');
    return;
  }
  notify.error(errorMessage(error, '保存失败'));
}
</script>

<style scoped>
.console-panel {
  container-type: inline-size;
}
.panel-head {
  align-items: flex-start;
}
.readonly-badge {
  flex: none;
  padding: 2px 9px;
  border-radius: 999px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}
.panel-loading {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 8px 0 14px;
}
.skeleton-line {
  height: 12px;
  border-radius: 6px;
  background: linear-gradient(90deg, var(--bg-secondary), var(--border), var(--bg-secondary));
  background-size: 200% 100%;
  animation: console-skeleton 1.2s ease-in-out infinite;
}
.skeleton-line.short {
  width: 56%;
}
@keyframes console-skeleton {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
.panel-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--warning) 35%, var(--border));
  border-radius: 8px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 12.5px;
}
.panel-error p {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}
.panel-strip {
  margin: 0 0 14px;
}
.console-card {
  margin-bottom: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--card-bg);
  overflow: hidden;
}
.console-card:last-child {
  margin-bottom: 0;
}
.card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  padding: 13px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
}
.card-head h4 {
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
}
.card-head p {
  margin: 4px 0 0;
  color: var(--text-faint);
  font-size: 11.5px;
  line-height: 1.5;
}
.card-body {
  padding: 12px 16px 14px;
}
.plugin-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
  margin-bottom: 10px;
  overflow: hidden;
}
.plugin-card:last-child {
  margin-bottom: 0;
}
.plugin-card.is-open {
  background: var(--card-bg);
}
.plugin-card-head {
  display: flex;
  align-items: center;
  gap: 11px;
  width: 100%;
  padding: 11px 13px;
  border: 0;
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.plugin-card-head:hover {
  background: var(--bg-hover);
}
.plugin-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: var(--accent-soft);
  color: var(--accent);
}
.plugin-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}
.plugin-copy strong {
  font-size: 13px;
  font-weight: 600;
}
.plugin-copy span {
  color: var(--text-faint);
  font-size: 11.5px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.plugin-caret {
  flex: none;
  color: var(--text-faint);
  transition: transform 150ms ease;
}
.plugin-card.is-open .plugin-caret {
  transform: rotate(180deg);
}
.plugin-form {
  padding: 2px 13px 13px;
  border-top: 1px solid var(--border);
}
.experimental-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  padding: 11px 0;
  border-bottom: 1px solid var(--border);
}
.experimental-row:last-child {
  border-bottom: 0;
}
.experimental-copy {
  min-width: 0;
}
.experimental-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.experimental-title strong {
  font-size: 13px;
}
.experimental-copy p {
  margin: 4px 0 0;
  color: var(--text-faint);
  font-size: 11.5px;
  line-height: 1.5;
}
.tag {
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--warn-soft);
  color: var(--warning);
  font-size: 10.5px;
  font-weight: 600;
}
.inventory-summary {
  margin: 0;
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1.6;
}
.inventory-group + .inventory-group {
  margin-top: 14px;
}
.inventory-group h5 {
  margin: 0 0 6px;
  color: var(--text-secondary);
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.03em;
}
.inventory-row {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}
.inventory-row:last-child {
  border-bottom: 0;
}
.status-dot {
  flex: none;
  width: 7px;
  height: 7px;
  margin-top: 5px;
  border-radius: 50%;
  background: var(--text-faint);
}
.status-dot.tone-ok {
  background: var(--success);
}
.status-dot.tone-warn {
  background: var(--warning);
}
.status-dot.tone-muted {
  background: var(--text-faint);
}
.inventory-copy {
  min-width: 0;
}
.inventory-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.inventory-title strong {
  font-size: 12.5px;
  font-weight: 600;
}
.inventory-title code {
  color: var(--text-faint);
  font-size: 11px;
}
.inventory-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 3px;
  color: var(--text-faint);
  font-size: 11px;
}
.inventory-desc {
  margin: 4px 0 0;
  color: var(--text-secondary);
  font-size: 11.5px;
  line-height: 1.5;
}
.empty-hint {
  margin: 8px 0;
  padding: 14px 12px;
  border: 1px dashed var(--border-strong);
  border-radius: 8px;
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1.6;
}
.card-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.action-hint {
  color: var(--text-faint);
  font-size: 11.5px;
  line-height: 1.5;
}
.faint {
  color: var(--text-faint);
}
.small {
  font-size: 11.5px;
}

@container (max-width: 560px) {
  .experimental-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
}

@media (max-width: 768px) {
  .card-head {
    flex-direction: column;
  }
  .panel-error {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
