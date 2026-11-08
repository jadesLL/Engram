<template>
  <!-- ============ 服务器更新 ============ -->
  <section id="panel-update-server" class="settings-panel settings-native settings-group level-normal">
    <div class="group-card" :class="{ 'is-collapsed': serverCollapsed }">
      <div class="group-band collapsible" @click="onBandClick($event, 'panel-update-server')">
        <span class="group-ico" aria-hidden="true"><Icon name="download" :size="16" /></span>
        <span class="group-text">
          <span class="group-title">服务器更新</span>
          <span class="group-hint">比对版本、切换通道、拉取镜像重建容器</span>
        </span>
        <span v-if="serverBadge.text" class="group-badge" :class="'tone-' + serverBadge.tone">{{ serverBadge.text }}</span>
        <button
          type="button"
          class="group-caret"
          :aria-expanded="serverCollapsed ? 'false' : 'true'"
          :title="serverCollapsed ? '展开「服务器更新」' : '收起「服务器更新」'"
          @click.stop="toggleGroup('panel-update-server')"
        >
          <Icon name="chevron-down" :size="14" />
        </button>
      </div>
      <div v-show="!serverCollapsed" class="group-body flush">
      <!-- 本地内嵌 server（桌面本地模式 / 浏览器访问桌面本地服务） -->
      <template v-if="state.desktop">
        <!-- 已绑定多端同步：在此直接远程更新同步中枢服务器 -->
        <template v-if="syncHubUrl">
          <ul class="value-list">
            <li class="value-row">
              <span class="value-label">同步服务器</span>
              <span class="value-text">{{ syncHubHost }}</span>
            </li>
            <li class="value-row">
              <span class="value-label">当前版本</span>
              <span class="value-text">{{ hubVersionText }}</span>
            </li>
            <li class="value-row">
              <span class="value-label">更新通道</span>
              <span class="value-text is-muted">{{ hubState?.imageTag || '—' }}</span>
            </li>
            <li v-if="hubCheckResult?.hasUpdate && hubCheckResult.latestVersion" class="value-row">
              <span class="value-label">最新版本</span>
              <span class="value-text">{{ 'v' + hubCheckResult.latestVersion }}</span>
            </li>
          </ul>

          <div class="setting-row">
            <div class="setting-copy">
              <strong>检查更新</strong>
              <span>在服务器侧比对远端 Release 与镜像仓库版本。</span>
            </div>
            <div class="setting-actions">
              <span v-if="hubCheckResult?.ok" class="setting-value" :class="hubCheckResult.hasUpdate ? 'tone-warn' : 'tone-ok'">
                {{ hubCheckLabel }}
              </span>
              <button class="btn" type="button" :disabled="hubChecking" @click="doHubCheck">
                <AppSpinner v-if="hubChecking" :size="11" />
                <template v-else>检查更新</template>
              </button>
            </div>
          </div>
          <p v-if="hubCheckError" class="setting-message err">{{ hubCheckError }}</p>
          <p v-else-if="hubCheckResult?.warning" class="setting-message warn">{{ hubCheckResult.warning }}</p>

          <div class="setting-row">
            <div class="setting-copy">
              <strong>立即更新</strong>
              <span>拉取最新镜像并重建容器，服务中断 1–3 分钟，数据不受影响。</span>
            </div>
            <div class="setting-actions">
              <button class="btn primary" type="button" :disabled="hubUpdating || !hubState?.supported || hubState?.busy" @click="confirmHubApply">
                立即更新
              </button>
            </div>
          </div>

          <p v-if="hubState && !hubState.supported" class="setting-note tone-warn">
            服务器未挂载 Docker socket：在 engram 服务的 volumes 加
            <code>- /var/run/docker.sock:/var/run/docker.sock</code>，
            再用 <code>docker compose -f docker-compose.pull.yml up -d</code> 重建容器。
          </p>

          <p v-if="hubStateError" class="setting-message err">{{ hubStateError }}</p>

          <!-- 远程更新进度日志 -->
          <div v-if="hubLog.length" class="update-log">
            <div v-for="(line, i) in hubLog" :key="i" class="log-line">{{ line }}</div>
            <div v-if="hubUpdating" class="log-line pending">
              <AppSpinner :size="10" />
              <span>等待同步服务器恢复…</span>
            </div>
          </div>
          <p v-if="hubTimeout" class="setting-message err">
            服务器长时间未恢复。若更新失败，旧容器已自动回滚；仍无法访问时在服务器执行
            <code>docker start engram-old</code> 手动恢复，然后重新检查。
          </p>
        </template>

        <!-- 桌面端但未绑定同步 -->
        <p v-else-if="isDesktop" class="setting-note">
          桌面端：在「多端同步」绑定服务器后即可在这里远程更新它；桌面端自身的更新见下方「桌面端更新」。
        </p>
        <!-- 浏览器访问桌面本地服务 -->
        <p v-else class="setting-note">
          当前页面由桌面端本地服务提供；服务器（Docker）更新请在浏览器登录服务器地址操作。
        </p>
      </template>
      <!-- 环境不支持：未挂 sock -->
      <p v-else-if="!state.supported" class="setting-note tone-warn">
        当前服务器未挂载 Docker socket：在 engram 服务的 volumes 加
        <code>- /var/run/docker.sock:/var/run/docker.sock</code>，
        再用 <code>docker compose -f docker-compose.pull.yml up -d</code> 重建容器。
      </p>

      <template v-else>
        <ul class="value-list">
          <li class="value-row">
            <span class="value-label">当前版本</span>
            <span class="value-text">{{ serverVersionText }}</span>
          </li>
          <li v-if="checkResult?.hasUpdate && checkResult.latestVersion" class="value-row">
            <span class="value-label">最新版本</span>
            <span class="value-text">{{ 'v' + checkResult.latestVersion }}</span>
          </li>
        </ul>

        <div class="setting-row">
          <div class="setting-copy">
            <strong>更新通道</strong>
            <span>latest 跟随正式发版；main 跟随主分支滚动构建。</span>
          </div>
          <div class="setting-actions">
            <AppSelect
              v-model="form.imageTag"
              aria-label="更新通道"
              :options="channelOptions"
              @change="saveChannel"
            />
            <span v-if="channelSaved" class="setting-value tone-ok">已保存</span>
            <AppSpinner v-else-if="savingChannel" :size="11" />
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-copy">
            <strong>检查更新</strong>
            <span>从远端仓库 Release 与镜像仓库比对当前版本。</span>
          </div>
          <div class="setting-actions">
            <button class="btn" type="button" :disabled="checking" @click="doCheck">
              <AppSpinner v-if="checking" :size="11" />
              <template v-else>检查更新</template>
            </button>
          </div>
        </div>
        <p v-if="checkError" class="setting-message err">{{ checkError }}</p>
        <p v-else-if="checkResult?.warning" class="setting-message warn">{{ checkResult.warning }}</p>

        <div class="setting-row">
          <div class="setting-copy">
            <strong>立即更新</strong>
            <span>拉取最新镜像并重建容器，服务中断 1–3 分钟，数据不受影响。</span>
          </div>
          <button class="btn primary" type="button" :disabled="updating || !state.supported" @click="confirmApply">
            立即更新
          </button>
        </div>

        <!-- 更新进度日志 -->
        <div v-if="updateLog.length" class="update-log">
          <div v-for="(line, i) in updateLog" :key="i" class="log-line">{{ line }}</div>
          <div v-if="updating" class="log-line pending">
            <AppSpinner :size="10" />
            <span>{{ healthWaiting ? '服务重启中，等待恢复…' : '更新执行中…' }}</span>
          </div>
        </div>
        <p v-if="healthTimeout" class="setting-message err">
          服务长时间未恢复。若更新失败，旧容器已自动回滚；仍无法访问时在服务器执行
          <code>docker start engram-old</code> 手动恢复，然后刷新本页。
        </p>
      </template>
      </div>
    </div>
  </section>

  <!-- ============ 桌面端更新 ============ -->
  <section id="panel-update-desktop" class="settings-panel settings-native settings-group level-normal">
    <div class="group-card" :class="{ 'is-collapsed': desktopCollapsed }">
      <div class="group-band collapsible" @click="onBandClick($event, 'panel-update-desktop')">
        <span class="group-ico" aria-hidden="true"><Icon name="monitor" :size="16" /></span>
        <span class="group-text">
          <span class="group-title">桌面端更新</span>
          <span class="group-hint">这台 Windows 版的更新方式与状态</span>
        </span>
        <span v-if="desktopBadge.text" class="group-badge" :class="'tone-' + desktopBadge.tone">{{ desktopBadge.text }}</span>
        <button
          type="button"
          class="group-caret"
          :aria-expanded="desktopCollapsed ? 'false' : 'true'"
          :title="desktopCollapsed ? '展开「桌面端更新」' : '收起「桌面端更新」'"
          @click.stop="toggleGroup('panel-update-desktop')"
        >
          <Icon name="chevron-down" :size="14" />
        </button>
      </div>
      <div v-show="!desktopCollapsed" class="group-body flush">

      <p v-if="!isDesktop" class="setting-note">
        在 Windows 桌面端内可在此下载并安装最新安装包；浏览器访问时仅作展示。
      </p>

      <template v-else>
        <ul class="value-list">
          <li class="value-row">
            <span class="value-label">当前版本</span>
            <span class="value-text">{{ desktopVersionText }}</span>
          </li>
          <li class="value-row">
            <span class="value-label">更新方式</span>
            <span class="value-text is-muted">{{ desktopUpdateModeText }}</span>
          </li>
          <li v-if="desktopCheck?.ok && desktopCheck.hasUpdate && desktopCheck.latestVersion" class="value-row">
            <span class="value-label">最新版本</span>
            <span class="value-text">{{ 'v' + desktopCheck.latestVersion }}</span>
          </li>
        </ul>

        <p v-if="sourceMode" class="setting-note">
          源码模式：更新 = 增量拉源码并重建（约 1 分钟），自动装依赖并重启。
        </p>
        <p v-if="prebuiltMode" class="setting-note">
          预构建安装不含 Git：应用内不能增量拉源码，请用新版安装器覆盖安装，知识库数据保留。
        </p>

        <template v-if="autoSupported && installerMode">
          <div class="setting-row">
            <div class="setting-copy">
              <strong>自动更新</strong>
              <span>启动后自动检查，后台下载并静默安装，装完自动重启。</span>
            </div>
            <label class="switch-control">
              <input
                type="checkbox"
                :checked="autoState.enabled"
                :aria-label="'自动更新，' + (autoState.enabled ? '已开启' : '已关闭')"
                @change="toggleAuto"
              />
              <span aria-hidden="true"></span>
            </label>
          </div>
          <!-- 自动更新状态槽：固定高度，只换文字与进度条宽度，不按阶段增删节点。
               以前这里是「有状态才渲染」的三段，自动更新一开，检查 → 下载 → 安装之间
               卡片高度反复变化，下面的行和卡片底边就上下跳（用户 2026-11-08 报障）。 -->
          <div class="auto-status-slot" aria-live="polite">
            <p class="setting-message auto-status-line" :class="autoStatusTone" :title="autoStatus">{{ autoStatus }}</p>
            <div class="update-progress auto-status-progress" :class="{ 'is-downloading': autoProgressVisible }">
              <div class="update-progress-bar" :style="{ width: autoProgressValue + '%' }" />
            </div>
          </div>
          <p v-if="autoState.installError" class="setting-message err">{{ autoState.installError }}</p>
          <!-- 自动更新失败一次后的暂停态：本版本不再自动重试，只提示用户并可手动重试（用户 2026-11-08 要求） -->
          <div v-if="autoState.blockedVersion" class="setting-row">
            <div class="setting-copy">
              <strong>自动更新已暂停</strong>
              <span>v{{ autoState.blockedVersion }} 自动更新失败过一次，本版本不再自动重试；可点右侧重试，或用下方按钮手动更新。</span>
            </div>
            <button class="btn" type="button" :disabled="retryingAuto" @click="retryAuto">
              <AppSpinner v-if="retryingAuto" :size="11" />
              <template v-else>重试自动更新</template>
            </button>
          </div>
          <p v-if="autoState.blockedVersion && autoState.blockedReason" class="setting-note">
            失败原因：{{ autoState.blockedReason }}。发布新版本后自动恢复。
          </p>
        </template>

        <div v-if="installerMode" class="setting-row">
          <div class="setting-copy">
            <strong>检查更新</strong>
            <span>手动从远端仓库 Release 比对桌面端版本。</span>
          </div>
          <div class="setting-actions">
            <button class="btn" type="button" :disabled="desktopChecking" @click="doDesktopCheck">
              <AppSpinner v-if="desktopChecking" :size="11" />
              <template v-else>检查更新</template>
            </button>
          </div>
        </div>
        <p v-if="installerMode && desktopUnsupported" class="setting-message warn">
          当前桌面端版本过旧，不支持应用内更新；请到仓库 Release 页手动下载最新安装包覆盖安装一次。
        </p>
        <p v-if="installerMode && desktopCheck && !desktopCheck.ok && desktopCheck.error === 'not-configured'" class="setting-message warn">
          尚未配置更新源，见下方「更新源配置」。
        </p>
        <p v-else-if="installerMode && desktopCheck && !desktopCheck.ok" class="setting-message err">{{ desktopCheck.error }}</p>

        <div v-if="installerMode && desktopCheck?.ok && desktopCheck.hasUpdate && desktopCheck.exe" class="setting-row">
          <div class="setting-copy">
            <strong>下载并安装</strong>
            <span>{{ desktopCheck.exe.name }}（{{ fmtSize(desktopCheck.exe.size) }}），点击后自动下载并静默安装。</span>
          </div>
          <button class="btn primary" type="button" :disabled="downloading || installing || autoDownloading" :title="autoDownloading ? '自动更新正在后台下载/安装安装包，完成后会自动安装；如需手动下载请先关闭「自动更新」' : ''" @click="downloadAndInstall">
            {{ installing ? '安装中…' : downloading ? '下载中 ' + (downloadPercent ?? '') + (downloadPercent !== null ? '%' : '') : autoDownloading ? '自动更新下载中…' : '下载并安装' }}
          </button>
        </div>
        <div v-if="installerMode && downloading && downloadPercent !== null" class="update-progress">
          <div class="update-progress-bar" :style="{ width: downloadPercent + '%' }" />
        </div>
        <p v-if="installerMode && downloadError" class="setting-message err">{{ downloadError }}</p>
        <p v-else-if="installerMode && installing" class="setting-message warn">正在静默安装更新，应用将自动重启，请勿关闭。</p>

        <!-- 源码模式：增量拉源码 + 重新构建 -->
        <template v-if="sourceMode">
          <div v-if="sourceAutoSupported" class="setting-row">
            <div class="setting-copy">
              <strong>自动检查更新</strong>
              <span>启动后自动检查（之后每 8 小时）；发现新提交只在设置页与系统通知里提示，不会自动重启。</span>
            </div>
            <label class="switch-control">
              <input
                type="checkbox"
                :checked="sourceAuto.enabled"
                :aria-label="'自动检查更新，' + (sourceAuto.enabled ? '已开启' : '已关闭')"
                @change="toggleSourceAuto"
              />
              <span aria-hidden="true"></span>
            </label>
          </div>
          <p
            v-if="sourceAutoSupported && sourceAutoStatus"
            class="state-strip source-auto-state"
            :class="sourceAutoStateTone"
          >
            <span class="state-dot" aria-hidden="true"></span>
            <span>{{ sourceAutoStatus }}</span>
          </p>

          <div class="setting-row">
            <div class="setting-copy">
              <strong>检查更新</strong>
              <span>增量拉取远端源码，比对当前分支落后多少提交。</span>
            </div>
            <div class="setting-actions">
              <span v-if="srcResult && srcResult.ok" class="setting-value" :class="srcResult.upToDate ? 'tone-ok' : 'tone-warn'">
                {{ sourceCheckText }}
              </span>
              <button class="btn" type="button" :disabled="srcChecking || srcUpdating" @click="doSourceCheck">
                <AppSpinner v-if="srcChecking" :size="11" />
                <template v-else>检查更新</template>
              </button>
            </div>
          </div>
          <p v-if="srcError" class="setting-message err">{{ srcError }}</p>

          <div v-if="srcResult?.ok && !srcResult.upToDate" class="setting-row">
            <div class="setting-copy">
              <strong>更新并重启</strong>
              <span>增量拉取 {{ srcResult.behind }} 个提交并重新构建（约 1 分钟），完成后自动重启，数据不受影响。</span>
            </div>
            <button class="btn primary" type="button" :disabled="srcUpdating" @click="doSourceUpdate">
              更新并重启
            </button>
          </div>
          <p v-if="srcUpdating" class="setting-message warn">正在增量拉取源码并重新构建，请看置顶的更新进度窗口；完成后应用自动重启。</p>
        </template>
      </template>
      </div>
    </div>
  </section>

  <!-- 桌面端应用（开机自启 / 桌面快捷方式）：2026-09-28 起拆到 DesktopAppSection.vue，
       归属「本机应用」大类（方案 A）。更新分组只谈版本，本机应用行为不在这里。 -->

  <!-- ============ 更新源配置 ============ -->
  <section id="panel-update-source" class="settings-panel settings-native settings-group level-normal">
    <div class="group-card" :class="{ 'is-collapsed': sourceCollapsed }">
      <div class="group-band collapsible" @click="onBandClick($event, 'panel-update-source')">
        <span class="group-ico" aria-hidden="true"><Icon name="globe" :size="16" /></span>
        <span class="group-text">
          <span class="group-title">更新源配置</span>
          <span class="group-hint">远端仓库地址与访问凭据</span>
        </span>
        <span v-if="configLoaded && !state.giteaConfigured" class="group-badge tone-warn">未配置</span>
        <button
          type="button"
          class="group-caret"
          :aria-expanded="sourceCollapsed ? 'false' : 'true'"
          :title="sourceCollapsed ? '展开「更新源配置」' : '收起「更新源配置」'"
          @click.stop="toggleGroup('panel-update-source')"
        >
          <Icon name="chevron-down" :size="14" />
        </button>
      </div>
      <div v-show="!sourceCollapsed" class="group-body flush">
      <p class="setting-note">
        配置写入服务器数据目录的 .env 文件，随数据卷持久化；公开仓库无需填凭据。
      </p>

      <div class="setting-row setting-row-form repo-row">
        <div class="setting-copy">
          <strong>远端仓库地址</strong>
          <span>仓库首页或 Release 页地址，整条粘贴即可。</span>
        </div>
        <input v-model="form.repoUrl" type="text" placeholder="https://gitea.xxx.com/username/Engram" aria-label="远端仓库地址" @input="repoUrlError = ''" />
        <p v-if="repoUrlError" class="setting-message err">{{ repoUrlError }}</p>
      </div>

      <div class="setting-row setting-row-form credential-row">
        <div class="setting-copy">
          <strong>访问凭据</strong>
          <span>私有仓库才需要；公开仓库留空即可。</span>
        </div>
        <div class="credential-inputs">
          <div class="segmented credential-type" role="radiogroup" aria-label="凭据方式">
            <button
              type="button"
              role="radio"
              :aria-checked="form.authType === 'token'"
              :class="{ active: form.authType === 'token' }"
              @click="form.authType = 'token'"
            >访问令牌</button>
            <button
              type="button"
              role="radio"
              :aria-checked="form.authType === 'password'"
              :class="{ active: form.authType === 'password' }"
              @click="form.authType = 'password'"
            >用户名密码</button>
          </div>
          <template v-if="form.authType === 'token'">
            <input v-model="form.token" type="text" autocomplete="off" spellcheck="false" placeholder="粘贴访问令牌" aria-label="远端仓库访问令牌" />
            <p class="setting-note">仓库站点「设置 → 应用」里生成只读令牌；清空保存即删除。</p>
          </template>
          <template v-else>
            <input v-model="form.username" type="text" autocomplete="off" spellcheck="false" placeholder="用户名" aria-label="远端仓库用户名" />
            <div class="password-control">
              <SecretField
                v-model="form.password"
                :stored="storedPassword"
                copyable
                placeholder="密码"
                aria-label="远端仓库密码"
                @update:model-value="clearStoredPassword = false"
              />
              <button
                v-if="storedPassword"
                class="btn"
                type="button"
                @click="clearStoredPassword = !clearStoredPassword"
              >{{ clearStoredPassword ? '取消清除' : '清除已保存密码' }}</button>
            </div>
            <p v-if="clearStoredPassword" class="setting-note password-clear-hint">保存时将删除已保存的仓库密码。</p>
          </template>
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-copy">
          <strong>保存配置</strong>
          <span>写入服务器数据目录 .env，即时生效。</span>
        </div>
        <button class="btn primary" type="button" :disabled="savingConfig" @click="saveConfig">
          {{ savingConfig ? '保存中…' : '保存配置' }}
        </button>
      </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { api, ssePost } from '../../api';
