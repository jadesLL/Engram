<template>
  <section class="settings-panel settings-native settings-group level-normal">
    <div class="group-card" :class="{ 'is-collapsed': groupCollapsed }">
      <div class="group-band collapsible" @click="onBandClick">
        <span class="group-ico" aria-hidden="true"><Icon name="refresh" :size="16" /></span>
        <span class="group-text">
          <span class="group-title">同步群组</span>
          <span class="group-hint">多台设备经中枢双向同步，成员之间无需互通</span>
        </span>
        <span v-if="roleBadge" class="group-badge" :class="'tone-' + roleBadgeTone">{{ roleBadge }}</span>
        <button
          type="button"
          class="group-caret"
          :aria-expanded="groupCollapsed ? 'false' : 'true'"
          :title="groupCollapsed ? '展开「同步群组」' : '收起「同步群组」'"
          @click.stop="toggleGroup"
        >
          <Icon name="chevron-down" :size="14" />
        </button>
      </div>
      <div v-show="!groupCollapsed" class="group-body">

        <!-- 运行状态摘要：一眼看出「正常不正常」，细节在「同步详情」独立窗口里 -->
        <div v-if="status && status.role !== 'none'" class="sync-summary">
          <div class="summary-line state-strip" :class="summaryHealthy ? 'tone-ok' : 'tone-warn'">
            <span class="state-dot" aria-hidden="true" />
            <strong :class="summaryHealthy ? 'ok' : 'bad'">{{ connectionLabel }}</strong>
            <span class="summary-detail">{{ summaryDetail }}</span>
          </div>
          <p v-if="status.lastError" class="sync-error">最近错误：{{ status.lastError }}</p>
          <div class="sync-summary-actions">
            <button class="btn" type="button" @click="openSyncLogDrawer">
              <Icon name="activity" :size="14" />
              查看同步详情
            </button>
          </div>
        </div>

        <!-- 未配置：二选一（「或」分隔，同一时刻只有一个主按钮） -->
        <template v-if="status && status.role === 'none'">
          <div class="role-choices">
            <div v-if="canBeHub" class="role-option">
              <strong>作为中枢</strong>
              <p>保存群组权威数据、生成绑定令牌；建议用常开的 NAS Docker 版。</p>
              <button class="btn" :class="{ primary: !pickJoin }" type="button" :disabled="saving" @click="becomeHub">
                作为中枢启用
              </button>
            </div>
            <span v-if="canBeHub" class="role-or" aria-hidden="true">或</span>
            <div class="role-option">
              <strong>绑定中枢</strong>
              <p>用邀请链接或地址 + 令牌加入已有群组；本机照常离线工作。</p>
              <button class="btn" type="button" @click="pickJoin = true">绑定中枢</button>
            </div>
          </div>

          <template v-if="pickJoin">
            <div class="setting-row setting-row-form">
              <div class="setting-copy">
                <strong>邀请链接</strong>
                <span>中枢「添加成员」里复制后粘贴，自动填好地址与令牌。</span>
              </div>
              <div class="setting-control sync-field">
                <input
                  id="sync-invite"
                  v-model="inviteText"
                  type="text"
                  placeholder="engram://join?hub=…&token=…"
                  spellcheck="false"
                  aria-label="邀请链接"
                  @input="applyInviteText()"
                />
              </div>
            </div>
            <div class="setting-actions sync-form-actions">
              <button class="btn ghost" type="button" @click="pasteInvite">粘贴</button>
              <button class="btn" type="button" :disabled="saving || !parseInviteLink(inviteText)" @click="pairInvite">
                {{ saving ? '配对中…' : '一键配对' }}
              </button>
              <button class="btn ghost" type="button" :disabled="saving" @click="scanning = true">
                <Icon name="scan" :size="14" />
                扫码
              </button>
            </div>
            <p v-if="!scanSupported" class="setting-note">{{ cameraScanSupport().reason }}</p>
            <p v-if="inviteNotice" class="setting-note" :class="inviteNoticeTone === 'bad' ? 'tone-danger' : 'tone-ok'">{{ inviteNotice }}</p>
            <p v-else class="setting-note">扫中枢屏幕上的二维码，或把邀请链接粘贴进来。</p>

            <div class="setting-row setting-row-form">
              <div class="setting-copy">
                <strong>中枢地址</strong>
                <span>已自动填好；换中枢需先解除绑定。</span>
              </div>
              <div class="setting-control sync-field">
                <input
                  id="sync-hub-url"
                  v-model="hubUrl"
                  type="text"
                  placeholder="http://192.168.x.x:18080"
                  spellcheck="false"
                  aria-label="中枢地址"
                />
              </div>
            </div>
            <div class="setting-row setting-row-form">
              <div class="setting-copy">
                <strong>绑定令牌</strong>
                <span>中枢「添加成员」时生成的那串。</span>
              </div>
              <div class="setting-control sync-field">
                <SecretField id="sync-hub-token" v-model="hubToken" placeholder="lsync_…" aria-label="绑定令牌" />
              </div>
            </div>
            <div v-if="capabilities.runtime === 'android-local'" class="setting-row setting-row-form">
              <div class="setting-copy">
                <strong>直连地址</strong>
                <span>局域网 / IPv6 地址，每行一个，可留空。</span>
              </div>
              <div class="setting-control sync-field">
                <textarea
                  id="sync-direct-urls"
                  v-model="directUrlsText"
                  rows="2"
                  placeholder="http://192.168.x.x:18080"
                  spellcheck="false"
                  aria-label="直连地址"
                />
              </div>
            </div>
            <div class="setting-actions sync-form-actions">
              <button class="btn primary" type="button" :disabled="saving" @click="joinHub">保存并绑定</button>
            </div>
          </template>
        </template>

        <!-- 中枢：群组管理 -->
        <template v-else-if="status && status.role === 'hub'">
          <p v-if="deviceNameLine" class="setting-note sync-device-name">{{ deviceNameLine }}</p>

          <div class="setting-row">
            <div class="setting-copy">
              <strong>成员绑定地址</strong>
              <span>别的设备在「绑定中枢」里填这里任一地址。</span>
            </div>
          </div>
          <ul v-if="hubAddresses.length" class="address-list">
            <li v-for="item in hubAddresses" :key="item.url" class="address-row">
              <span class="address-kind">{{ item.label }}</span>
              <code class="address-url">{{ item.url }}</code>
              <button class="btn ghost" type="button" @click="copy(item.url)">复制</button>
            </li>
          </ul>
          <p v-if="hubAddressNotice" class="setting-note tone-warn">{{ hubAddressNotice }}</p>
          <p v-if="hubSkippedNotice" class="setting-note">{{ hubSkippedNotice }}</p>

          <div v-if="lanAccessSupported" class="setting-row">
            <div class="setting-copy">
              <strong>允许局域网访问</strong>
              <span>开启后监听 0.0.0.0；Windows 可能问防火墙，选「专用网络」。</span>
            </div>
            <label class="switch-control">
              <input v-model="lanAccess" type="checkbox" :disabled="lanBusy" aria-label="允许局域网访问" @change="toggleLanAccess" />
              <span aria-hidden="true"></span>
            </label>
          </div>

          <div class="setting-row">
            <div class="setting-copy">
              <strong>群组成员</strong>
              <span>给每台设备起名并生成令牌；「邀请」出二维码与链接。</span>
            </div>
            <div class="setting-actions">
              <button class="btn primary" type="button" :disabled="creating" @click="addPeer">添加成员</button>
            </div>
          </div>
          <ul v-if="peers.length" class="peer-list">
            <li v-for="p in peers" :key="p.id" class="peer-row">
              <div class="peer-info">
                <strong>
                  <span class="dot" :class="p.online ? 'on' : 'off'" />{{ p.name }}
                </strong>
                <span class="peer-meta">
                  {{ p.online ? '在线' : '离线' }}
                  <template v-if="p.node_label && p.node_label !== p.name"> · 设备名 {{ p.node_label }}</template>
                  <template v-if="p.last_seen_at"> · 最近同步 {{ formatTime(p.last_seen_at) }}</template>
                </span>
                <span class="peer-token">
                  令牌
                  <SecretField mode="text" :value="p.token" copyable class="token-code-host" />
                </span>
              </div>
              <div class="peer-actions">
                <button class="btn ghost" type="button" @click="showPeerInvite(p)">邀请</button>
                <button class="btn ghost" type="button" @click="regenPeer(p)">重置令牌</button>
                <button class="text-action danger" type="button" @click="revokePeer(p)">移除</button>
              </div>
            </li>
          </ul>
          <p v-else class="setting-note">还没有成员；点「添加成员」生成第一台设备的绑定令牌。</p>

          <div v-if="newPeer" class="new-peer-block">
            <div class="setting-row">
              <div class="setting-copy">
                <strong>「{{ newPeer.name }}」绑定信息</strong>
                <span>把地址与令牌填到那台设备，或让它扫码。</span>
              </div>
            </div>
            <div class="setting-row setting-row-form">
              <div class="setting-copy">
                <strong>中枢地址</strong>
                <span v-if="hubAddresses.length > 1">共 {{ hubAddresses.length }} 条可用地址，选同网络那条。</span>
                <span v-else>成员设备要填的中枢地址。</span>
              </div>
              <div class="setting-control sync-field">
                <div class="copy-row">
                  <template v-if="primaryHubAddress">
                    <code>{{ primaryHubAddress }}</code>
                    <button class="btn ghost" type="button" @click="copy(primaryHubAddress)">复制</button>
                  </template>
                  <span v-else class="setting-value">暂无可用地址</span>
                </div>
              </div>
            </div>
            <div class="setting-row setting-row-form">
              <div class="setting-copy">
                <strong>绑定令牌</strong>
                <span>点令牌可展开完整值。</span>
              </div>
              <div class="setting-control sync-field">
                <div class="copy-row">
                  <SecretField mode="text" :value="newPeer.token" copyable class="token-code-host" />
                  <button class="btn ghost" type="button" @click="copy(newPeer.token)">复制</button>
                </div>
              </div>
            </div>
            <div v-if="hubAddresses.length > 1" class="setting-row setting-row-form">
              <div class="setting-copy">
                <strong>邀请链接地址</strong>
                <span>链接与二维码按这条地址生成。</span>
              </div>
              <div class="setting-control sync-field">
                <AppSelect
                  id="sync-invite-address"
                  v-model="inviteAddressUrl"
                  aria-label="邀请链接用的地址"
                  :options="inviteAddressOptions"
                />
              </div>
            </div>

            <div v-if="inviteLink" class="invite-block">
              <QrCode :text="inviteLink" :size="260" :alt="'邀请「' + newPeer.name + '」加入同步群组的二维码'" />
              <div class="invite-body">
                <strong>让「{{ newPeer.name }}」扫码或粘贴链接</strong>
                <p class="setting-note">手机端扫码，其他端把链接粘进「绑定中枢」。</p>
                <div class="setting-actions invite-actions">
                  <button class="btn" type="button" :disabled="inviteLoading" @click="copyInviteLink">
                    <Icon name="link" :size="14" />
                    复制邀请链接
                  </button>
                </div>
                <p class="setting-note">链接里含这枚令牌，只发给这一台设备。</p>
              </div>
            </div>
            <p v-else-if="inviteLoading" class="setting-note">正在生成配对链接与二维码…</p>
            <p v-else-if="inviteError" class="setting-note tone-danger">{{ inviteError }}</p>
            <p v-else class="setting-note">暂时没有可用的成员绑定地址：先在部署侧声明对外地址，或打开「允许局域网访问」。</p>

            <div class="setting-actions new-peer-footer">
              <button class="btn" type="button" @click="newPeer = null">我已保存，关闭</button>
            </div>
          </div>

          <div class="setting-actions sync-footer">
            <button class="btn danger" type="button" @click="leaveRole('none')">退出中枢角色</button>
          </div>
        </template>

        <!-- 成员：绑定与状态 -->
        <template v-else-if="status">
          <p v-if="deviceNameLine" class="setting-note sync-device-name">{{ deviceNameLine }}</p>
          <div class="setting-row setting-row-form">
            <div class="setting-copy">
              <strong>中枢地址</strong>
              <span>换中枢需先解除绑定再重新绑定。</span>
            </div>
            <div class="setting-control sync-field">
              <input id="sync-hub-url" v-model="hubUrl" type="text" spellcheck="false" aria-label="中枢地址" />
            </div>
          </div>
          <div class="setting-row setting-row-form">
            <div class="setting-copy">
              <strong>绑定令牌</strong>
              <span>不改就留空，保留原令牌。</span>
            </div>
            <div class="setting-control sync-field">
              <SecretField id="sync-hub-token" v-model="hubToken" :stored="status.hubToken" aria-label="绑定令牌" />
            </div>
          </div>
          <div v-if="capabilities.runtime === 'android-local'" class="setting-row setting-row-form">
            <div class="setting-copy">
              <strong>直连地址</strong>
              <span>局域网 / IPv6 地址，每行一个，可留空。</span>
            </div>
            <div class="setting-control sync-field">
              <textarea
                id="sync-direct-urls-member"
                v-model="directUrlsText"
                rows="2"
                placeholder="http://192.168.x.x:18080"
                spellcheck="false"
                aria-label="直连地址"
              />
            </div>
          </div>
          <div class="setting-actions sync-form-actions">
            <button class="btn" type="button" :disabled="reconciling" @click="reconcileNow">{{ reconciling ? '对账中…' : '立即全量对账' }}</button>
            <button class="btn primary" type="button" :disabled="saving" @click="saveBinding">保存修改</button>
          </div>
          <div class="setting-actions sync-footer">
            <button class="btn danger" type="button" @click="leaveRole('none')">解除绑定</button>
          </div>
        </template>

        <!-- 同步范围：必要语义压到每段 ≤2 行 -->
        <div v-if="status && status.role !== 'none'" class="sync-role-note">
          <p class="setting-note">同步范围：页面、附件图片、原始资料、证据账本、Agent 会话与任务看板、客户洞察记录；「设置」分类含模型配置与 API Key（明文随群组下发）。</p>
          <p class="setting-note">各端登录密码、绑定令牌等仍各端独立；同一页面两端同时改按字符级合并，无法合并时以最新修改为准。</p>
          <p v-if="capabilities.runtime === 'android-local'" class="setting-note">安卓端退到后台后最多再同步 5 分钟；回到前台立即对账。</p>
        </div>

      </div>
    </div>
  </section>

  <SettingsGroup
    class="settings-native"
    anchor="sync-content"
    title="同步内容"
    hint="每类内容单独开关；主页卡片与设置默认关闭"
    flush
  >
    <p class="setting-note sync-content-note">关闭后本机不再上传或接收该类内容，已同步的数据会保留。</p>
    <label
      v-for="item in syncCategoryItems"
      :key="item.key"
      class="setting-row setting-row-toggle sync-category-row"
    >
      <span class="setting-check">
        <input
          type="checkbox"
          :checked="categoryEnabled(item.key)"
          :disabled="saving || !status?.categories"
          :aria-label="item.label"
          @change="saveCategory(item.key, $event)"
        />
      </span>
      <div class="setting-copy">
        <strong>{{ item.label }}</strong>
        <span>{{ item.hint }}</span>
      </div>
      <span class="setting-value" :class="categoryEnabled(item.key) ? 'tone-ok' : 'is-muted'">
        {{ categoryEnabled(item.key) ? '已开启' : '已关闭' }}
      </span>
    </label>
  </SettingsGroup>

  <!-- 局域网优先：与「双栈连接」回答同一个问题的两半（先走哪条路），只在成员端有内容。 -->
  <SettingsGroup
    v-if="showLanGroup"
    class="settings-native"
    anchor="sync-lan"
    title="局域网优先"
    hint="同网段优先直连中枢的内网地址"
    :badge="lanBadge"
    :badge-tone="lanBadgeTone"
  >
    <div class="setting-row">
      <div class="setting-copy">
        <strong>优先局域网</strong>
        <span>同网段先试内网地址，探不到按中枢地址顺序连。</span>
      </div>
      <label class="switch-control">
        <input v-model="preferLan" type="checkbox" :disabled="saving" aria-label="优先局域网" @change="savePreferLan" />
        <span aria-hidden="true"></span>
      </label>
    </div>

    <!-- 实时状态（会变）走状态条：底框 + 状态点，与灰色说明文字区分开 -->
    <p class="lan-state state-strip" :class="lanChannelClass">
      <span class="state-dot" aria-hidden="true" />
      <span>{{ lanStateText }}</span>
    </p>

    <div class="lan-probes">
      <p class="lan-probes-title">候选地址探测记录</p>
      <ul v-if="lanCandidates.length" class="lan-probe-list">
        <li v-for="(item, index) in lanCandidates" :key="item.kind + '-' + item.url + '-' + index">
          <span class="lan-probe-kind">{{ item.label }}</span>
          <code class="lan-probe-url">{{ item.url }}</code>
          <span v-if="item.ok" class="lan-probe-ok">
            ✓ {{ typeof item.latencyMs === 'number' ? item.latencyMs + 'ms' : '可达' }}
          </span>
          <span v-else class="lan-probe-bad">✗ {{ item.error || '不可达' }}</span>
        </li>
      </ul>
      <p v-else class="setting-note">还没有探测记录：下一轮连接会先试局域网，再逐级降级。</p>
    </div>

    <p class="setting-note">优先级固定为 局域网 → IPv6 → IPv4；断开时照常读写，恢复后自动补齐。</p>
  </SettingsGroup>

  <!-- 双栈连接：2026-09-29 起独立成组（多端同步 → 双栈连接），只在本机作为成员连接中枢域名时才有内容。 -->
  <SettingsGroup
    v-if="showDualStack"
    class="settings-native"
    anchor="sync-dualstack"
    title="双栈连接（IPv6 优先）"
    hint="域名连接优先 IPv6，不通自动改用 IPv4"
    :badge="dualStackBadge"
    :badge-tone="dualStackBadgeTone"
  >
    <div class="dualstack-config">
      <div class="setting-row">
        <div class="setting-copy">
          <strong>启用双栈策略</strong>
          <span>关闭后由系统决定 IPv6 / IPv4；切换不打断传输。</span>
        </div>
        <label class="switch-control">
          <input v-model="dualStack.enabled" type="checkbox" aria-label="启用双栈策略" @change="saveDualStack(true)" />
          <span aria-hidden="true"></span>
        </label>
      </div>
      <!-- 实时状态（会变）走状态条：底框 + 状态点，与上面的灰色说明文字区分开（2026-09-27） -->
      <p v-if="dualStackStateText" class="dualstack-state state-strip" :class="dualStackTone">
        <span class="state-dot" aria-hidden="true" />
        <span>{{ dualStackStateText }}</span>
      </p>
      <div v-show="dualStack.enabled" class="dualstack-fields">
        <div class="setting-row">
          <div class="setting-copy">
            <strong>判定 IPv6 不通</strong>
            <span>连续失败次数或累计卡住秒数，任一满足即改用 IPv4。</span>
          </div>
          <div class="setting-actions ds-inputs">
            <input id="ds-failures" v-model.number="dualStack.failureThreshold" type="number" min="1" max="20" aria-label="连续失败次数" />
            <span class="ds-unit">次</span>
            <input id="ds-window" v-model.number="dualStack.windowSeconds" type="number" min="1" max="120" aria-label="累计卡住秒数" />
            <span class="ds-unit">秒</span>
          </div>
        </div>
        <div class="setting-row">
          <div class="setting-copy">
            <strong>回探节奏</strong>
            <span>IPv4 每成功 N 次回探一次 IPv6；单次连接超时 M 毫秒。</span>
          </div>
          <div class="setting-actions ds-inputs">
            <input id="ds-probe" v-model.number="dualStack.probeAfterSuccesses" type="number" min="1" max="1000" aria-label="回探间隔次数" />
            <span class="ds-unit">次</span>
            <input id="ds-timeout" v-model.number="dualStack.connectTimeoutMs" type="number" min="500" max="30000" step="500" aria-label="单次连接超时毫秒" />
            <span class="ds-unit">毫秒</span>
          </div>
        </div>
        <div class="setting-actions dualstack-actions">
          <button class="btn" type="button" :disabled="saving" @click="saveDualStack()">保存双栈设置</button>
        </div>
      </div>
    </div>
  </SettingsGroup>

  <!-- DDNS 直连域名：只在「这台设备担任中枢」时才有内容，同一条件登记进导航（useSettingsAnchorVisible）。 -->
  <SettingsGroup
    v-if="showDdns"
    class="settings-native"
    anchor="sync-ddns"
    title="DDNS 直连域名"
    hint="只有中枢可开：用域名指向本机公网地址"
  >
    <DdnsSection :active="active" />
  </SettingsGroup>

  <!-- 扫码浮层（挂到 body）：只在本机「绑定中枢」时出现，扫到内容后由 onScanResult 解析并回填 -->
  <QrScannerOverlay
    :open="scanning"
    title="扫码绑定中枢"
    hint="把中枢屏幕上「添加成员 / 邀请」里的二维码放进取景框，识别后会自动填好中枢地址与绑定令牌"
    @close="scanning = false"
    @result="onScanResult"
  />
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { api } from '../../api';
import { promptDialog } from '../../lib/confirm';
import { notify } from '../../lib/notify';
import DdnsSection from './DdnsSection.vue';
import Icon from '../Icon.vue';
import SettingsGroup from './SettingsGroup.vue';
import AppSelect from '../ui/AppSelect.vue';
import QrCode from '../ui/QrCode.vue';
import QrScannerOverlay from '../ui/QrScannerOverlay.vue';
import { useSettingsBadge } from '../../lib/settingsBadges';
import { useSettingsAnchorVisible } from '../../lib/settingsNavVisibility';
import { expandGroup, isGroupCollapsed, toggleGroupCollapsed } from '../../lib/settingsCollapse';
import { copyText } from '../../lib/contextMenu';
import { openSyncLogDrawer } from '../../lib/syncLog';
import { syncChannelView, type SyncLinkStatus } from '../../lib/syncChannel';
import {
  bindingAddresses,
  primaryBindingAddress,
  hubAddressNotice as hubAddressNoticeText,
  hubSkippedNotice as hubSkippedNoticeText,
  type HubAddressReport,
} from '../../lib/hubAddress';
import { buildInviteLink, describeInvite, parseInviteLink } from '../../lib/syncInvite';
import { cameraScanSupport } from '../../lib/qrScan';
import { pendingJoinLink, takePendingJoinLink } from '../../lib/joinLink';
import SecretField from '../SecretField.vue';
import { useRuntimeCapabilities } from '../../lib/capabilities';
import { useSyncStore } from '../../stores/sync';
import { useServerUpdateStore } from '../../stores/serverUpdate';

