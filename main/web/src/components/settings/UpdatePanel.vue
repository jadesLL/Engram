<template>
  <!-- ============ 服务器更新 ============ -->
  <section id="panel-update-server" class="settings-panel settings-native settings-group level-normal">
    <div class="group-card" :class="{ 'is-collapsed': serverCollapsed }">
      <div class="group-band collapsible" @click="onBandClick($event, 'panel-update-server')">
        <span class="group-ico" aria-hidden="true"><Icon name="download" :size="16" /></span>
        <span class="group-text">
          <span class="group-title">服务器更新</span>
          <span class="group-hint">Docker 部署的服务端：比对 Release 与镜像仓库版本、切换更新通道、拉取镜像就地重建；桌面端绑定多端同步后可在此远程更新同步服务器</span>
        </span>
        <span v-if="versionBadge" class="group-badge tone-muted">{{ versionBadge }}</span>
        <span v-if="serverBadge.text" class="group-badge" :class="`tone-${serverBadge.tone}`">{{ serverBadge.text }}</span>
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
          <div class="setting-row">
            <div class="setting-copy">
              <strong>同步服务器 <code>{{ syncHubHost }}</code></strong>
              <span>
                多端同步绑定的服务器（Docker 部署）。在此即可远程更新，无需登录服务器网页。<template v-if="hubState">
                  当前 <code>v{{ hubState.currentVersion }}</code><template v-if="hubState.commit">（{{ hubState.commit }}）</template><template v-if="hubState.imageTag">，通道 <code>{{ hubState.imageTag }}</code></template>。
                </template>
              </span>
            </div>
            <div class="check-controls">
              <span v-if="hubState?.busy" class="check-status">服务器更新中…</span>
              <button class="btn primary" type="button" :disabled="hubUpdating || !hubState?.supported || hubState?.busy" @click="confirmHubApply">
                立即更新
              </button>
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-copy">
              <strong>检查更新</strong>
              <span>在服务器侧比对远端仓库 Release 与镜像仓库版本。</span>
            </div>
            <div class="check-controls">
              <span v-if="hubCheckResult" class="check-status" :class="hubCheckResult.hasUpdate ? 'has' : 'none'">
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

          <div v-if="hubState && !hubState.supported" class="integration-note">
            服务器未挂载 Docker socket，无法远程更新。请在服务器上编辑
            <code>docker-compose.pull.yml</code>，在 engram 服务的 volumes 增加一行
            <code>- /var/run/docker.sock:/var/run/docker.sock</code>，然后执行
            <code>docker compose -f docker-compose.pull.yml up -d</code> 重新创建容器，之后即可在此页一键更新。
          </div>

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
            服务器长时间未恢复。若更新失败，旧容器已自动回滚；仍无法访问时请在服务器执行
            <code>docker start engram-old</code> 手动恢复，然后重新检查。
          </p>
        </template>

        <!-- 桌面端但未绑定同步 -->
        <div v-else-if="isDesktop" class="integration-note">
          当前运行在桌面端。在「设置 → 多端同步」绑定服务器后，即可在此直接远程更新服务器，无需登录服务器网页；桌面端自身的更新见下方「桌面端更新」分组。
        </div>
        <!-- 浏览器访问桌面本地服务 -->
        <div v-else class="integration-note">
          当前页面由桌面端本地服务提供，服务器（Docker）容器更新请从浏览器登录服务器地址操作。
        </div>
      </template>
      <!-- 环境不支持：未挂 sock -->
      <div v-else-if="!state.supported" class="integration-note">
        当前服务器未挂载 Docker socket，无法在网页内自动更新。请编辑服务器上的
        <code>docker-compose.pull.yml</code>，在 engram 服务的 volumes 增加一行
        <code>- /var/run/docker.sock:/var/run/docker.sock</code>，然后执行
        <code>docker compose -f docker-compose.pull.yml up -d</code> 重新创建容器，之后即可在此页一键更新。
      </div>

      <template v-else>
        <div class="setting-row">
          <div class="setting-copy">
            <strong>更新通道</strong>
            <span>
              <code>latest</code> 跟随正式发版（默认）；<code>main</code> 跟随主分支滚动构建，合入 main 即可更新测试，无需发版。切换后即时生效。
            </span>
          </div>
          <div class="channel-control">
            <AppSelect
              v-model="form.imageTag"
              aria-label="更新通道"
              :options="channelOptions"
              @change="saveChannel"
            />
            <span v-if="channelSaved" class="channel-saved">已保存</span>
            <AppSpinner v-else-if="savingChannel" :size="11" />
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-copy">
            <strong>检查更新</strong>
            <span>从远端仓库 Release 与镜像仓库比对当前版本。<template v-if="state.imageTag">当前通道：<code>{{ state.imageTag }}</code></template></span>
          </div>
          <div class="check-controls">
            <span v-if="checkResult" class="check-status" :class="checkResult.hasUpdate ? 'has' : 'none'">
              {{ checkLabel }}
            </span>
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
            <span>拉取最新镜像并重建容器，服务将中断 1–3 分钟，数据不受影响。</span>
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
          服务长时间未恢复。若更新失败，旧容器已自动回滚；仍无法访问时请在服务器执行
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
          <span class="group-hint">Windows 桌面端的版本：安装包自动或手动下载安装，源码模式增量拉取提交并重新构建（开机自启、桌面快捷方式与卸载见「桌面端应用」与「数据与存储 → 危险操作」）</span>
        </span>
        <span v-if="desktopVersionBadge" class="group-badge tone-muted">{{ desktopVersionBadge }}</span>
        <span v-if="desktopBadge.text" class="group-badge" :class="`tone-${desktopBadge.tone}`">{{ desktopBadge.text }}</span>
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

      <div v-if="!isDesktop" class="integration-note">
        在 Windows 桌面端内可在此下载并安装最新安装包；浏览器访问服务器时此节仅作展示。
      </div>

      <template v-else>
        <div v-if="sourceMode" class="integration-note">
          当前为<strong>源码模式</strong>：更新 = 增量拉取源码并重新构建，不使用安装包。依赖清单真变化时会<strong>在应用内自动装依赖</strong>（pnpm install），不需要再去终端跑脚本；构建约需 1 分钟，期间弹出置顶进度窗口，完成后应用自动重启，数据不受影响。版本号仅随发版变化，<strong>提交号随每次更新变化</strong>，用它判断是否已更新到最新代码。
        </div>

        <div v-if="autoSupported && !sourceMode" class="setting-row">
          <div class="setting-copy">
            <strong>自动更新</strong>
            <span>启动后自动检查（之后每 8 小时复查），发现新版本自动在后台下载并静默安装；安装前应用内会提示，装完自动重启，全程无需手动操作。</span>
          </div>
          <label class="switch-control">
            <input type="checkbox" :checked="autoState.enabled" @change="toggleAuto" />
            <span aria-hidden="true"></span>
            <em>{{ autoState.enabled ? '已开启' : '已关闭' }}</em>
          </label>
        </div>
        <p v-if="autoSupported && !sourceMode && autoStatus && (!autoState.enabled || autoState.phase !== 'idle')" class="setting-message" :class="autoState.phase === 'failed' ? 'err' : autoState.phase === 'installing' ? 'warn' : ''">
          {{ autoStatus }}
        </p>
        <div v-if="autoSupported && !sourceMode && autoState.enabled && autoState.phase === 'downloading' && autoState.percent !== null" class="update-progress">
          <div class="update-progress-bar" :style="{ width: autoState.percent + '%' }" />
        </div>

        <div v-if="!sourceMode" class="setting-row">
          <div class="setting-copy">
            <strong>检查更新</strong>
            <span>手动从远端仓库 Release 比对桌面端版本。</span>
          </div>
          <div class="check-controls">
            <span v-if="desktopCheck && desktopCheck.ok" class="check-status" :class="desktopCheck.hasUpdate ? 'has' : 'none'">
              {{ desktopCheck.hasUpdate ? `有新版本 v${desktopCheck.latestVersion}` : '已是最新' }}
            </span>
            <button class="btn" type="button" :disabled="desktopChecking" @click="doDesktopCheck">
              <AppSpinner v-if="desktopChecking" :size="11" />
              <template v-else>检查更新</template>
            </button>
          </div>
        </div>
        <p v-if="!sourceMode && desktopUnsupported" class="setting-message warn">
          当前桌面端版本过旧，不支持应用内更新。请到仓库 Release 页手动下载最新安装包覆盖安装一次，之后即可在应用内更新。
        </p>
        <p v-if="!sourceMode && desktopCheck && !desktopCheck.ok && desktopCheck.error === 'not-configured'" class="setting-message warn">
          尚未配置远端仓库更新源（见下方「更新源配置」）。
        </p>
        <p v-else-if="!sourceMode && desktopCheck && !desktopCheck.ok" class="setting-message err">{{ desktopCheck.error }}</p>

        <div v-if="!sourceMode && desktopCheck?.ok && desktopCheck.hasUpdate && desktopCheck.exe" class="setting-row">
          <div class="setting-copy">
            <strong>下载并安装</strong>
            <span>{{ desktopCheck.exe.name }}（{{ fmtSize(desktopCheck.exe.size) }}），点击后自动下载并静默安装，全程无需操作。</span>
          </div>
          <button class="btn primary" type="button" :disabled="downloading || installing" @click="downloadAndInstall">
            {{ installing ? '安装中…' : downloading ? `下载中 ${downloadPercent ?? ''}${downloadPercent !== null ? '%' : ''}` : '下载并安装' }}
          </button>
        </div>
        <div v-if="!sourceMode && downloading && downloadPercent !== null" class="update-progress">
          <div class="update-progress-bar" :style="{ width: downloadPercent + '%' }" />
        </div>
        <p v-if="!sourceMode && downloadError" class="setting-message err">{{ downloadError }}</p>
        <p v-else-if="!sourceMode && installing" class="setting-message warn">正在静默安装更新，应用将自动重启，请勿关闭。</p>

        <!-- 源码模式：增量拉源码 + 重新构建 -->
        <template v-if="sourceMode">
          <div v-if="sourceAutoSupported" class="setting-row">
            <div class="setting-copy">
              <strong>自动检查更新</strong>
              <span>启动后自动检查（之后每 8 小时复查）；发现新提交只在设置页与系统通知里提示，更新仍由你点「更新并重启」确认，不会自动重启。</span>
            </div>
            <label class="switch-control">
              <input type="checkbox" :checked="sourceAuto.enabled" @change="toggleSourceAuto" />
              <span aria-hidden="true"></span>
              <em>{{ sourceAuto.enabled ? '已开启' : '已关闭' }}</em>
            </label>
          </div>
          <p
            v-if="sourceAutoSupported && sourceAutoStatus"
            class="setting-message"
            :class="sourceAuto.phase === 'behind' ? 'warn' : sourceAuto.phase === 'failed' ? 'err' : ''"
          >
            {{ sourceAutoStatus }}
          </p>

          <div class="setting-row">
            <div class="setting-copy">
              <strong>检查更新</strong>
              <span>增量拉取远端源码，比对当前分支落后多少提交。</span>
            </div>
            <div class="check-controls">
              <span v-if="srcResult && srcResult.ok" class="check-status" :class="srcResult.upToDate ? 'none' : 'has'">
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
              <span>增量拉取 {{ srcResult.behind }} 个提交并重新构建（约 1 分钟），应用将自动重启，数据不受影响。</span>
            </div>
            <button class="btn primary" type="button" :disabled="srcUpdating" @click="doSourceUpdate">
              更新并重启
            </button>
          </div>
          <p v-if="srcUpdating" class="setting-message warn">正在增量拉取源码并重新构建，请看置顶的更新进度窗口；构建完成后应用自动重启，数据不受影响。</p>
        </template>
      </template>
      </div>
    </div>
  </section>

  <!-- ============ 桌面端应用（这台机器上怎么跑 Engram：开机自启 / 快捷方式） ============
       2026-09-24 从「桌面端更新」拆出：更新分组只谈版本，这两项是桌面端运行时行为。
       卸载 Engram 与之同源（都是桌面端本机动作），但因为它不可撤销，移到「数据与存储 → 危险操作」，
       与清库 / 清日志并列，不再留在本组件里。 -->
  <section v-if="isDesktop" id="panel-app" class="settings-panel settings-native settings-group level-normal">
    <div class="group-card" :class="{ 'is-collapsed': appCollapsed }">
      <div class="group-band collapsible" @click="onBandClick($event, 'panel-app')">
        <span class="group-ico" aria-hidden="true"><Icon name="monitor" :size="16" /></span>
        <span class="group-text">
          <span class="group-title">桌面端应用</span>
          <span class="group-hint">Windows 桌面端本机行为：登录后是否自动启动、桌面快捷方式重建</span>
        </span>
        <span v-if="launchAtLoginSupported" class="group-badge" :class="launchAtLogin.enabled ? 'tone-ok' : 'tone-muted'">
          {{ launchAtLogin.enabled ? '开机自启已开启' : '开机自启已关闭' }}
        </span>
        <button
          type="button"
          class="group-caret"
          :aria-expanded="appCollapsed ? 'false' : 'true'"
          :title="appCollapsed ? '展开「桌面端应用」' : '收起「桌面端应用」'"
          @click.stop="toggleGroup('panel-app')"
        >
          <Icon name="chevron-down" :size="14" />
        </button>
      </div>
      <div v-show="!appCollapsed" class="group-body flush">

        <!-- 开机自启：登录 Windows 后静默启动到系统托盘（旧版壳无此 API 时整行隐藏） -->
        <div v-if="launchAtLoginSupported" class="setting-row">
          <div class="setting-copy">
            <strong>开机自启</strong>
            <span>
              登录 Windows 后自动启动 Engram，<strong>静默驻留系统托盘</strong>：不弹主窗口，内嵌服务照常运行；
              托盘图标双击（或桌面快捷方式）即可打开主界面。托盘右键菜单里也能开关。
            </span>
          </div>
          <div class="check-controls">
            <span v-if="launchAtLogin.blocked" class="check-status has">已被系统禁用</span>
            <label class="switch-control">
              <input
                type="checkbox"
                :checked="launchAtLogin.enabled"
                :disabled="launchAtLoginBusy"
                @change="toggleLaunchAtLogin"
              />
              <span aria-hidden="true"></span>
              <em>{{ launchAtLogin.enabled ? '已开启' : '已关闭' }}</em>
            </label>
          </div>
        </div>
        <p v-if="launchAtLoginMessage" class="setting-message" :class="launchAtLoginError ? 'err' : ''">{{ launchAtLoginMessage }}</p>
        <p v-if="launchAtLoginSupported && launchAtLogin.blocked" class="setting-message warn">
          启动项被「任务管理器 → 启动」禁用了，开机不会自动运行；在这里重新打开一次开关即可恢复。
        </p>
        <p v-if="launchAtLoginSupported && launchAtLogin.stale" class="setting-message warn">
          检测到启动项命令与当前安装位置不一致（换过安装目录或旧版本写入），开关一次即可修正。
        </p>

        <!-- 桌面快捷方式：图标丢失或显示不对时重建（源码模式同时生成带 Engram 图标的 Engram.exe） -->
        <div v-if="shortcutSupported" class="setting-row">
          <div class="setting-copy">
            <strong>桌面快捷方式</strong>
            <span>
              桌面上的 Engram 图标丢失或显示不对时在此重建。
              <template v-if="sourceMode">源码模式的启动程序是 Electron 官方运行时（图标是 Electron 的原子），重建会在同目录生成一份带 Engram 图标的 Engram.exe 作为启动目标，资源管理器与任务栏图标随之统一。</template>
              <template v-else>重建指向当前安装目录 Engram.exe 的桌面快捷方式。</template>
            </span>
          </div>
          <div class="check-controls">
            <button class="btn" type="button" :disabled="shortcutBusy" @click="doRebuildShortcut">
              <AppSpinner v-if="shortcutBusy" :size="11" />
              <template v-else>重建桌面快捷方式</template>
            </button>
          </div>
        </div>
        <p v-if="shortcutMessage" class="setting-message" :class="shortcutError ? 'err' : ''">{{ shortcutMessage }}</p>
      </div>
    </div>
  </section>

  <!-- ============ 更新源配置 ============ -->
  <section id="panel-update-source" class="settings-panel settings-native settings-group level-normal">
    <div class="group-card" :class="{ 'is-collapsed': sourceCollapsed }">
      <div class="group-band collapsible" @click="onBandClick($event, 'panel-update-source')">
        <span class="group-ico" aria-hidden="true"><Icon name="globe" :size="16" /></span>
        <span class="group-text">
          <span class="group-title">更新源配置</span>
          <span class="group-hint">远端仓库地址与访问凭据：服务器与桌面端检查更新共用这一份配置</span>
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
      <div class="integration-note">
        只需粘贴仓库地址，服务器和仓库会自动识别；配置保存在服务器数据目录 .env 文件中（随数据卷持久化，不进代码库）。公开仓库无需填凭据。
      </div>

      <div class="setting-row setting-row-form">
        <div class="setting-copy">
          <strong>远端仓库地址</strong>
          <span>打开仓库首页，把浏览器地址栏整条复制粘贴过来（Release 页地址也可以），如 https://gitea.xxx.com/username/Engram。</span>
        </div>
        <input v-model="form.repoUrl" type="text" placeholder="https://gitea.xxx.com/username/Engram" aria-label="远端仓库地址" @input="repoUrlError = ''" />
        <p v-if="repoUrlError" class="setting-message err">{{ repoUrlError }}</p>
      </div>

      <div class="setting-row setting-row-form credential-row">
        <div class="setting-copy">
          <strong>访问凭据</strong>
          <span>私有仓库才需要。可任选一种方式，公开仓库留空即可。</span>
          <div class="auth-type-toggle">
            <button type="button" :class="['seg-btn', form.authType === 'token' ? 'active' : '']" @click="form.authType = 'token'">访问令牌</button>
            <button type="button" :class="['seg-btn', form.authType === 'password' ? 'active' : '']" @click="form.authType = 'password'">用户名密码</button>
          </div>
        </div>
        <div class="credential-inputs">
          <template v-if="form.authType === 'token'">
            <input v-model="form.token" type="text" autocomplete="off" spellcheck="false" placeholder="粘贴访问令牌" aria-label="远端仓库访问令牌" />
            <p class="setting-message hint">在仓库站点右上角头像 → 设置 → 应用 → 「生成新令牌」（勾选只读权限）。清空保存即删除。</p>
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
                class="btn small"
                type="button"
                @click="clearStoredPassword = !clearStoredPassword"
              >{{ clearStoredPassword ? '取消清除' : '清除已保存密码' }}</button>
            </div>
            <p v-if="clearStoredPassword" class="setting-message hint password-clear-hint">保存时将删除已保存的仓库密码。</p>
          </template>
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-copy">
          <strong>保存配置</strong>
          <span>写入服务器数据目录 .env 文件，即时生效。</span>
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
import { formatVersionLabel, formatSourceCheckLabel, type GitIdentity } from '../../lib/buildLabel';
import {
  applyDesktopInstallerUpdate,
  applyServerUpdate,
  applySourceUpdate,
  friendlyApplyError,
  type UpdateSourceCfg,
} from '../../lib/applyUpdate';

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
const autoState = ref<any>({ enabled: true, phase: 'idle', latestVersion: null, percent: null, error: '' });
let offAutoState: (() => void) | null = null;

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
/** 源码模式的 git 身份（提交号/日期/是否脏），打包形态与浏览器访问时为空 */
const desktopEnv = ref<GitIdentity | null>(null);
const srcChecking = ref(false);
const srcResult = ref<any>(null);
const srcUpdating = ref(false);
const srcError = ref('');
// 源码模式自动检查（主进程状态机）：旧版壳无 desktopSourceAutoState API 时隐藏该节
const sourceAutoSupported = ref(false);
const sourceAuto = ref<any>({ enabled: true, phase: 'idle', behind: 0, localCommit: '', remoteCommit: '', error: '', checkedAt: null });
let offSourceState: (() => void) | null = null;