import AppSpinner from '../ui/AppSpinner.vue';
import AppSelect from '../ui/AppSelect.vue';
import Icon from '../Icon.vue';
import SecretField from '../SecretField.vue';
import { useSettingsBadge } from '../../lib/settingsBadges';
import { isGroupCollapsed, toggleGroupCollapsed } from '../../lib/settingsCollapse';
import { confirmDialog } from '../../lib/confirm';
import { notify } from '../../lib/notify';
import { formatSourceCheckLabel, type GitIdentity } from '../../lib/buildLabel';
// 仓库地址解析与安卓端「安卓端更新」分组共用一份（lib/repoSourceUrl.ts），避免两处慢慢跑偏
import { parseRepoUrl } from '../../lib/repoSourceUrl';
// 自动更新状态槽的纯展示逻辑（文案/色调/进度宽度，且保证任何阶段都有文字），单测在 lib/updatePanelState.test.ts
import {
  acceptManualProgressEvent,
  autoProgressPercent,
  autoProgressVisible as autoProgressVisibleOf,
  autoUpdateStatusLine,
  autoUpdateStatusTone,
  isAutoDownloading,
} from '../../lib/updatePanelState';
import {
  applyDesktopInstallerUpdate,
  applyServerUpdate,
  applySourceUpdate,
  friendlyApplyError,
  isServerAlreadyLatest,
  type UpdateSourceCfg,
} from '../../lib/applyUpdate';
import { markServerUpdatePending, shortCommit } from '../../lib/serverUpdateFeedback';
import { useServerUpdateStore } from '../../stores/serverUpdate';