interface PeerView {
  id: string;
  name: string;
  node_label: string;
  online: boolean;
  last_seen_at: string | null;
  last_seq: number;
  created_at: string;
  token: string;
}

interface SyncLogEntry {
  ts: string;
  level: string;
  event: string;
  detail?: string;
}

interface SyncStatus {
  categories?: Record<string, boolean>;
  role: 'hub' | 'member' | 'none';
  enabled: boolean;
  connected: boolean;
  /** 首次接入引导（全量对账 + 补拉）仍在进行 */
  syncing?: boolean;
  /** 全量对账正在执行（首次接入 / 手动触发 / 周期自愈） */
  reconciling?: boolean;
  running?: boolean;
  hubUrl: string;
  hubToken: string;
  directUrls?: string[];
  nodeId: string;
  /**
   * 本机在同步群组里的显示名：成员端取**中枢配置里的成员名**（对账时学回来），中枢端是「中枢」；
   * source 说明这个值是哪来的，界面据此注明「按中枢配置」还是「还没连上中枢，暂时显示电脑名」。
   */
  deviceLabel?: string;
  deviceLabelSource?: 'member-config' | 'hub' | 'hostname';
  cursor: number;
  /** 中枢端的权威 revision 序号（成员端为 0） */
  revision?: number;
  pending: number;
  pendingPulls: number;
  lastSyncAt: string | null;
  lastError: string | null;
  /** 双栈连接：当前配置 + 每个中枢域名的实时协议族（服务端与 Android 本地版同一套字段） */
  dualStack?: DualStackStatus;
  /** 连接通道明细（局域网 / IPv6 / IPv4 / 已断开 + 候选探测结果）：成员端才有 */
  link?: SyncLinkStatus | null;
  log: SyncLogEntry[];
  peers: PeerView[];
}