// 桌面快捷方式重建：旧版壳无 desktopRebuildShortcut API 时隐藏该行（见「桌面端应用」分组）
const shortcutSupported = ref(false);
const shortcutBusy = ref(false);
const shortcutMessage = ref('');
const shortcutError = ref(false);

// 开机自启（Windows 登录时静默启动到系统托盘）：旧版壳无 getLaunchAtLogin API 时隐藏该行
const launchAtLoginSupported = ref(false);
const launchAtLogin = ref<{
  supported: boolean;
  enabled: boolean;
  stale: boolean;
  blocked: boolean;
  command: string;
}>({ supported: false, enabled: false, stale: false, blocked: false, command: '' });
const launchAtLoginBusy = ref(false);
const launchAtLoginMessage = ref('');
const launchAtLoginError = ref(false);
let offLaunchAtLogin: (() => void) | null = null;

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
const serverBadge = computed<{ text: string; tone: 'ok' | 'warn' | 'muted' }>(() => {
  const r = checkResult.value;
  if (r?.ok && r.hasUpdate) return { text: `有新版 v${r.latestVersion}`, tone: 'warn' };
  if (r?.ok) return { text: '已是最新', tone: 'ok' };
  return { text: '', tone: 'muted' };
});
const desktopBadge = computed<{ text: string; tone: 'ok' | 'warn' | 'muted' }>(() => {
  if (sourceAuto.value?.phase === 'behind') {
    return { text: `${sourceAuto.value.behind ?? 0} 个新提交`, tone: 'warn' };
  }
  const r = desktopCheck.value;
  if (r?.ok && r.hasUpdate) return { text: `有新版 v${r.latestVersion}`, tone: 'warn' };
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
// 开机自启是「离开设置页也在后台生效」的状态：二级导航上直接写出开关，免得用户为看一眼跑一趟
useSettingsBadge(
  'panel-app',
  computed(() => (launchAtLoginSupported.value ? (launchAtLogin.value.enabled ? '开机自启已开' : '开机自启已关') : '')),
);
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
  try {
    await ssePost('/api/sync/hub-update/apply', {}, {
      onEvent: (event, data) => {
        if (event === 'progress' && data?.text) hubLog.value.push(String(data.text));
        else if (event === 'done') hubLog.value.push(String(data?.message || '更新流程已移交'));
        else if (event === 'error') {
          hubLog.value.push(`更新失败: ${data?.error || '未知错误'}`);
          hubUpdating.value = false;
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
            notify.success('同步服务器更新完成');
          } else {
            hubLog.value.push('服务器已恢复，但版本未变化——更新可能已自动回滚，或远端镜像与本地一致；可稍后点「检查更新」复核');
            hubUpdating.value = false;
          }
        } else if (event === 'timeout') {
          hubTimeout.value = true;
          hubUpdating.value = false;
        }
      },
    });
    // 流正常结束时必有终态事件；仍停在更新中说明本地连接中途断流（更新在服务端继续执行）
    if (hubUpdating.value) {
      hubLog.value.push('与本地服务的连接中断，更新可能仍在服务器端执行；稍后点「检查更新」确认版本。');
      hubUpdating.value = false;
    }
  } catch (e: any) {
    hubLog.value.push(`连接中断: ${e?.message || e}`);
    hubUpdating.value = false;
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
    void loadLaunchAtLogin();
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
 * 提交身份：桌面源码模式取主进程 IPC（含提交日期/脏标记），Docker 镜像与浏览器
 * 访问取服务端 /api/update/state（镜像内烤入的 /app/GIT_SHA）。
 */
const identity = computed<GitIdentity>(() => {
  const env = desktopEnv.value;
  const commit = env?.commit || state.value.commit || '';
  if (!commit) return { commit: '' };
  return { commit, commitDate: env?.commitDate || '', dirty: env?.dirty };
});

/**
 * 面板右上角版本徽标：附构建提交号（版本号仅随发版变化，提交号随每次更新/构建变化，
 * 见 lib/buildLabel.ts）；取不到提交号时退回纯版本号。
 */
const versionBadge = computed(() => {
  const base = state.value.currentVersion ? `v${state.value.currentVersion}` : '';
  return base ? formatVersionLabel(base, identity.value) : '';
});

/**
 * 桌面端版本徽标：主进程 desktop-get-env 返回 app.getVersion() 与 git 身份；
 * 仅桌面端形态显示（浏览器访问服务器时桌面端卡片仅作展示，不贴版本号）。
 */
const desktopVersionBadge = computed(() => {
  if (!isDesktop.value) return '';
  const env = desktopEnv.value as (GitIdentity & { version?: string }) | null;
  const base = env?.version ? `v${env.version}` : '';
  if (!base) return '';
  return formatVersionLabel(base, { commit: env?.commit || '', commitDate: env?.commitDate || '', dirty: env?.dirty });
});

// 分组折叠：四张分组卡片各自持久化折叠状态（锚点 id 即各卡片的 DOM id）
const serverCollapsed = computed(() => isGroupCollapsed('panel-update-server'));
const desktopCollapsed = computed(() => isGroupCollapsed('panel-update-desktop'));
const appCollapsed = computed(() => isGroupCollapsed('panel-app'));
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

const checkLabel = computed(() => fmtCheckLabel(checkResult.value));
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
    default:
      return s.enabled ? '' : '自动检查已关闭';
  }
});