interface UpdateStateInfo {
  supported: boolean;
  reason: string;
  desktop: boolean;
  currentVersion: string;
  /** 构建提交号（Docker 镜像烤入 /app/GIT_SHA、源码检出读 .git、桌面端注入） */
  commit: string;
  /** 提交号来源：env / build-file / git / unknown */
  commitSource: string;
  /** 生效的更新通道（镜像 tag）：latest / main */
  imageTag: string;
  imageTagConfigured: boolean;
  giteaConfigured: boolean;
  busy: boolean;
  containerName: string;
  currentImage: string;
}

interface ConfigInfo {
  imageTag: string;
  giteaUrl: string;
  giteaRepo: string;
  giteaAuthType: string;
  giteaToken: string;
  giteaUsername: string;
  giteaPassword: string;
}

import { useRuntimeCapabilities } from '../../lib/capabilities';

/**
 * 是否桌面端运行时：优先看服务端能力协商（runtime 为 desktop），它覆盖「用浏览器打开
 * 桌面本地服务」这种没有 window.wikiDesktop 的场景；协商尚未回来（首页仍按 full 兜底）
 * 时才看 preload 注入的 wikiDesktop。
 * 用它门控「桌面端应用」分组：导航条目按同一能力位（need: 'desktop'）显示，两边必须一致，
 * 否则会出现点不动的死锚点。
 */