interface DualStackHost {
  host: string;
  family: number;
  familyLabel: string;
  consecutiveFailures: number;
  failureMs: number;
  ipv4Successes: number;
  probePending: boolean;
  switchedAt: string | null;
  reason: string | null;
}

interface DualStackStatus {
  enabled: boolean;
  failureThreshold: number;
  failureWindowMs: number;
  probeAfterSuccesses: number;
  connectTimeoutMs: number;
  hosts: DualStackHost[];
}

const location = window.location;
const { capabilities, load: loadCapabilities } = useRuntimeCapabilities();
const canBeHub = computed(() => capabilities.value.syncRoles.includes('hub'));
const status = ref<SyncStatus | null>(null);
const syncCategoryItems = [
  { key: 'homeCards', label: '主页卡片', hint: '卡片种类、顺序和尺寸；默认关闭。' },
  { key: 'settings', label: '设置', hint: '主题、编辑模式、同义词、AI 工作区偏好，含内置 Agent 模型配置与相关 API Key（明文随群组下发）；默认关闭。' },
  { key: 'knowledge', label: '知识库内容', hint: '知识页面、普通附件和收集箱。' },
  { key: 'materials', label: '原始资料', hint: '文档、对话与灵感碎片。' },
  { key: 'customerResearch', label: '客户洞察', hint: '调研记录、报告正文与流程模板；默认开启。' },
  { key: 'assets', label: '图片资产', hint: '页面引用的图片文件。' },
  { key: 'aiWorkspace', label: 'AI 工作区', hint: '自动生成的日志、索引和关系库。' },
  { key: 'sessions', label: '会话', hint: '已完成的 Agent 会话（手机端直接访问中枢会话）。' },
  { key: 'board', label: '任务看板', hint: '最新提炼的任务看板（手机端直接访问中枢看板）。' },
];
function categoryEnabled(key: string): boolean {
  return status.value?.categories?.[key] ?? !['homeCards', 'settings'].includes(key);
}
async function saveCategory(key: string, event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  await postConfig({ categories: { [key]: input.checked } }, '已保存同步内容开关');
  input.checked = categoryEnabled(key);
}
const peers = ref<PeerView[]>([]);
const pickJoin = ref(false);
const hubUrl = ref('');
const hubToken = ref('');
const directUrlsText = ref('');
const saving = ref(false);
const creating = ref(false);
const reconciling = ref(false);
const newPeer = ref<(PeerView & { token: string }) | null>(null);