/** 自动更新状态机的用户可读描述 */
const autoStatus = computed(() => {
  const s = autoState.value;
  switch (s.phase) {
    case 'checking':
      return '正在检查更新…';
    case 'downloading':
      return `发现新版本 v${s.latestVersion ?? '?'}，正在后台下载${s.percent != null ? ` ${s.percent}%` : ''}…`;
    case 'up-to-date':
      return '自动检查完成，已是最新版本';
    case 'installing':
      return s.latestVersion ? `正在安装 v${s.latestVersion}，应用即将自动重启…` : '正在安装更新，应用即将自动重启…';
    case 'failed':
      return `自动更新失败：${s.error}。可关闭后重开自动更新，或用下方「下载并安装」手动更新。`;
    case 'unconfigured':
      return '尚未配置更新源，自动更新未生效（见下方「更新源配置」）。';
    default:
      return '';
  }
});

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

/**
 * 解析用户粘贴的远端仓库地址 → { url: 服务地址, repo: owner/name }。
 * 容忍 Release/分支页后缀、缺协议、.git 后缀、末尾斜杠；只给服务首页地址时返回 error 提示。
 */
function parseRepoUrl(input: string): { url: string; repo: string } | { error: string } {
  const raw = input.trim();
  if (!raw) return { url: '', repo: '' };
  let u: URL;
  try {
    u = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    return { error: '地址格式无法识别，请粘贴浏览器地址栏的完整仓库地址' };
  }
  const segs = u.pathname.split('/').filter(Boolean);
  if (segs.length < 2) {
    return { error: '这是站点首页地址，缺少仓库路径；请先打开仓库页面再复制，例如 https://gitea.xxx.com/username/Engram' };
  }
  const owner = decodeURIComponent(segs[0]);
  const name = decodeURIComponent(segs[1]).replace(/\.git$/, '');
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    return { error: '仓库路径包含无法识别的字符，请确认复制的是仓库首页地址' };
  }
  return { url: u.origin, repo: `${owner}/${name}` };
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
  // 更新流程本体在 lib/applyUpdate.ts（与首页更新图标展开的面板共用一份实现）：
  // SSE 执行 → 等旧容器下线 → 等新容器 /health 恢复 → 自动刷新页面
  const r = await applyServerUpdate({
    log: (line) => updateLog.value.push(line),
    onWaiting: () => { healthWaiting.value = true; },
    onTimeout: () => { healthTimeout.value = true; },
  });
  if (!r.ok) {
    updating.value = false;
    healthWaiting.value = false;
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
  const r = await applyDesktopInstallerUpdate({ cfg: updateSourceCfg.value, check: desktopCheck.value });
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

// 卸载 Engram 不在这里：2026-09-24 起移到「数据与存储 → 危险操作」（DataDangerSection.vue），
// 与清库 / 清日志并列——都是不可撤销的本机动作，不放版本更新分组里

async function doRebuildShortcut() {
  const wd = wikiDesktop();
  if (!wd?.desktopRebuildShortcut) return;
  shortcutBusy.value = true;
  shortcutMessage.value = '';
  shortcutError.value = false;
  try {
    const r = await wd.desktopRebuildShortcut();
    shortcutError.value = !r?.ok;
    shortcutMessage.value = r?.ok ? r.message || '已重建桌面快捷方式' : r?.error || '重建失败';
    if (r?.ok) notify.success('桌面快捷方式已重建');
  } catch (e: any) {
    shortcutError.value = true;
    shortcutMessage.value = e?.message || '重建失败';
  } finally {
    shortcutBusy.value = false;
  }
}

/** 读取开机自启状态（注册表实况）；旧版壳无此 API 时整行隐藏 */
async function loadLaunchAtLogin() {
  const wd = wikiDesktop();
  if (!wd?.getLaunchAtLogin) {
    launchAtLoginSupported.value = false;
    return;
  }
  try {
    const s = await wd.getLaunchAtLogin();
    launchAtLogin.value = s;
    launchAtLoginSupported.value = Boolean(s?.supported);
  } catch {
    launchAtLoginSupported.value = false;
  }
}

async function toggleLaunchAtLogin(e: Event) {
  const wd = wikiDesktop();
  const enabled = (e.target as HTMLInputElement).checked;
  if (!wd?.setLaunchAtLogin) return;
  launchAtLoginBusy.value = true;
  launchAtLoginMessage.value = '';
  try {
    const r = await wd.setLaunchAtLogin(enabled);
    if (r?.ok === false) {
      launchAtLoginError.value = true;
      launchAtLoginMessage.value = r.error || '设置失败';
      await loadLaunchAtLogin(); // 回读真实状态，避免开关停在用户点的那一侧
      return;
    }
    launchAtLogin.value = r;
    launchAtLoginError.value = false;
    launchAtLoginMessage.value = enabled
      ? '已开启：下次登录 Windows 会静默启动到系统托盘，不弹主窗口。'
      : '已关闭：登录 Windows 后不再自动启动。';
  } catch (e: any) {
    launchAtLoginError.value = true;
    launchAtLoginMessage.value = e?.message || '设置失败，请重试';
    await loadLaunchAtLogin();
  } finally {
    launchAtLoginBusy.value = false;
  }
}

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
    wd.getDesktopEnv().then((env: any) => {
      desktopEnv.value = env;
      sourceMode.value = Boolean(env && !env.packaged && env.platform === 'win32');
    });
  }
  if (wd?.onUpdateProgress) {
    offProgress = wd.onUpdateProgress((p: any) => {
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
  // 桌面快捷方式重建入口：旧版壳无此 API 时该行自动隐藏（「桌面端应用」分组）
  shortcutSupported.value = Boolean(wd?.desktopRebuildShortcut);
  // 开机自启：旧版壳无此 API 时该行自动隐藏（「桌面端应用」分组）；托盘菜单里改开关时靠订阅同步
  void loadLaunchAtLogin();
  if (wd?.onLaunchAtLoginState) {
    offLaunchAtLogin = wd.onLaunchAtLoginState((s: any) => {
      launchAtLogin.value = s;
      launchAtLoginSupported.value = Boolean(s?.supported);
    });
  }
});
onUnmounted(() => {
  offProgress?.();
  offAutoState?.();
  offSourceState?.();
  offLaunchAtLogin?.();
});
</script>

<style scoped>
.integration-note {
  margin: 14px 24px 18px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
}

.check-controls {
  display: flex;
  align-items: center;
  gap: 12px;
}
/* 更新通道行：下拉即时保存 + 短暂「已保存」提示 */
.channel-control {
  display: flex;
  align-items: center;
  gap: 10px;
}
.channel-saved {
  color: var(--success);
  font-size: 12px;
  white-space: nowrap;
}
.check-status {
  font-size: 12px;
  color: var(--text-faint);
}
.check-status.has {
  color: var(--accent, #3b82f6);
  font-weight: 600;
}

/* 分组卡片（flush 内容）内的行级消息：全局规则只覆盖面板直接子级，这里补齐边距；
   位于 setting-row 内的消息保持网格定位不加边距 */
.setting-message {
  margin: 0 24px 14px;
}
.setting-row .setting-message {
  margin: 0;
}

/* 凭据方式二选一分段按钮 */
.auth-type-toggle {
  display: inline-flex;
  gap: 4px;
  margin-top: 8px;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
}
.seg-btn {
  padding: 5px 14px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.seg-btn.active {
  background: var(--bg);
  color: var(--text);
  font-weight: 600;
  box-shadow: 0 1px 2px rgb(0 0 0 / 12%);
}
.setting-message.hint {
  margin: 6px 0 0;
  color: var(--text-faint);
}

/* 凭据行：标签+切换按钮在上，输入框统一排在切换按钮下方 */
.setting-row.credential-row {
  grid-template-columns: 1fr;
}
.credential-inputs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
.credential-inputs input {
  flex: 1 1 220px;
  max-width: 420px;
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
.password-clear-hint {
  flex-basis: 100%;
}
.credential-inputs .hint {
  flex-basis: 100%;
}

.update-log {
  margin: 12px 24px;
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
  margin: -4px 24px 12px;
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

@media (max-width: 768px) {
  .integration-note {
    margin: 12px 18px 16px;
  }
  .setting-message {
    margin: 0 18px 14px;
  }
  .setting-row .setting-message {
    margin: 0;
  }
  .update-log {
    margin: 12px 18px;
  }
  .update-progress {
    margin: -4px 18px 12px;
  }
}

@media (max-width: 640px) {
  .check-controls {
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
  }
}
</style>