const { capabilities: runtimeCapabilities } = useRuntimeCapabilities();
const isDesktop = computed(() =>
  typeof window !== 'undefined'
  && (runtimeCapabilities.value.runtime === 'desktop' || Boolean((window as any).wikiDesktop))
);

const state = ref<UpdateStateInfo>({
  supported: false, reason: '', desktop: false, currentVersion: '', commit: '', commitSource: 'unknown',
  imageTag: 'latest', imageTagConfigured: false,
  giteaConfigured: false, busy: false, containerName: '', currentImage: '',
});
const config = ref<ConfigInfo>({
  imageTag: '',
  giteaUrl: '', giteaRepo: '', giteaAuthType: 'token', giteaToken: '', giteaUsername: '', giteaPassword: '',
});
const form = reactive({ repoUrl: '', authType: 'token', token: '', username: '', password: '', imageTag: '' });
const storedPassword = ref('');
const clearStoredPassword = ref(false);
const repoUrlError = ref('');
/** 配置是否已加载完成：避免加载前「未配置」徽标闪烁误报 */
const configLoaded = ref(false);

const checking = ref(false);
const checkResult = ref<any>(null);
const checkError = ref('');

const updating = ref(false);
const healthWaiting = ref(false);
const healthTimeout = ref(false);
const updateLog = ref<string[]>([]);
/**
 * 更新进行中的全局状态：容器重建期间同步必然断，连接状态（侧栏胶囊 / 首页状态条 /
 * 设置页同步摘要）据此统一显示「服务器更新中」，而不是过期的「已连接」或红色「连接中断」。
 */
const serverUpdate = useServerUpdateStore();

/** 版本 + 提交号的可读后缀：版本号仅随发版变化，提交号才说明「构建到哪一次」 */
function identityText(version: string, commit: string): string {
  const commitPart = commit ? ' · ' + shortCommit(commit) : '';
  return version ? '（v' + version + commitPart + '）' : '';
}

/** 「已是最新」提示里的版本与提交号：优先用检查结果，退回面板已加载的 state */
function currentIdentity(check?: any): string {
  return identityText(
    String(check?.currentVersion || state.value.currentVersion || ''),
    String(state.value.commit || ''),
  );
}

/**
 * 点「立即更新」前先确认是否已经是最新：已是最新就不再重建容器，直接弹成功提示
 * （用户 2026-11 明确要求：更新成功后再次点击要给成功提示，而不是重复跑一遍重建）。
 * 检查失败（远端不可达 / 未配置更新源）不拦着更新，日志里写清原因后按原流程继续。
 */
async function checkAlreadyLatest(log: (line: string) => void) {
  try {
    const { data } = await api.post('/api/update/check', {});
    checkResult.value = data;
    return { latest: isServerAlreadyLatest(data), data };
  } catch (e: any) {
    const reason = e.response?.data?.error || e.response?.data?.warning || e?.message || '未知错误';
    log('无法确认是否已是最新（' + reason + '），继续按原流程更新');
    return { latest: false, data: null as any };
  }
}

const desktopChecking = ref(false);
const desktopCheck = ref<any>(null);
/** 旧版桌面端 exe 的 preload 缺 desktopUpdateCheck API：无法应用内更新，引导手动下载 */
const desktopUnsupported = ref(false);
const downloading = ref(false);
const installing = ref(false);
const downloadPercent = ref<number | null>(null);
const downloadError = ref('');
let offProgress: (() => void) | null = null;

// 自动更新（主进程状态机）：旧版壳无 desktopUpdateGetState API 时隐藏该节
const autoSupported = ref(false);
const autoState = ref<any>({
  enabled: true,
  phase: 'idle',
  latestVersion: null,
  percent: null,
  error: '',
  installError: '',
  // 自动更新失败暂停（主进程 lib/update-failure.js）：有值表示该版本失败过一次、本版本不再自动重试
  blockedVersion: null,
  blockedReason: '',
});
let offAutoState: (() => void) | null = null;
/** 「重试自动更新」请求进行中（按钮转圈，避免连点） */
const retryingAuto = ref(false);

const savingConfig = ref(false);
/** 更新通道单独即时保存（顶部常规行，不随「保存配置」按钮） */
const savingChannel = ref(false);
const channelSaved = ref(false);
/** 更新通道下拉项：空值 = 按当前镜像自动判断 */
const channelOptions: Array<{ value: string; label: string }> = [
  { value: '', label: '自动（按当前镜像判断）' },
  { value: 'latest', label: 'latest（正式发版线）' },
  { value: 'main', label: 'main（主分支滚动，测试用）' },
];

// 源码模式（非打包形态）：更新 = 增量拉源码 + 重新构建，不使用安装包
const sourceMode = ref(false);
// 预构建环境包安装：没有 .git / Git，应用内更新只能靠重跑新版安装器（见主进程 desktop-get-env.prebuilt）
const prebuiltMode = ref(false);
/** 安装包形态（打包版 exe）：自动更新与「下载并安装」入口只对它成立 */
const installerMode = computed(() => !sourceMode.value && !prebuiltMode.value);
/** 源码模式的 git 身份（提交号/日期/是否脏），打包形态与浏览器访问时为空 */
const desktopEnv = ref<GitIdentity | null>(null);
/** desktop-get-env 是否已回：回来前「更新方式」写 —，不先猜成安装包 */
const desktopEnvLoaded = ref(false);
const srcChecking = ref(false);
const srcResult = ref<any>(null);
const srcUpdating = ref(false);
const srcError = ref('');
// 源码模式自动检查（主进程状态机）：旧版壳无 desktopSourceAutoState API 时隐藏该节
const sourceAutoSupported = ref(false);
const sourceAuto = ref<any>({ enabled: true, phase: 'idle', behind: 0, localCommit: '', remoteCommit: '', error: '', checkedAt: null });
let offSourceState: (() => void) | null = null;