/**
 * 成员绑定地址（`/api/sync/hub-addresses` 算好的可达地址清单）：中枢面板的显示与复制都用它。
 *
 * 旧实现直接显示 `location.origin`：桌面版的内嵌服务只监听 127.0.0.1、页面永远开在
 * http://127.0.0.1:18180 上，于是中枢给出去的地址就是 127.0.0.1——别的设备填了必然连不上。
 */
const hubAddress = ref<HubAddressReport | null>(null);
/** 桌面端壳的桥：只有它有「允许局域网访问」开关（浏览器打开的页面没有这个桥） */
const lanBridge = (window as any).wikiDesktop;
const lanAccessSupported = computed(() => Boolean(lanBridge && typeof lanBridge.getLanAccess === 'function'));
const lanAccess = ref(false);
const lanBusy = ref(false);
const dualStack = ref({ enabled: true, failureThreshold: 3, windowSeconds: 15, probeAfterSuccesses: 10, connectTimeoutMs: 5000 });
/** 表单只在首次拿到状态（或保存后）回填：状态每 5 秒轮询，不能把用户正在改的数字冲掉 */
const dualStackLoaded = ref(false);
let pollTimer: number | null = null;

/**
 * 「本机名称」一行：显示名不取电脑主机名——成员端用中枢在「添加成员」时给这台设备起的
 * 成员名，中枢端固定是「中枢」。还没连上中枢（学不到名字）时说明这一行暂时是电脑名，
 * 免得用户以为「我改了成员名怎么没生效」。
 */
const deviceNameLine = computed(() => {
  const name = status.value?.deviceLabel;
  if (!name) return '';
  const source = status.value?.deviceLabelSource;
  if (source === 'member-config') return `本机名称：${name}（按中枢配置的成员名）`;
  if (source === 'hub') return `本机名称：${name}（本设备就是中枢）`;
  return `本机名称：${name}（还没连上中枢：先显示电脑名）`;
});

/** 可用的成员绑定地址（服务端已排序：局域网在前、公网在后）与主地址 */
const hubAddresses = computed(() => bindingAddresses(hubAddress.value));
const primaryHubAddress = computed(() => primaryBindingAddress(hubAddress.value));
/** 一条地址都没有时的说明（桌面端提示怎么开局域网访问）；有地址时为空 */
const hubAddressNotice = computed(() => hubAddressNoticeText(hubAddress.value, { desktop: lanAccessSupported.value }));
/** 回环地址被剔除时的说明：让用户明白「为什么这里不再是 127.0.0.1」 */
const hubSkippedNotice = computed(() => hubSkippedNoticeText(hubAddress.value));

// ---------------------------------------------------------------- 邀请链接（二维码 / 复制 / 粘贴 / 扫码）
//
// 绑定要填「中枢地址 + 54 位绑定令牌」，手抄最容易错。中枢把两者拼成一条 engram://join?… 链接：
// 手机扫二维码、其他端复制链接发过去粘贴，两种方式二选一（见 lib/syncInvite 的格式说明）。

/** 邀请链接里用的中枢地址：默认主地址，中枢有多条可达地址（局域网 + 域名）时才让用户挑 */
const inviteAddressUrl = ref('');
const inviteAddressOptions = computed(() => hubAddresses.value.map((item) => ({
  value: item.url,
  label: `${item.label} · ${item.url}`,
})));
const inviteHubUrl = computed(() => {
  const chosen = inviteAddressUrl.value;
  // 地址清单会随网络变化刷新：选过的那条不在了就回退到主地址，不拼一条已经不存在的地址
  if (chosen && hubAddresses.value.some((item) => item.url === chosen)) return chosen;
  return primaryHubAddress.value;
});
/** 当前展示中的成员邀请链接；没有可用地址时为 ''，界面据此说明原因而不是画一张空码 */
const inviteLink = ref('');
const inviteLoading = ref(false);
const inviteError = ref('');
let inviteRequest = 0;
watch([newPeer, inviteHubUrl], async () => {
  const request = ++inviteRequest;
  inviteLink.value = '';
  inviteError.value = '';
  inviteLoading.value = false;
  if (!newPeer.value || !inviteHubUrl.value) return;
  inviteLoading.value = true;
  try {
    const { data } = await api.post(`/api/sync/peers/${newPeer.value.id}/invite`, {
      hub_url: inviteHubUrl.value, origin: location.origin,
    });
    if (request === inviteRequest) inviteLink.value = data.link || '';
  } catch (error: any) {
    if (request === inviteRequest) inviteError.value = error?.response?.data?.error || '生成邀请失败，请重试';
  } finally {
    if (request === inviteRequest) inviteLoading.value = false;
  }
});