// 桌面快捷方式重建与开机自启不在这里：2026-09-28 起随「桌面端应用」分组拆到 DesktopAppSection.vue
// （归属「本机应用」大类），本组件只剩版本相关的分组。

// ---- 同步中枢远程更新（本地模式绑定多端同步后可用，转发走本地内嵌 server） ----
const syncStatus = ref<{ role: string; enabled: boolean; hubUrl: string } | null>(null);
/** 已绑定且启用的同步中枢才渲染远程更新块——后端 memberHub() 同一判定
 *  （解除绑定/停用后 hub_url 故意残留供重连，role 仍报 member，须再看 enabled） */
const syncHubUrl = computed(() =>
  syncStatus.value?.role === 'member' && syncStatus.value.enabled && syncStatus.value.hubUrl
    ? syncStatus.value.hubUrl
    : ''
);
const syncHubHost = computed(() => {
  try {
    return new URL(syncHubUrl.value).host;
  } catch {
    return syncHubUrl.value;
  }
});
const hubState = ref<any>(null);
const hubStateError = ref('');
const hubChecking = ref(false);
const hubCheckResult = ref<any>(null);
const hubCheckError = ref('');
const hubUpdating = ref(false);
const hubTimeout = ref(false);
const hubLog = ref<string[]>([]);

/*
 * 分组状态徽标（「强调分组」）：把「这个组要不要动手」写在标题行上，
 * 同时经 lib/settingsBadges 供设置页二级导航显示。检查过才知道的（hasUpdate）
 * 只在已有检查结果时提示，没检查过就不虚报「已是最新」。
 */
const serverBadge = computed<{ text: string; tone: 'ok' | 'warn' | 'muted' | 'accent' | 'danger' }>(() => {
  if (updating.value || hubUpdating.value) return { text: '更新中', tone: 'accent' };
  if (healthTimeout.value || hubTimeout.value) return { text: '更新超时', tone: 'danger' };
  if (checkError.value || hubCheckError.value) return { text: '检查失败', tone: 'danger' };
  const r = checkResult.value;
  if (r?.ok && r.hasUpdate) return { text: '有新版', tone: 'warn' };
  if (r?.ok) return { text: '已是最新', tone: 'ok' };
  return { text: '', tone: 'muted' };
});
const desktopBadge = computed<{ text: string; tone: 'ok' | 'warn' | 'muted' | 'accent' | 'danger' }>(() => {
  if (installing.value) return { text: '安装中', tone: 'accent' };
  if (downloading.value) return { text: '下载中', tone: 'accent' };
  if (srcUpdating.value) return { text: '更新中', tone: 'accent' };
  if (downloadError.value) return { text: '下载失败', tone: 'danger' };
  if (prebuiltMode.value) return { text: '预构建', tone: 'muted' };
  if (sourceAuto.value?.phase === 'behind') {
    return { text: `${sourceAuto.value.behind ?? 0} 个新提交`, tone: 'warn' };
  }
  const r = desktopCheck.value;
  if (r?.ok && r.hasUpdate) return { text: '有新版', tone: 'warn' };
  if (r?.ok) return { text: '已是最新', tone: 'ok' };
  return { text: '', tone: 'muted' };
});
useSettingsBadge(
  'panel-update-server',
  computed(() => serverBadge.value.text),
);
useSettingsBadge(
  'panel-update-desktop',
  computed(() => desktopBadge.value.text),
);
// 开机自启徽标（panel-app）不在这里：随「桌面端应用」分组拆到 DesktopAppSection.vue
useSettingsBadge(
  'panel-update-source',
  computed(() => (configLoaded.value && !state.value.giteaConfigured ? '未配置' : '')),
);

async function loadSync() {
  try {
    const { data } = await api.get('/api/sync/status');
    syncStatus.value = data;
  } catch {
    syncStatus.value = null;
  }
  if (!syncHubUrl.value) return;
  await loadHubState();
}

async function loadHubState() {
  hubStateError.value = '';
  try {
    const { data } = await api.get('/api/sync/hub-update/state');
    hubState.value = data;
  } catch (e: any) {
    hubState.value = null;
    hubStateError.value = e.response?.data?.error || '无法获取服务器更新状态';
  }
}

async function doHubCheck() {
  hubChecking.value = true;
  hubCheckError.value = '';
  try {
    const { data } = await api.post('/api/sync/hub-update/check', {});
    hubCheckResult.value = data;
  } catch (e: any) {
    hubCheckResult.value = null;
    hubCheckError.value = e.response?.data?.error || '检查失败，请确认同步服务器可访问';
  } finally {
    hubChecking.value = false;
  }
}

async function confirmHubApply() {
  const ok = await confirmDialog({
    title: '更新同步服务器',
    message: `将在服务器（${syncHubHost.value}）上拉取最新镜像并重建容器，服务中断约 1–3 分钟（数据不受影响；期间本端同步短暂断开，恢复后自动重连）。更新失败会自动回滚旧版本。继续？`,
    confirmText: '开始更新',
  });
  if (!ok) return;
  hubUpdating.value = true;
  hubTimeout.value = false;
  hubLog.value = [];
  // ① 已是最新就不再远程重建：直接给成功提示（更新成功后再次点击走这条）
  hubLog.value.push('正在确认同步服务器是否已是最新版本…');
  try {
    const { data } = await api.post('/api/sync/hub-update/check', {});
    hubCheckResult.value = data;
    if (isServerAlreadyLatest(data)) {
      hubUpdating.value = false;
      hubLog.value.push('同步服务器已是最新版本，无需重复更新。');
      notify.success('同步服务器已是最新版本' + identityText(
        String(data.currentVersion || hubState.value?.currentVersion || ''),
        String(hubState.value?.commit || ''),
      ) + '，无需重复更新');
      return;
    }
  } catch (e: any) {
    const reason = e.response?.data?.error || e?.message || '未知错误';
    hubLog.value.push('无法确认同步服务器是否已是最新（' + reason + '），继续按原流程更新');
  }
  // ② 远程更新期间连接状态统一显示「服务器更新中」（中枢服务会被重建）
  serverUpdate.begin({ target: 'hub', hubHost: syncHubHost.value });
  try {
    await ssePost('/api/sync/hub-update/apply', {}, {
      onEvent: (event, data) => {
        if (event === 'progress' && data?.text) hubLog.value.push(String(data.text));
        else if (event === 'done') hubLog.value.push(String(data?.message || '更新流程已移交'));
        else if (event === 'error') {
          hubLog.value.push(`更新失败: ${data?.error || '未知错误'}`);
          hubUpdating.value = false;
          serverUpdate.finish();
        } else if (event === 'recovered') {
          // 对比恢复前后的提交号/版本号：没变化说明更新已回滚或远端镜像与本地一致，
          // 不能再报「更新完成」误导用户以为已升级
          const prev = hubState.value;
          const st = data?.state;
          if (st) hubState.value = st;
          const changed = !st || !prev || st.commit !== prev.commit || st.currentVersion !== prev.currentVersion;
          if (changed) {
            hubLog.value.push('服务器已恢复，远程更新完成');
            hubUpdating.value = false;
            hubCheckResult.value = null;
            serverUpdate.finish();
            notify.success('同步服务器更新完成' + identityText(
              String(st?.currentVersion || ''),
              String(st?.commit || ''),
            ));
          } else {
            hubLog.value.push('服务器已恢复，但版本未变化——更新可能已自动回滚，或远端镜像与本地一致；可稍后点「检查更新」复核');
            hubUpdating.value = false;
            serverUpdate.finish();
          }
        } else if (event === 'timeout') {
          hubTimeout.value = true;
          hubUpdating.value = false;
          serverUpdate.finish();
        }
      },
    });
    // 流正常结束时必有终态事件；仍停在更新中说明本地连接中途断流（更新在服务端继续执行）
    if (hubUpdating.value) {
      hubLog.value.push('与本地服务的连接中断，更新可能仍在服务器端执行；稍后点「检查更新」确认版本。');
      hubUpdating.value = false;
      serverUpdate.finish();
    }
  } catch (e: any) {
    hubLog.value.push(`连接中断: ${e?.message || e}`);
    hubUpdating.value = false;
    serverUpdate.finish();
  }
}

// 设置分区激活态：本面板随大类切换只做 v-show（不卸载），但可能在隐藏期间被别的入口改过状态，
// 切入本大类时兜底重拉一次。多端同步：用户可能刚在「多端同步」分组完成绑定/解绑，
// 不重拉会一直显示挂载时的旧快照。开机自启：托盘右键菜单是同一个开关的另一个入口
// （改动本身有 desktop-launch-at-login 广播会即时回写，这里是第二道保险，防止广播漏到时显示旧状态）。
const props = defineProps<{ active?: boolean }>();
watch(
  () => props.active,
  (now) => {
    if (!now) return;
    loadSync();
  }
);

const wikiDesktop = () => (window as any).wikiDesktop;

/** 传给主进程的更新源配置：与页面中已保存的值一致（检查与下载必须同源，否则资产 URL 校验不过） */
const updateSourceCfg = computed<UpdateSourceCfg>(() => ({
  giteaUrl: config.value.giteaUrl,
  giteaRepo: config.value.giteaRepo,
  giteaAuthType: config.value.giteaAuthType,
  giteaToken: config.value.giteaToken,
  giteaUsername: config.value.giteaUsername,
  giteaPassword: config.value.giteaPassword,
}));

/**
 * 服务器卡片的版本行：版本号 + 短提交号（版本号仅随发版变化，提交号才说明构建到哪一次）。
 * 原来挂在卡头徽标上的版本号移到这里：卡头只留一个「有没有新版」的状态徽标。
 */
const serverVersionText = computed(() => {
  const current = state.value.currentVersion;
  if (!current) return '—';
  const commit = state.value.commit ? ' · ' + shortCommit(state.value.commit) : '';
  return 'v' + current + commit;
});

/** 同步中枢服务器（远程更新）的版本：未知时统一写 —，不猜 */
const hubVersionText = computed(() => {
  const st = hubState.value;
  if (!st?.currentVersion) return '—';
  return 'v' + st.currentVersion + (st.commit ? ' · ' + st.commit : '');
});

/** 桌面端版本行：主进程 desktop-get-env 的 app.getVersion() + 提交号 */
const desktopVersionText = computed(() => {
  const env = desktopEnv.value as (GitIdentity & { version?: string }) | null;
  if (!env?.version) return '—';
  return 'v' + env.version + (env.commit ? ' · ' + env.commit : '');
});

/** 桌面端更新方式：与源码模式 / 预构建 / 安装包三种入口一一对应（未就绪时写 —） */
const desktopUpdateModeText = computed(() => {
  if (!desktopEnvLoaded.value) return '—';
  if (sourceMode.value) return '源码模式（增量拉取并重建）';
  if (prebuiltMode.value) return '预构建安装（新版安装器覆盖）';
  return '安装包（自动或手动下载）';
});

/** 源码模式自动检查的状态条色调：有新提交 / 失败需要处理时给琥珀点，其余默认 */
const sourceAutoStateTone = computed(() => {
  const phase = sourceAuto.value?.phase;
  return phase === 'behind' || phase === 'failed' ? 'tone-warn' : '';
});

// 分组折叠：本组件三张分组卡片各自持久化折叠状态（锚点 id 即各卡片的 DOM id）
const serverCollapsed = computed(() => isGroupCollapsed('panel-update-server'));
const desktopCollapsed = computed(() => isGroupCollapsed('panel-update-desktop'));
const sourceCollapsed = computed(() => isGroupCollapsed('panel-update-source'));
function toggleGroup(anchor: string) {
  toggleGroupCollapsed(anchor);
}
function onBandClick(event: MouseEvent, anchor: string) {
  const target = event.target as HTMLElement | null;
  if (target?.closest('button, a, input, select, textarea, label')) return;
  toggleGroup(anchor);
}

/** 源码模式检查更新结果：`已是最新（本地 0fbe4e2）` / `落后 3 个提交：0fbe4e2 → a1b2c3d` */
const sourceCheckText = computed(() => (srcResult.value?.ok ? formatSourceCheckLabel(srcResult.value) : ''));

/** 检查更新结果文案：main 通道无 Release 版本可比，只说「主分支镜像有更新」 */
function fmtCheckLabel(r: any): string {
  if (!r) return '';
  if (!r.hasUpdate) return '已是最新';
  // main 通道更新由镜像 digest 驱动，Release 版本号与本地相同，不能拿它当「新版本」
  if (r.imageTag === 'main') return '主分支镜像有更新';
  if (r.latestVersion) return `有新版本 v${r.latestVersion}`;
  return '远端镜像有更新';
}

const hubCheckLabel = computed(() => fmtCheckLabel(hubCheckResult.value));

/** 源码模式自动检查状态文字：只提示，不自动升级（重启时机由用户点「更新并重启」决定） */
const sourceAutoStatus = computed(() => {
  const s = sourceAuto.value;
  switch (s.phase) {
    case 'checking':
      return '正在自动检查更新…';
    case 'up-to-date':
      return s.localCommit ? `自动检查完成，已是最新（本地 ${s.localCommit}）` : '自动检查完成，已是最新';
    case 'behind': {
      const route = s.localCommit && s.remoteCommit ? `（${s.localCommit} → ${s.remoteCommit}）` : '';
      return `发现 ${s.behind ?? 0} 个新提交${route}，点下方「更新并重启」即可更新`;
    }
    case 'failed':
      return `自动检查失败：${s.error}。不影响使用，可手动点「检查更新」重试。`;
    case 'unsupported':
      return s.error || '当前安装不支持应用内源码更新。';
    default:
      return s.enabled ? '' : '自动检查已关闭';
  }
});

/**
 * 自动更新状态槽（固定高度）的四个派生值：文案、色调、进度宽度、是否显示进度底色。
 * 任何阶段都返回文字、槽位始终在 DOM 里——阶段切换只改文字与宽度，卡片高度不变，
 * 下面的行与卡片底边就不会上下跳（用户 2026-11-08 报障）。
 */
const autoStatus = computed(() => autoUpdateStatusLine(autoState.value));
const autoStatusTone = computed(() => autoUpdateStatusTone(autoState.value));
const autoProgressValue = computed(() => autoProgressPercent(autoState.value));
const autoProgressVisible = computed(() => autoProgressVisibleOf(autoState.value));
/** 自动更新正在下载/安装：手动「下载并安装」要禁用（两者落盘同一个文件） */
const autoDownloading = computed(() => installerMode.value && isAutoDownloading(autoState.value));

async function toggleAuto(e: Event) {
  const wd = wikiDesktop();
  const enabled = (e.target as HTMLInputElement).checked;
  if (!wd?.desktopUpdateSetAuto) return;
  try {
    autoState.value = await wd.desktopUpdateSetAuto(enabled);
    notify.success(enabled ? '自动更新已开启' : '自动更新已关闭');
  } catch {
    notify.error('设置失败，请重试');
  }
}