/** 成员端：粘贴/扫码拿到的链接原文，以及解析结果提示 */
const inviteText = ref('');
const inviteNotice = ref('');
const inviteNoticeTone = ref<'ok' | 'bad'>('ok');
const scanning = ref(false);
/** 当前打开方式能不能调摄像头：浏览器只允许 https / localhost 用摄像头（局域网 http 页面调不了） */
const scanSupported = cameraScanSupport().supported;

// 设置页二级导航的状态徽标：一眼看出本机是中枢、成员还是尚未参与同步
useSettingsBadge(
  'panel-sync',
  computed(() => {
    const role = status.value?.role;
    if (role === 'hub') return `中枢 · ${peers.value.length} 成员`;
    if (role === 'member') return '已绑定';
    return '未配置';
  }),
);

/** DDNS 直连域名：中枢专属（只有中枢能把自己的公网 IP 写进域名），且服务端要开着 DDNS 能力 */
const showDdns = computed(() => status.value?.role === 'hub' && capabilities.value.features.ddns);
// 与上面的渲染条件同源：非中枢设备不该在导航里看到「DDNS 直连域名」
useSettingsAnchorVisible('sync-ddns', showDdns);

/**
 * 双栈连接：单独一个分组，只在本机作为成员连中枢域名时才有内容（协议族策略用在这条链路上），
 * 中枢与尚未绑定的设备都不显示——与 DDNS 分组刚好互补，两边同屏只会出现一个。
 */
const showDualStack = computed(() => status.value?.role === 'member');
// 与上面的渲染条件同源：非成员设备不该在导航里看到「双栈连接」
useSettingsAnchorVisible('sync-dualstack', showDualStack);

/**
 * 局域网优先：与双栈连接回答同一个问题的两半（先走哪条路），同样只在成员端有内容。
 * 单独一个 computed（而不是复用 showDualStack）是因为渲染条件必须能被显隐登记读走，
 * 而且将来两边条件要是分岔了（比如只在服务端通告了内网地址时才显示），改这里不影响双栈。
 *
 * 还要求 status.link 存在：Android 本地端的引擎（Kotlin）还没实现这个开关，
 * 它只认自己的 direct_urls 兜底——那边渲染出来会是一个点了没用的开关，
 * 不如整组不出现（导航项由 useSettingsAnchorVisible 一起收起，不留死锚点）。
 */
const showLanGroup = computed(() => Boolean(status.value?.role === 'member' && status.value?.link));
useSettingsAnchorVisible('sync-lan', showLanGroup);

/** 「优先局域网」开关：初值取服务端，改动即落盘 */
const preferLan = ref(true);
/** 开关只在首次拿到状态（或保存后）回填：状态每 5 秒轮询，不能把用户刚点的值冲回去 */
const preferLanLoaded = ref(false);

/**
 * 当前通道（`lib/syncChannel` 与侧栏胶囊、首页状态条同一份翻译）：
 * 徽标与状态条都读它，避免「设置页说 IPv4、侧栏说局域网」这种自相矛盾。
 */
const lanChannel = computed(() => syncChannelView(status.value));

const lanBadge = computed(() => lanChannel.value?.label || '待探测');

/** 徽标语气沿用现有 badgeTone 约定：局域网=强调色、IPv6=好、IPv4=留意、断开=危险，未知=中性 */
const lanBadgeTone = computed<'accent' | 'ok' | 'warn' | 'danger' | 'muted'>(() => {
  switch (lanChannel.value?.key) {
    case 'lan': return 'accent';
    case 'ipv6': return 'ok';
    case 'ipv4': return 'warn';
    case 'offline': return 'danger';
    default: return 'muted';
  }
});

/** 状态条的状态点跟着通道走（.link-<key> 给的 --channel，与胶囊同一颗颜色） */
const lanChannelClass = computed(() => `link-${lanChannel.value?.key || 'connected'}`);

const lanCandidates = computed(() => status.value?.link?.candidates || []);

/** 状态条一句话：现在走哪条路、走的是哪个地址、延迟多少；断开与还没探测各有说法 */
const lanStateText = computed(() => {
  const link = status.value?.link;
  if (!link) return '这台设备还没有连接通道明细（本机直连模式），按最近一轮是否跑完判定同步状态。';
  const current = lanChannel.value;
  if (link.channel === 'offline' || !current) {
    return '当前所有候选地址都不可达，正在自动重连；本机改动照常保存，恢复后自动补齐。';
  }
  const bits = [`当前走 ${current.label}`];
  if (link.host) bits.push(link.host);
  if (typeof link.latencyMs === 'number') bits.push(`延迟 ${link.latencyMs}ms`);
  return bits.join(' · ');
});

// 分组卡片色带上的角色徽标（与导航徽标同源）
const roleBadge = computed(() => {
  const role = status.value?.role;
  if (role === 'hub') return '中枢';
  if (role === 'member') return '已绑定';
  return '未配置';
});
const roleBadgeTone = computed<'ok' | 'accent' | 'warn'>(() => {
  const role = status.value?.role;
  if (role === 'hub') return 'ok';
  if (role === 'member') return 'accent';
  return 'warn';
});

// 分组折叠：与 SettingsGroup 共用一份持久化状态（锚点 id 在外层包裹 div 上）
const GROUP_ANCHOR = 'panel-sync';
const groupCollapsed = computed(() => isGroupCollapsed(GROUP_ANCHOR));
function toggleGroup() {
  toggleGroupCollapsed(GROUP_ANCHOR);
}
function onBandClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null;
  if (target?.closest('button, a, input, select, textarea, label')) return;
  toggleGroup();
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/** 服务器更新中：本机服务器（Docker）或远程同步中枢在重建时，连接摘要统一说「服务器更新中」 */
const serverUpdate = useServerUpdateStore();

const connectionLabel = computed(() => {
  // 服务器更新中：先于各角色回答「为什么现在连不上/在更新」，避免显示过期的「已连接」
  if (serverUpdate.updating) return serverUpdate.target === 'hub' ? '同步服务器更新中' : '服务器更新中';
  // 中枢不主动连别人（members 连它），connected 恒为 false：这里按角色说话，
  // 否则中枢设置页会顶着一行红字「未连接」，与「中枢运行中」的徽标自相矛盾
  if (status.value?.role === 'hub') return '中枢运行中';
  if (capabilities.value.runtime !== 'android-local') {
    if (!status.value?.connected) return '未连接';
    // 首次接入要先把整库对账拉全、再从水位补拉，可能持续数分钟：这期间中枢已连上、
    // 内容正在进来，只显示「未连接」会让用户以为没生效（重启后水位已推进才变正常）
    return status.value?.syncing ? '已连接 · 首次同步中' : '已连接';
  }
  if (status.value?.running) return '同步中';
  return status.value?.connected ? '已同步并断开' : '尚未成功';
});

/** 摘要行的绿/红点：中枢只要在跑就是正常；成员看连接状态（对账中不算异常） */
const summaryHealthy = computed(() => {
  // 更新是主动动作：这段中断不算异常，摘要行的点不该变红
  if (serverUpdate.updating) return true;
  const current = status.value;
  if (!current) return false;
  if (current.role === 'hub') return true;
  return Boolean(current.connected || current.reconciling || current.syncing);
});

/** 一行摘要：成员看队列与最近一次同步，中枢看成员在线数与权威水位；细节都在「同步详情」里 */
const summaryDetail = computed(() => {
  const current = status.value;
  if (!current) return '';
  if (current.role === 'hub') {
    const online = peers.value.filter((peer) => peer.online).length;
    // 中枢端 cursor 是成员端的水位（中枢恒为 0），权威发号要看 revision
    const revision = current.revision ?? current.cursor;
    return `· 成员 ${peers.value.length}（在线 ${online}）· 权威水位 ${revision}`;
  }
  const parts = [`待推送 ${current.pending}`];
  if (current.pendingPulls) parts.push(`待补拉 ${current.pendingPulls}`);
  parts.push(current.lastSyncAt ? `最近同步 ${formatTime(current.lastSyncAt)}` : '还没有成功同步过');
  return `· ${parts.join(' · ')}`;
});

async function copy(text: string): Promise<void> {
  if (await copyText(text)) notify.success('已复制');
  else notify.error('复制失败，请手动选择复制');
}

/** 复制邀请链接：一句话说清「这条链接拿去干什么」（与上面通用复制的提示区分开） */
async function copyInviteLink(): Promise<void> {
  const link = inviteLink.value;
  if (!link) return;
  try {
    if (!await copyText(link)) throw new Error('copy failed');
    notify.success('配对链接已复制：在子端点「一键配对」，或点击链接打开 Engram');
  } catch {
    notify.error('复制失败：请在成员列表里复制令牌，手动填到那台设备上');
  }
}

/** 成员端：解析输入框里的邀请链接并回填中枢地址与令牌；返回是否解析成功 */
function applyInviteText(): boolean {
  const raw = inviteText.value.trim();
  if (!raw) {
    inviteNotice.value = '';
    return false;
  }
  const invite = parseInviteLink(raw);
  if (!invite) {
    // 手输过程中的半截内容不算错误（本来就不像链接）；只有「看着像链接却解析不出来」才报错
    if (/engram|:\/\//i.test(raw)) {
      inviteNoticeTone.value = 'bad';
      inviteNotice.value = '这看起来不是 Engram 邀请链接：正确的以 engram://join? 开头，在中枢那台设备上点「复制邀请链接」再发过来。';
    } else {
      inviteNotice.value = '';
    }
    return false;
  }
  hubUrl.value = invite.hubUrl;
  hubToken.value = invite.token;
  inviteNoticeTone.value = 'ok';
  inviteNotice.value = `已识别：${describeInvite(invite)}。点击「一键配对」即可验证并绑定。`;
  return true;
}

/** 粘贴按钮：读剪贴板（浏览器可能要求用户授权，失败时提示手动长按粘贴） */
async function pasteInvite(): Promise<void> {
  try {
    const text = await navigator.clipboard.readText();
    if (!text.trim()) {
      notify.info('剪贴板里没有内容');
      return;
    }
    inviteText.value = text.trim();
    applyInviteText();
  } catch {
    notify.error('读不到剪贴板：请长按上面的输入框手动粘贴');
  }
}

/** 扫码结果：扫到的可能不是 Engram 的邀请链接（对着别的二维码扫了），两种结果分开提示 */
function onScanResult(text: string): void {
  scanning.value = false;
  inviteText.value = String(text || '').trim();
  if (applyInviteText()) void pairInvite();
  else notify.error('扫到的内容不是 Engram 邀请链接');
}

/** 成员列表的「邀请」按钮：把这台设备的绑定信息（含二维码）重新摊开 */
function showPeerInvite(peer: PeerView): void {
  newPeer.value = { ...peer, token: peer.token };
}

/**
 * 安卓「点链接打开应用」进来的邀请链接：填进「绑定中枢」表单并展开它。
 * 已经参与同步的设备不静默改写配置——换中枢要先解除绑定/退出中枢角色，这里只给一句明确提示。
 */
function applyPendingJoinLink(): void {
  const raw = takePendingJoinLink();
  if (!raw) return;
  const role = status.value?.role;
  if (role && role !== 'none') {
    notify.info('收到邀请链接：这台设备已参与同步群组，需先「解除绑定」/「退出中枢角色」再绑定新中枢');
    return;
  }
  pickJoin.value = true;
  expandGroup(GROUP_ANCHOR);
  inviteText.value = raw;
  if (applyInviteText()) void pairInvite();
  else notify.error('这条链接不是有效的 Engram 邀请链接');
}

async function loadStatus(): Promise<void> {
  try {
    const res = await api.get('/api/sync/status');
    status.value = res.data;
    peers.value = res.data.peers || [];
    syncDualStackForm();
    syncLanForm();
    await loadHubAddresses();
  } catch { /* 服务未就绪时忽略 */ }
}

/**
 * 拉取成员绑定地址（只有当中枢时才需要）。
 *
 * 带上设置页自己的 origin：Docker 版常用局域网 IP 打开，那条地址本身就是成员能用的；
 * 桌面版的 origin 是 127.0.0.1，服务端会剔除并在 skippedLoopback 里说明。
 * 取不到（老服务端没有这个接口）时保持 null：界面显示「暂无可用地址 + 说明」，
 * 绝不退回 location.origin——那正是这个 bug 的来源。
 */
async function loadHubAddresses(): Promise<void> {
  if (status.value?.role !== 'hub') {
    hubAddress.value = null;
    return;
  }
  try {
    const res = await api.get('/api/sync/hub-addresses', { params: { origin: location.origin } });
    hubAddress.value = res.data?.ok ? (res.data as HubAddressReport) : null;
  } catch {
    hubAddress.value = null;
  }
}

/** 读桌面端「允许局域网访问」开关（浏览器打开的页面没有这个桥，什么都不做） */
async function loadLanAccess(): Promise<void> {
  if (!lanAccessSupported.value) return;
  try {
    const r = await lanBridge.getLanAccess();
    lanAccess.value = Boolean(r?.enabled);
  } catch { /* 桥异常时按关闭显示 */ }
}

/** 开关局域网访问：config.json 落盘后本地服务以新监听地址重启（窗口会重新加载） */
async function toggleLanAccess(): Promise<void> {
  if (!lanAccessSupported.value) return;
  const want = lanAccess.value;
  lanBusy.value = true;
  try {
    const r = await lanBridge.setLanAccess(want);
    if (r?.error) {
      lanAccess.value = !want;
      notify.error(r.error);
      return;
    }
    notify.success(want
      ? '已开启局域网访问：本地服务正在以 0.0.0.0 重启，随后这里会列出局域网地址'
      : '已关闭局域网访问：本地服务回到 127.0.0.1（只有本机能连）');
  } catch (e: any) {
    lanAccess.value = !want;
    notify.error('切换失败：' + (e?.message || e));
  } finally {
    lanBusy.value = false;
  }
}

/** 回填「优先局域网」（force=true 用于保存成功后按服务端结果刷新） */
function syncLanForm(force = false): void {
  const link = status.value?.link;
  if (!link || (preferLanLoaded.value && !force)) return;
  preferLan.value = link.preferLan !== false;
  preferLanLoaded.value = true;
}

/** 开关改动即落盘：这是「换一条路」的偏好，不是要填完一屏再保存的表单 */
async function savePreferLan(): Promise<void> {
  const next = preferLan.value;
  const ok = await postConfig(
    { prefer_lan: next },
    next ? '已开启：优先用局域网地址' : '已关闭：局域网地址不再优先',
  );
  if (ok) syncLanForm(true);
  // 失败要滚回服务端的值：开关停在用户点的那一侧会与实际配置不一致（loadStatus 失败时状态仍是旧的）
  else preferLan.value = status.value?.link?.preferLan !== false;
}

/** 回填双栈表单（force=true 用于保存成功后按服务端归一化结果刷新） */
function syncDualStackForm(force = false): void {
  const ds = status.value?.dualStack;
  if (!ds || (dualStackLoaded.value && !force)) return;
  dualStack.value = {
    enabled: ds.enabled !== false,
    failureThreshold: ds.failureThreshold,
    windowSeconds: Math.max(1, Math.round(ds.failureWindowMs / 1000)),
    probeAfterSuccesses: ds.probeAfterSuccesses,
    connectTimeoutMs: ds.connectTimeoutMs,
  };
  dualStackLoaded.value = true;
}