/**
 * 清掉「本版本自动更新已暂停」并立即重新检查：用户修好网络/权限或被拦截原因后不必等下一个版本，
 * 也不用去翻 config.json（旧版壳没有这个 API 时按钮不渲染）。
 */
async function retryAuto() {
  const wd = wikiDesktop();
  if (!wd?.desktopUpdateRetryAuto) return;
  retryingAuto.value = true;
  try {
    autoState.value = await wd.desktopUpdateRetryAuto();
    notify.success('已清除暂停记录，正在重新检查更新');
  } catch {
    notify.error('重试自动更新失败，请稍后再试');
  } finally {
    retryingAuto.value = false;
  }
}

/** 源码模式的「自动检查」开关：与打包形态共用 config.autoUpdate，但只检查不自动升级 */
async function toggleSourceAuto(e: Event) {
  const wd = wikiDesktop();
  const enabled = (e.target as HTMLInputElement).checked;
  if (!wd?.desktopSourceSetAuto) return;
  try {
    sourceAuto.value = await wd.desktopSourceSetAuto(enabled);
    notify.success(enabled ? '自动检查更新已开启' : '自动检查更新已关闭');
  } catch {
    notify.error('设置失败，请重试');
  }
}

async function load() {
  try {
    const [s, c] = await Promise.all([
      api.get('/api/update/state'),
      api.get('/api/update/config'),
    ]);
    state.value = s.data;
    config.value = c.data;
    form.repoUrl = c.data.giteaUrl && c.data.giteaRepo ? `${c.data.giteaUrl}/${c.data.giteaRepo}` : (c.data.giteaUrl || '');
    form.authType = c.data.giteaAuthType === 'password' ? 'password' : 'token';
    form.token = c.data.giteaToken || '';
    form.username = c.data.giteaUsername || '';
    storedPassword.value = c.data.giteaPassword || '';
    form.password = '';
    clearStoredPassword.value = false;
    form.imageTag = c.data.imageTag || '';
    configLoaded.value = true;
  } catch {
    /* 面板加载失败由 message 区提示 */
  }
}

async function doCheck() {
  checking.value = true;
  checkError.value = '';
  try {
    const { data } = await api.post('/api/update/check', {});
    checkResult.value = data;
  } catch (e: any) {
    checkResult.value = null;
    checkError.value = e.response?.data?.error || e.response?.data?.warning || '检查失败，请确认远端仓库配置';
  } finally {
    checking.value = false;
  }
}

async function confirmApply() {
  const ok = await confirmDialog({
    title: '立即更新',
    message: '将拉取最新镜像并重建容器，服务中断约 1–3 分钟（数据不受影响）。更新失败会自动回滚旧版本。继续？',
    confirmText: '开始更新',
  });
  if (!ok) return;
  updating.value = true;
  healthWaiting.value = false;
  healthTimeout.value = false;
  updateLog.value = [];
  const log = (line: string) => updateLog.value.push(line);
  // ① 是否已经是最新：是就弹成功提示、不再重建容器（更新成功后再次点击也走这条）
  log('正在确认是否已是最新版本…');
  const check = await checkAlreadyLatest(log);
  if (check.latest) {
    updating.value = false;
    log('已是最新版本，无需重复更新。');
    notify.success('已是最新版本' + currentIdentity(check.data) + '，无需重复更新');
    return;
  }
  // ② 落一条跨刷新标记：页面在新容器起来后自动刷新，刷新回来据此弹「更新成功」
  markServerUpdatePending({
    fromVersion: state.value.currentVersion,
    fromCommit: state.value.commit,
    source: 'settings',
  });
  serverUpdate.begin({ target: 'local' });
  // 更新流程本体在 lib/applyUpdate.ts（与首页更新图标展开的面板共用一份实现）：
  // SSE 执行 → 等旧容器下线 → 等新容器 /health 恢复 → 自动刷新页面
  const r = await applyServerUpdate({
    log,
    onWaiting: () => { healthWaiting.value = true; },
    onTimeout: () => { healthTimeout.value = true; },
  });
  if (!r.ok) {
    updating.value = false;
    healthWaiting.value = false;
    serverUpdate.finish();
    // 超时由 healthTimeout 单独给提示；其余失败把原因写进日志
    if (!r.timeout) updateLog.value.push(friendlyApplyError(r.error));
  }
  // r.ok：applyServerUpdate 已等到服务恢复并刷新页面，这里不用再改状态
}

async function doDesktopCheck() {
  const wd = wikiDesktop();
  if (!wd?.desktopUpdateCheck) {
    desktopUnsupported.value = true;
    return;
  }
  desktopUnsupported.value = false;
  desktopChecking.value = true;
  try {
    // 把设置页当前的更新源配置传给主进程，确保检查使用页面中已保存的值
    desktopCheck.value = await wd.desktopUpdateCheck(updateSourceCfg.value);
  } finally {
    desktopChecking.value = false;
  }
}

async function downloadAndInstall() {
  const wd = wikiDesktop();
  const exe = desktopCheck.value?.exe;
  if (!wd?.desktopUpdateDownload || !exe) return;
  // 点击即全自动：下载（进度条）→ 静默安装（应用内全屏提示 + 独立进度窗）→ 自动重启，无需再点任何确认。
  // 下载进度由 onMounted 里的 desktop-update-progress 订阅统一喂给 downloadPercent。
  downloading.value = true;
  downloadError.value = '';
  // 先清掉上一次/自动更新留下的百分比，按钮别在 0% 之前显示旧进度
  downloadPercent.value = null;
  const r = await applyDesktopInstallerUpdate({
    cfg: updateSourceCfg.value,
    check: desktopCheck.value,
    // 下载完成进入静默安装阶段：按钮变「安装中…」并提示即将重启（此前这段 UI 从未被点亮）
    onInstalling: () => { installing.value = true; },
  });
  if (!r.ok) {
    downloading.value = false;
    installing.value = false;
    downloadError.value = friendlyApplyError(r.error);
  }
}

async function doSourceCheck() {
  const wd = wikiDesktop();
  if (!wd?.desktopSourceUpdateCheck) {
    srcError.value = '当前桌面端壳过旧，不支持源码更新，请更新一次桌面端后再试。';
    return;
  }
  srcChecking.value = true;
  srcError.value = '';
  try {
    srcResult.value = await wd.desktopSourceUpdateCheck();
    if (!srcResult.value?.ok) srcError.value = srcResult.value?.error || '检查失败';
  } catch (e: any) {
    srcResult.value = null;
    srcError.value = e?.message || '检查失败';
  } finally {
    srcChecking.value = false;
  }
}

async function doSourceUpdate() {
  const wd = wikiDesktop();
  if (!wd?.desktopSourceUpdate) return;
  const ok = await confirmDialog({
    title: '更新并重启',
    message: `将增量拉取 ${srcResult.value?.behind ?? ''} 个提交并重新构建（约 1 分钟），期间会弹出置顶进度窗口实时显示构建步骤，完成后应用自动重启，数据不受影响。继续？`,
    confirmText: '开始更新',
  });
  if (!ok) return;
  srcUpdating.value = true;
  srcError.value = '';
  // 主进程弹出置顶进度小窗；成功后约 1.5s 应用自动退出并由新实例接管
  const r = await applySourceUpdate();
  if (!r.ok) {
    srcUpdating.value = false;
    srcError.value = friendlyApplyError(r.error);
  }
}

// 卸载 Engram 与桌面端应用（开机自启 / 快捷方式）都不在这里：
// 2026-09-28 起归「本机应用」大类——开机自启与快捷方式在 DesktopAppSection.vue，
// 卸载在 UninstallSection.vue；本组件只负责版本相关的三张卡片。