/** 双栈现状一句话：当前走哪一族、还差几次回探 */
const dualStackStateText = computed(() => {
  const ds = status.value?.dualStack;
  if (!ds) return '';
  if (!ds.enabled) return '已关闭：域名连接交回系统默认（由操作系统排序 IPv6/IPv4）。';
  if (!ds.hosts.length) return '还没有连过中枢域名：下一个请求会先试 IPv6，连不上会自动改用 IPv4。';
  return ds.hosts.map((host) => {
    if (host.family === 6) {
      const pending = host.consecutiveFailures > 0 ? `（IPv6 已连续失败 ${host.consecutiveFailures} 次，达 ${ds.failureThreshold} 次改用 IPv4）` : '';
      return `${host.host}：正在用 IPv6${pending}`;
    }
    // 本机网络根本没有 IPv6 出口（安卓端会这么写）：回探要等换到有 IPv6 的网络，别让用户以为
    // 「再成功 N 次就会回探」——那种网络里回探也只会再撞一次 IPv6 超时。
    if (host.reason === '本机当前网络没有 IPv6 出口') {
      return `${host.host}：正在用 IPv4（本机当前网络没有 IPv6 出口：Wi-Fi 未下发 IPv6，或 VPN / 代理只转发 IPv4；`
        + '连上支持 IPv6 的网络后，下一个请求就按 IPv6 优先）';
    }
    const remaining = Math.max(0, ds.probeAfterSuccesses - host.ipv4Successes);
    return `${host.host}：正在用 IPv4（${host.reason || 'IPv6 连不上'}；IPv4 已成功 ${host.ipv4Successes} 次，`
      + `${host.probePending ? '下一次请求回探 IPv6' : `再成功 ${remaining} 次回探一次 IPv6`}）`;
  }).join('；');
});

/**
 * 双栈状态条的语气：正在走 IPv6 = 正常；已切到 IPv4 = 需要留意（回探会自己切回来）；
 * 关掉策略、或还没连过中枢域名 = 中性（不是故障）。
 */
const dualStackTone = computed(() => {
  const ds = status.value?.dualStack;
  if (!ds || !ds.enabled || !ds.hosts.length) return 'tone-muted';
  return ds.hosts.some((host) => host.family === 4) ? 'tone-warn' : 'tone-ok';
});

/**
 * 色带上的协议族徽标：收起后正文整段藏起来，靠它一眼看出现在走哪一族、策略有没有关
 * （语气与状态条同源，复用全局 .group-badge 的 tone-* 配色）。
 */
const dualStackBadge = computed(() => {
  const ds = status.value?.dualStack;
  if (!ds) return '';
  if (!ds.enabled) return '已关闭';
  if (!ds.hosts.length) return '待首次连接';
  return ds.hosts.some((host) => host.family === 4) ? '当前 IPv4' : '当前 IPv6';
});

/** 分组徽标的语气：与状态条同源，只是换成 SettingsGroup 的 badgeTone 取值（没有 tone- 前缀） */
const dualStackBadgeTone = computed<'muted' | 'ok' | 'warn'>(() => {
  if (dualStackTone.value === 'tone-warn') return 'warn';
  if (dualStackTone.value === 'tone-ok') return 'ok';
  return 'muted';
});

async function saveDualStack(auto = false): Promise<void> {
  const payload = {
    enabled: dualStack.value.enabled,
    failureThreshold: Number(dualStack.value.failureThreshold) || 3,
    failureWindowMs: Math.round((Number(dualStack.value.windowSeconds) || 15) * 1000),
    probeAfterSuccesses: Number(dualStack.value.probeAfterSuccesses) || 10,
    connectTimeoutMs: Number(dualStack.value.connectTimeoutMs) || 5000,
  };
  const message = auto
    ? (payload.enabled ? '双栈连接已开启：优先 IPv6，连不上自动用 IPv4' : '双栈连接已关闭：域名连接交回系统默认')
    : '双栈设置已保存';
  if (await postConfig({ dual_stack: payload }, message)) syncDualStackForm(true);
}

async function postConfig(body: Record<string, unknown>, okMsg: string): Promise<boolean> {
  saving.value = true;
  try {
    const res = await api.post('/api/sync/config', body);
    if (res.data?.ok) {
      notify.success(okMsg);
      await loadStatus();
      await useSyncStore().refresh();
      // Android 是否可用服务器 Agent 取决于成员绑定；保存后立即刷新能力，
      // 不要求用户杀进程或重新打开 WebView。
      await loadCapabilities(true);
      return true;
    }
    return false;
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '保存失败');
    return false;
  } finally {
    saving.value = false;
  }
}

async function becomeHub(): Promise<void> {
  if (!canBeHub.value) return;
  if (await postConfig({ role: 'hub' }, '已启用中枢角色，快去添加成员吧')) {
    pickJoin.value = false;
  }
}

async function joinHub(): Promise<void> {
  if (!hubUrl.value.trim() || !hubToken.value.trim()) {
    notify.error('请填写中枢地址与绑定令牌');
    return;
  }
  if (await postConfig({ role: 'member', enabled: true, hub_url: hubUrl.value.trim(), hub_token: hubToken.value.trim(), direct_urls: parsedDirectUrls() }, '绑定成功，正在连接中枢并同步')) {
    pickJoin.value = false;
  }
}

/** 输入链接点一次配对；扫码/系统链接共用此接口，远端验证成功后才保存。 */
async function pairInvite(): Promise<void> {
  if (saving.value) return;
  const invite = parseInviteLink(inviteText.value);
  if (!invite) { notify.error('请输入有效的 Engram 邀请链接'); return; }
  saving.value = true;
  try {
    const { data } = await api.post('/api/sync/pairing/join', { link: buildInviteLink(invite) });
    if (!data?.ok) throw new Error('中枢未确认配对');
    inviteText.value = '';
    hubToken.value = '';
    inviteNotice.value = '';
    pickJoin.value = false;
    hubUrl.value = data.hubUrl;
    await loadStatus();
    await useSyncStore().refresh();
    await loadCapabilities(true);
    notify.success(`已与中枢配对${data.name ? `，本机为「${data.name}」` : ''}，正在同步`);
  } catch (error: any) {
    inviteNoticeTone.value = 'bad';
    inviteNotice.value = error?.response?.data?.error || '配对失败，请检查网络后重试';
    notify.error(inviteNotice.value);
  } finally { saving.value = false; }
}

async function saveBinding(): Promise<void> {
  const body: Record<string, unknown> = { role: 'member', enabled: true, hub_url: hubUrl.value.trim(), direct_urls: parsedDirectUrls() };
  if (hubToken.value.trim()) body.hub_token = hubToken.value.trim();
  if (await postConfig(body, '已保存')) {
    hubToken.value = '';
  }
}

function parsedDirectUrls(): string[] {
  return directUrlsText.value.split(/[\n,，]+/).map((item) => item.trim()).filter(Boolean);
}

async function leaveRole(target: 'none'): Promise<void> {
  const wasHub = status.value?.role === 'hub';
  if (await postConfig({ role: target }, target === 'none' ? '已退出，不再参与多端同步' : '已更新')) {
    hubToken.value = '';
    // 退出中枢就顺手关掉局域网访问：那扇门只为「这台电脑当中枢」而开，留在 0.0.0.0 上没人会记得关。
    // 关掉会重启内嵌服务，页面随即重新加载（角色已落盘，回来就是「未配置」）。
    if (wasHub && lanAccessSupported.value && lanAccess.value) {
      lanBusy.value = true;
      try {
        const r = await lanBridge.setLanAccess(false);
        if (r?.error) notify.error(`已退出中枢，但局域网访问没能关闭：${r.error}`);
        else lanAccess.value = false;
      } catch (e: any) {
        notify.error('已退出中枢，但局域网访问没能关闭：' + (e?.message || e));
      } finally {
        lanBusy.value = false;
      }
    }
  }
}

async function addPeer(): Promise<void> {
  const name = await promptDialog({
    title: '添加成员',
    message: '成员名称（对应一台设备，如「B 电脑」）',
    placeholder: 'B 电脑',
  });
  const trimmed = String(name || '').trim();
  if (!trimmed) return;
  creating.value = true;
  try {
    const res = await api.post('/api/sync/peers', { name: trimmed });
    if (res.data?.peer?.token) {
      newPeer.value = res.data.peer;
      await loadStatus();
    }
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '创建失败');
  } finally {
    creating.value = false;
  }
}

async function regenPeer(peer: PeerView): Promise<void> {
  try {
    const res = await api.post(`/api/sync/peers/${peer.id}/regenerate`);
    if (res.data?.token) {
      newPeer.value = { ...peer, token: res.data.token };
      await loadStatus();
      notify.success('令牌已重置，旧令牌立即失效');
    }
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '重置失败');
  }
}

async function revokePeer(peer: PeerView): Promise<void> {
  try {
    await api.delete(`/api/sync/peers/${peer.id}`);
    notify.success(`已移除成员「${peer.name}」`);
    await loadStatus();
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '移除失败');
  }
}

async function reconcileNow(): Promise<void> {
  reconciling.value = true;
  try {
    await api.post('/api/sync/reconcile');
    notify.success('已开始全量对账，稍后查看状态');
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '触发失败');
  } finally {
    setTimeout(() => { reconciling.value = false; }, 1500);
  }
}

/**
 * 设置分区激活态：面板随大类切换只做 v-show（不卸载），但隐藏着还每 5 秒轮询
 * `/api/sync/status`（并连带重拉中枢地址）是白烧请求——切走即停表，切回来立刻重拉一次
 * 并重新开始轮询。active 缺省（未传）按可见处理，组件单独用时行为不变。
 */
const props = defineProps<{ active?: boolean }>();

function startPoll(): void {
  if (pollTimer !== null) return;
  pollTimer = window.setInterval(loadStatus, 5000);
}

function stopPoll(): void {
  if (pollTimer === null) return;
  window.clearInterval(pollTimer);
  pollTimer = null;
}

onMounted(async () => {
  await loadCapabilities();
  await loadStatus();
  if (status.value?.role === 'member') {
    hubUrl.value = status.value.hubUrl || '';
    directUrlsText.value = (status.value.directUrls || []).join('\n');
  }
  // 安卓点邀请链接进来时，链接可能比这个面板先到（见 lib/joinLink）
  applyPendingJoinLink();
  await loadLanAccess();
  if (props.active !== false) startPoll();
});

// 面板已经在设置页开着、用户又点了一条邀请链接（如从聊天软件切回来）：同样就地填表
watch(pendingJoinLink, () => applyPendingJoinLink());

// 大类切回本面板：立刻补一次最新状态，再恢复轮询（隐藏期间不发请求）
watch(() => props.active, (now) => {
  if (now === false) {
    stopPoll();
    return;
  }
  void loadStatus();
  startPoll();
});

onUnmounted(() => {
  stopPoll();
});
</script>

<style scoped>
/* ---------- 同步群组卡：运行摘要（实时状态走全局 .state-strip） ---------- */
.sync-summary {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 6px 0 0;
}
.summary-line {
  flex-wrap: wrap;
  font-size: 13px;
}
.summary-line strong.ok { color: var(--success); }
.summary-line strong.bad { color: var(--danger); }
.sync-summary-actions {
  display: flex;
  justify-content: flex-end;
}
.sync-summary .btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.sync-error {
  margin: 0;
  color: var(--danger);
  font-size: 12px;
  overflow-wrap: anywhere;
}

/* ---------- 未配置：中枢 / 绑定二选一（不再用两张内层描边卡） ---------- */
.role-choices {
  display: flex;
  flex-wrap: wrap;
  align-items: stretch;
  gap: 20px;
  margin: 16px 0 6px;
}
.role-option {
  flex: 1 1 240px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.role-option strong {
  font-size: 13.5px;
  font-weight: 600;
}
.role-option p {
  flex: 1;
  margin: 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
}
.role-option .btn { align-self: flex-start; }
.role-or {
  flex: none;
  align-self: center;
  color: var(--text-faint);
  font-size: 12px;
}

/* ---------- 表单行：控件宽度按字段类型给，移动端回落整行 ---------- */
.setting-control.sync-field {
  width: min(340px, 100%);
}
.sync-field input,
.sync-field textarea,
.sync-field :deep(input),
.sync-field :deep(textarea) {
  width: 100%;
}
.sync-form-actions {
  margin-top: 10px;
}
.sync-footer {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.setting-note.sync-device-name {
  margin: 4px 0 0;
}

/* ---------- 中枢：绑定地址与成员列表（行间细线，不再每行套灰底） ---------- */
.address-list,
.peer-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.address-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 9px 0;
  border-top: 1px solid var(--border);
}
.address-kind {
  flex: none;
  color: var(--text-secondary);
  font-size: 12px;
}
.address-url {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.address-row .btn { flex: none; }
.peer-row {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  padding: 10px 0;
  border-top: 1px solid var(--border);
}
.peer-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.peer-info strong {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.peer-meta {
  color: var(--text-secondary);
  font-size: 12px;
}
.peer-token {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  color: var(--text-secondary);
  font-size: 12px;
}
.peer-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.dot.on { background: var(--success); }
.dot.off { background: var(--border); }

/* ---------- 新成员绑定信息 + 邀请（二维码） ---------- */
.new-peer-block {
  margin-top: 12px;
}
.new-peer-footer {
  margin-top: 10px;
}
.copy-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  width: 100%;
}
.copy-row code {
  flex: 1;
  min-width: 0;
  padding: 4px 8px;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.copy-row .token-code-host {
  flex: 1;
  min-width: 0;
}
.invite-block {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 16px;
  margin-top: 12px;
}
.invite-body {
  flex: 1;
  min-width: min(240px, 100%);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.invite-body strong { font-size: 13px; }
.invite-body .setting-note { margin: 0; }
.invite-actions { justify-content: flex-start; }

/* ---------- 同步内容：整行可点，勾选框在左、状态值在行尾 ---------- */
.setting-note.sync-content-note {
  margin: 4px 0 0;
}
.setting-row.sync-category-row {
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 14px;
}
.setting-check {
  display: flex;
  align-items: center;
}
.sync-category-row input[type='checkbox'] {
  accent-color: var(--success);
}

/* ---------- 局域网优先：状态条 + 探测记录 ---------- */
.lan-state {
  flex-wrap: wrap;
  margin: 12px 0 0;
}
/* 状态点跟着通道走：颜色来自 .link-<key> 的 --channel（与侧栏胶囊同一颗颜色） */
.lan-state .state-dot { background: var(--channel); }
.lan-probes {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 12px;
}
.lan-probes-title {
  margin: 0;
  color: var(--text-faint);
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
}
.lan-probe-list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}
.lan-probe-list li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  padding: 5px 0;
  border-top: 1px solid var(--border);
  font-size: 12.5px;
}
.lan-probe-kind {
  flex: none;
  color: var(--text-secondary);
}
.lan-probe-url {
  min-width: 0;
  overflow: hidden;
  color: var(--text-faint);
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lan-probe-ok { flex: none; margin-left: auto; color: var(--success); }
.lan-probe-bad { flex: none; margin-left: auto; color: var(--danger); }

/* ---------- 双栈连接：开关行 + 状态条 + 两组数字 ---------- */
.dualstack-state {
  margin: 12px 0 0;
  overflow-wrap: anywhere;
}
.dualstack-fields {
  display: flex;
  flex-direction: column;
}
.ds-inputs {
  justify-content: flex-end;
}
.ds-inputs input { width: 92px; }
.ds-unit {
  color: var(--text-secondary);
  font-size: 12px;
}
.dualstack-actions {
  margin: 12px 0 2px;
}

@media (max-width: 768px) {
  .role-choices {
    flex-direction: column;
    gap: 12px;
  }
  .role-or {
    align-self: stretch;
    text-align: center;
  }
  .role-option .btn { align-self: stretch; }
  .setting-control.sync-field { width: 100%; }
  .ds-inputs { justify-content: flex-start; }
  /* 不在 .setting-row / .setting-actions 里的按钮：手机档同样保证 40px 热区 */
  .role-option .btn,
  .peer-actions .btn,
  .address-row .btn,
  .sync-summary .btn {
    min-height: 40px;
  }
}
</style>