async function saveConfig() {
  const parsed = parseRepoUrl(form.repoUrl);
  if ('error' in parsed) {
    repoUrlError.value = parsed.error;
    return;
  }
  repoUrlError.value = '';
  savingConfig.value = true;
  try {
    await api.put('/api/update/config', {
      giteaUrl: parsed.url,
      giteaRepo: parsed.repo,
      giteaAuthType: form.authType,
      giteaToken: form.authType === 'token' ? form.token : '',
      giteaUsername: form.authType === 'password' ? form.username : '',
      giteaPassword: form.authType === 'password'
        ? (clearStoredPassword.value ? '' : (form.password || storedPassword.value))
        : '',
      imageTag: form.imageTag,
    });
    await load();
    notify.success('更新源配置已保存');
  } catch (e: any) {
    notify.error(e.response?.data?.error || '保存失败');
  } finally {
    savingConfig.value = false;
  }
}

/** 更新通道：顶部常规行，改动即存（不必再滚到页底点「保存配置」） */
async function saveChannel() {
  savingChannel.value = true;
  channelSaved.value = false;
  try {
    await api.put('/api/update/config', { imageTag: form.imageTag });
    await load();
    channelSaved.value = true;
    setTimeout(() => (channelSaved.value = false), 2000);
  } catch (e: any) {
    notify.error(e.response?.data?.error || '更新通道保存失败');
  } finally {
    savingChannel.value = false;
  }
}

function fmtSize(bytes: number): string {
  if (!bytes) return '未知大小';
  if (bytes > 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB';
  if (bytes > 1024 * 1024) return (bytes / 1024 / 1024).toFixed(0) + ' MB';
  return (bytes / 1024).toFixed(0) + ' KB';
}

onMounted(() => {
  load();
  loadSync();
  const wd = wikiDesktop();
  if (wd?.getDesktopEnv) {
    wd.getDesktopEnv()
      .then((env: any) => {
        desktopEnv.value = env;
        prebuiltMode.value = Boolean(env?.prebuilt);
        // 预构建安装同属「非打包形态」，但没有 git 检出：不能走源码更新分支
        sourceMode.value = Boolean(env && !env.packaged && env.platform === 'win32' && !env.prebuilt);
      })
      .catch(() => {
        /* 主进程未就绪时按安装包形态兜底 */
      })
      .finally(() => {
        desktopEnvLoaded.value = true;
      });
  } else {
    desktopEnvLoaded.value = true;
  }
  if (wd?.onUpdateProgress) {
    // 这条通道主进程会同时用来推手动下载与后台自动更新的进度（旧壳不带 source）：
    // 只采信 manual，否则两个下载同时跑时进度条会在这两个百分比之间来回跳。
    offProgress = wd.onUpdateProgress((p: any) => {
      if (!acceptManualProgressEvent(p)) return;
      downloadPercent.value = p?.percent ?? null;
    });
  }
  if (wd?.desktopUpdateGetState) {
    autoSupported.value = true;
    wd.desktopUpdateGetState().then((s: any) => {
      autoState.value = s;
    });
    if (wd.onUpdateState) {
      offAutoState = wd.onUpdateState((s: any) => {
        autoState.value = s;
      });
    }
  }
  // 源码模式自动检查（旧版壳无此 API 时该节自动隐藏）
  if (wd?.desktopSourceAutoState) {
    sourceAutoSupported.value = true;
    wd.desktopSourceAutoState().then((s: any) => {
      sourceAuto.value = s;
    });
    if (wd.onSourceState) {
      offSourceState = wd.onSourceState((s: any) => {
        sourceAuto.value = s;
      });
    }
  }
  // 桌面快捷方式重建 / 开机自启的初始化已随「桌面端应用」分组移到 DesktopAppSection.vue
});
onUnmounted(() => {
  offProgress?.();
  offAutoState?.();
  offSourceState?.();
});
</script>

<style scoped>
/* 分组内容区（flush）里的行级消息 / 状态条：行自带 22px 内边距，这里只补纵向间距；
   位于 setting-row 内的消息保持网格定位不加边距 */
.setting-message {
  margin: 0 0 12px;
}
.setting-row .setting-message {
  margin: 0;
}
.source-auto-state {
  margin: 0 0 12px;
}

/* 表单行：标签独占一行，输入框在下一行占满（长仓库地址不被挤成窄条）；
   行内报错跟着单列走，不再被全局的 grid-column: 2 挤到隐式列里 */
.setting-row.repo-row,
.setting-row.credential-row {
  grid-template-columns: 1fr;
}
.setting-row.repo-row .setting-message,
.setting-row.credential-row .setting-message {
  grid-column: 1;
}
.credential-inputs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}
.credential-type {
  flex: 0 0 auto;
}
.credential-inputs input {
  flex: 1 1 200px;
  max-width: 420px;
  min-width: 0;
}
.credential-inputs .setting-note {
  flex: 1 1 100%;
  margin: 2px 0 0;
}
.password-control {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 320px;
  min-width: 0;
}
.password-control :deep(.secret-input-wrap) {
  flex: 1 1 220px;
  max-width: 420px;
  min-width: 0;
}
.password-control .btn {
  white-space: nowrap;
}

/* 更新日志：等宽滚动区（输出流，保留容器边界） */
.update-log {
  margin: 12px 0;
  padding: 10px 12px;
  max-height: 220px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  line-height: 1.7;
  color: var(--text-secondary);
}
.log-line {
  white-space: pre-wrap;
  word-break: break-all;
}
.log-line.pending {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--accent, #3b82f6);
}

.update-progress {
  height: 6px;
  margin: -4px 0 12px;
  overflow: hidden;
  border-radius: 3px;
  background: var(--bg-secondary);
}
.update-progress-bar {
  height: 100%;
  border-radius: 3px;
  background: var(--accent, #3b82f6);
  transition: width 200ms ease;
}

/* 自动更新状态槽：文案行 + 进度轨都常驻（固定高度），阶段切换不增删节点。
   这样卡片高度不随「检查/下载/安装」变化，下面的「检查更新 / 下载并安装」行和
   卡片底边不会上下跳（用户 2026-11-08 报「开着自动更新这块来回乱跳」）。
   行高与轨道高度写死，文字换行才可能改变高度：状态文案控制在单行，超长时省略。
   注：updatePanelLayout.test.ts 锁了这段类名与常驻结构，不能改成按阶段渲染。 */
.auto-status-slot {
  margin: 0 0 12px;
}
.auto-status-slot .auto-status-line {
  margin: 0;
  min-height: 18px;
  overflow: hidden;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.auto-status-slot .auto-status-line.warn {
  color: var(--warn);
}
.auto-status-slot .auto-status-line.err {
  color: var(--danger);
}
.auto-status-slot .auto-status-progress {
  margin: 6px 0 0;
  background: transparent; /* 没有下载时不显示灰轨，但高度仍占位 */
}
.auto-status-slot .auto-status-progress.is-downloading {
  background: var(--bg-secondary);
}

@media (max-width: 768px) {
  .setting-message {
    margin: 0 0 14px;
  }
  .setting-row .setting-message {
    margin: 0;
  }
  .update-log {
    margin: 12px 0;
  }
  .update-progress {
    margin: -4px 0 12px;
  }
  .auto-status-slot {
    margin: 0 0 14px;
  }
  .auto-status-slot .auto-status-progress {
    margin: 6px 0 0;
  }
}
</style>
