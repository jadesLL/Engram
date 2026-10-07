<template>
  <section class="settings-panel settings-native settings-group level-normal">
    <div class="group-card" :class="{ 'is-collapsed': groupCollapsed }">
      <div class="group-band collapsible" @click="onBandClick">
        <span class="group-ico" aria-hidden="true"><Icon name="refresh" :size="16" /></span>
        <span class="group-text">
          <span class="group-title">同步群组</span>
          <span class="group-hint">把多台设备组成一个同步群组：只要求中枢设备可被其他设备访问，成员设备之间无需互通</span>
        </span>
        <span v-if="roleBadge" class="group-badge" :class="`tone-${roleBadgeTone}`">{{ roleBadge }}</span>
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

    <!-- 运行状态摘要：一眼看出「正常不正常」，细节在「同步详情」独立窗口里。
         旧版把状态网格 + 一个 260px 高的可展开日志塞在这张卡片里：日志只有 30 条、
         没有级别/成员/时间，还把设置页拉得很长。摘要放最上面（角色卡/成员管理之前），
         中枢与成员都先看到它，再往下看各自的配置。 -->
    <div v-if="status && status.role !== 'none'" class="sync-summary">
      <!-- 运行状态摘要：实时状态同样走状态条（底框 + 状态点），别和灰色说明文字混在一起 -->
      <div class="summary-line state-strip" :class="summaryHealthy ? 'tone-ok' : 'tone-warn'">
        <span class="state-dot" aria-hidden="true" />
        <strong :class="summaryHealthy ? 'ok' : 'bad'">{{ connectionLabel }}</strong>
        <span class="summary-detail">{{ summaryDetail }}</span>
      </div>
      <p v-if="status.lastError" class="sync-error">最近错误：{{ status.lastError }}</p>
      <div class="sync-actions">
        <button class="btn" type="button" @click="openSyncLogDrawer">
          <Icon name="activity" :size="14" />
          查看同步详情
        </button>
      </div>
    </div>

    <!-- 未配置：选择角色 -->
    <template v-if="status && status.role === 'none'">
      <div class="role-cards">
        <div v-if="canBeHub" class="role-card">
          <h4>这台设备作为中枢</h4>
          <p>中枢保存群组权威数据，可查看每个成员的连接状态，并为成员设备生成绑定令牌。建议由常开的 NAS Docker 版担任。</p>
          <button class="btn primary" type="button" :disabled="saving" @click="becomeHub">作为中枢启用</button>
        </div>
        <div class="role-card">
          <h4>加入同步群组</h4>
          <p>绑定到已有的中枢：在中枢上「添加成员」后会给出二维码与邀请链接——手机扫一下、或把链接发过来粘贴，中枢地址与绑定令牌就自动填好了；也可以按老办法手填。绑定后本机照常离线工作，联网时自动双向同步。</p>
          <button class="btn" type="button" @click="pickJoin = true">绑定中枢</button>
        </div>
      </div>

      <div v-if="pickJoin" class="sync-config">
        <!-- 邀请链接导入：中枢那头的「复制邀请链接 / 二维码」就是喂给这两条路的——
             粘贴导入是「一键复制链接」的对端，扫码是手机对着中枢屏幕。两者二选一，都不用再手抄。 -->
        <div class="field-row invite-import">
          <label for="sync-invite">邀请链接（可选）</label>
          <div class="invite-import-row">
            <input
              id="sync-invite"
              v-model="inviteText"
              type="text"
              placeholder="engram://join?hub=…&token=…"
              spellcheck="false"
              @input="applyInviteText()"
            />
            <button class="btn small" type="button" @click="pasteInvite">粘贴</button>
            <button v-if="scanSupported" class="btn small" type="button" @click="scanning = true">
              <Icon name="scan" :size="14" />
              扫码
            </button>
          </div>
          <p v-if="inviteNotice" class="invite-notice" :class="inviteNoticeTone">{{ inviteNotice }}</p>
          <p v-else class="faint small">
            在中枢那台设备的「同步群组 → 添加成员」里点「复制邀请链接」发过来粘贴；手机端也可以直接扫中枢屏幕上的二维码。
          </p>
        </div>
        <div class="field-row">
          <label for="sync-hub-url">中枢地址</label>
          <input id="sync-hub-url" v-model="hubUrl" type="text" placeholder="http://192.168.x.x:18080 或 https://engram.xxx.com" spellcheck="false" />
        </div>
        <div class="field-row">
          <label for="sync-hub-token">绑定令牌</label>
          <SecretField id="sync-hub-token" v-model="hubToken" placeholder="lsync_…" />
        </div>
        <div v-if="capabilities.runtime === 'android-local'" class="field-row">
          <label for="sync-direct-urls">局域网 / IPv6 直连地址（可选，每行一个）</label>
          <textarea id="sync-direct-urls" v-model="directUrlsText" rows="2" placeholder="http://192.168.x.x:18080" spellcheck="false" />
        </div>
        <div class="sync-actions">
          <button class="btn primary" type="button" :disabled="saving" @click="joinHub">保存并绑定</button>
        </div>
      </div>
    </template>

    <!-- 中枢：群组管理 -->
    <template v-else-if="status && status.role === 'hub'">
      <div class="role-banner">
        <div>
          <strong>本设备是同步群组的中枢</strong>
          <span class="faint">成员绑定地址：{{ primaryHubAddress || '暂无可用地址（见下方说明）' }}</span>
          <span v-if="deviceNameLine" class="faint small">{{ deviceNameLine }}</span>
        </div>
        <button class="text-action danger" type="button" @click="leaveRole('none')">退出中枢角色</button>
      </div>

      <!-- 成员绑定地址：**不能用 location.origin**。桌面版（内嵌服务只监听 127.0.0.1）打开设置页
           时它永远是 http://127.0.0.1:18180，用户照着填到手机上必然连不上——真机上就是这么
           报回来的。地址清单由服务端算（/api/sync/hub-addresses）：剔除回环、只留真正可达的
           地址；一条都给不出时说清原因，并在桌面端给出「允许局域网访问」的一键开关。 -->
      <div class="member-addresses">
        <div class="address-head">
          <strong>成员绑定地址</strong>
          <span class="faint small">别的设备在「多端同步 → 绑定中枢」里填这里的地址，配上下面生成的绑定令牌</span>
        </div>
        <ul v-if="hubAddresses.length" class="address-list">
          <li v-for="item in hubAddresses" :key="item.url" class="address-row">
            <span class="address-kind">{{ item.label }}</span>
            <code class="address-url">{{ item.url }}</code>
            <button class="btn small" type="button" @click="copy(item.url)">复制</button>
          </li>
        </ul>
        <p v-if="hubAddressNotice" class="address-warn">{{ hubAddressNotice }}</p>
        <p v-if="hubSkippedNotice" class="faint small">{{ hubSkippedNotice }}</p>
        <label v-if="lanAccessSupported" class="lan-access-toggle">
          <input v-model="lanAccess" type="checkbox" :disabled="lanBusy" @change="toggleLanAccess" />
          <span>
            <strong>允许局域网访问</strong>
            <span class="faint small">
              开启后本地服务监听 0.0.0.0（随即自动重启，窗口会重新加载），局域网里的手机 / 其他电脑才连得上这台中枢；
              关闭则只有这台电脑能访问（默认）。首次开启时 Windows 可能弹出防火墙询问，选「专用网络」允许。
            </span>
          </span>
        </label>
      </div>

      <div class="peers-block">
        <div class="peers-head">
          <h4>群组成员（{{ peers.length }}）</h4>
          <button class="btn small" type="button" :disabled="creating" @click="addPeer">添加成员</button>
        </div>
        <p class="faint small">
          为每台成员设备命名并生成绑定令牌；这个名字就是各端看到的「来自 &lt;名字&gt;」（不再用设备主机名）。
          点成员右侧的「邀请」会给出二维码与邀请链接——手机扫码、其他端粘贴链接即可绑定，不必手抄；
          也可以照旧把令牌与中枢地址填到对应设备的「多端同步」设置里。点击令牌可展开查看完整值。
        </p>
        <ul v-if="peers.length" class="peer-list">
          <li v-for="p in peers" :key="p.id" class="peer-row">
            <div class="peer-info">
              <strong>
                <span class="dot" :class="p.online ? 'on' : 'off'" />{{ p.name }}
              </strong>
              <span class="faint small">
                {{ p.online ? '在线' : '离线' }}
                <!-- 上报的设备名与成员名一致时不重复显示；旧客户端报的是主机名，留着方便排查 -->
                <template v-if="p.node_label && p.node_label !== p.name"> · 设备名 {{ p.node_label }}</template>
                <template v-if="p.last_seen_at"> · 最近同步 {{ formatTime(p.last_seen_at) }}</template>
              </span>
              <span class="token-line faint small">
                令牌
                <SecretField mode="text" :value="p.token" copyable class="token-code-host" />
              </span>
            </div>
            <div class="peer-actions">
              <button class="btn small" type="button" @click="showPeerInvite(p)">邀请</button>
              <button class="btn small" type="button" @click="regenPeer(p)">重置令牌</button>
              <button class="text-action danger" type="button" @click="revokePeer(p)">移除</button>
            </div>
          </li>
        </ul>
        <p v-else class="empty-panel">还没有成员。点「添加成员」为第一台设备生成绑定令牌。</p>
      </div>

      <div v-if="newPeer" class="new-peer-card">
        <h4>「{{ newPeer.name }}」绑定信息</h4>
        <div class="field-row">
          <label>中枢地址</label>
          <div class="copy-row">
            <template v-if="primaryHubAddress">
              <code>{{ primaryHubAddress }}</code>
              <button class="btn small" type="button" @click="copy(primaryHubAddress)">复制</button>
            </template>
            <span v-else class="faint small">暂无可用地址，见上方「成员绑定地址」的说明</span>
          </div>
        </div>
        <p v-if="hubAddresses.length > 1" class="faint small">
          这台中枢共 {{ hubAddresses.length }} 条可用地址（见上方），选与这台设备同网络的那条。
        </p>
        <div class="field-row">
          <label>绑定令牌</label>
          <div class="copy-row">
            <SecretField mode="text" :value="newPeer.token" copyable class="token-code-host" />
            <button class="btn small" type="button" @click="copy(newPeer.token)">复制</button>
          </div>
        </div>

        <!-- 二维码 + 邀请链接：手机扫一下、其他端粘贴一下，省掉手抄地址与 54 位令牌。
             中枢有多条可达地址时（局域网 + 域名）先选一条，链接与二维码都按它生成。 -->
        <div v-if="hubAddresses.length > 1" class="field-row invite-address-row">
          <label for="sync-invite-address">邀请链接用的地址</label>
          <AppSelect id="sync-invite-address" v-model="inviteAddressUrl" :options="inviteAddressOptions" />
        </div>
        <div v-if="inviteLink" class="invite-card">
          <QrCode :text="inviteLink" :size="260" :alt="`邀请「${newPeer.name}」加入同步群组的二维码`" />
          <div class="invite-card-body">
            <strong>让「{{ newPeer.name }}」扫码或粘贴链接</strong>
            <p class="faint small">
              手机端：设置 → 多端同步 → 绑定中枢 → 扫码，对准左边这个二维码；
              其他端：点下面的「复制邀请链接」发到那台设备，在「绑定中枢」里粘贴导入。两种方式二选一。
            </p>
            <div class="invite-actions">
              <button class="btn small primary" type="button" @click="copyInviteLink">
                <Icon name="link" :size="14" />
                复制邀请链接
              </button>
            </div>
            <p class="faint small">
              链接里含这枚绑定令牌，只发给这一台设备；绑定成功后可在成员列表里重置令牌。
            </p>
          </div>
        </div>
        <p v-else class="faint small">
          这条邀请暂时只能手抄：没有可用的成员绑定地址（见上方说明）——先在部署侧声明对外地址，
          或打开「允许局域网访问」后回到这里，二维码会自动出现。
        </p>
        <button class="btn small" type="button" @click="newPeer = null">我已保存，关闭</button>
      </div>

      <!-- DDNS 2026-09-28 起独立成组（方案 A）：它只在担任中枢时存在，卡片见本文件末尾的第二个根节点 -->
    </template>

    <!-- 成员：绑定与状态 -->
    <template v-else-if="status">
      <div class="role-banner">
        <div>
          <strong>已绑定同步中枢</strong>
          <span class="faint">{{ status.hubUrl || '—' }}</span>
          <span v-if="deviceNameLine" class="faint small">{{ deviceNameLine }}</span>
        </div>
        <button class="text-action danger" type="button" @click="leaveRole('none')">解除绑定</button>
      </div>
      <div class="sync-config">
        <div class="field-row">
          <label for="sync-hub-url">中枢地址</label>
          <input id="sync-hub-url" v-model="hubUrl" type="text" spellcheck="false" />
        </div>
        <div class="field-row">
          <label for="sync-hub-token">绑定令牌</label>
          <SecretField id="sync-hub-token" v-model="hubToken" :stored="status.hubToken" />
        </div>
        <div v-if="capabilities.runtime === 'android-local'" class="field-row">
          <label for="sync-direct-urls-member">局域网 / IPv6 直连地址（可选，每行一个）</label>
          <textarea id="sync-direct-urls-member" v-model="directUrlsText" rows="2" placeholder="http://192.168.x.x:18080" spellcheck="false" />
        </div>
        <div class="sync-actions">
          <button class="btn" type="button" :disabled="saving" @click="saveBinding">保存修改</button>
          <button class="btn" type="button" :disabled="reconciling" @click="reconcileNow">{{ reconciling ? '对账中…' : '立即全量对账' }}</button>
        </div>
      </div>

      <!-- 双栈连接：2026-09-29 起独立成组（多端同步 → 双栈连接），内容见本文件末尾的第二个根节点。
           它只在本机作为成员连接中枢域名时才有内容，因此除了那里的 v-if，
           还把同一条件登记进导航（useSettingsAnchorVisible），避免中枢设备留下一个点不动的死锚点。 -->
    </template>

    <!-- 运行状态的位置见卡片顶部（中枢与成员共用同一行摘要） -->

    <div v-if="status && status.role !== 'none'" class="sync-role-note">
      <p>同步范围：页面、附件图片、原始资料文件、证据账本、内置 Agent 会话与任务看板。各端密码、令牌、模型配置保持独立。
        两端同时修改同一页面时按字符级智能合并；无法自动合并的冲突以修改时间最新的一方为准：
        普通页面中被取代的旧版本以「原名-时间」重命名保留在原目录（可删除），AI 工作区直接以最新为准覆盖，不产生新文件。</p>
      <p>会话只在一轮回复结束后同步（正在对话中的内容留在本机），消息按条合并、各端看到的历史一致；
        任务看板全端只有一份，任意端刷新后各端都换成最新那一版（标注「上次更新时间」与来源设备）。
        会话列表里本机产生的会话标「本机」，别端来的标「来自 &lt;成员名&gt;」——名字取这里给设备起的成员名，不是设备主机名。</p>
    </div>

      </div>
    </div>
  </section>

  <SettingsGroup class="settings-native" anchor="sync-content" title="同步内容" hint="每类内容独立控制；主页卡片和设置默认关闭，其余默认开启">
    <p class="faint small">开关仅保存在本机，关闭后不上传也不接收该类内容，已同步的数据会保留。主页卡片和设置需在中枢及成员端分别开启。</p>
    <div class="sync-category-list">
      <label v-for="item in syncCategoryItems" :key="item.key" class="sync-category-row">
        <input type="checkbox" :checked="categoryEnabled(item.key)" :disabled="saving || !status?.categories" @change="saveCategory(item.key, $event)" />
        <span><strong>{{ item.label }}</strong><span class="faint small">{{ item.hint }}</span></span>
        <span class="faint small">{{ categoryEnabled(item.key) ? '已开启' : '已关闭' }}</span>
      </label>
    </div>
  </SettingsGroup>

  <!-- 局域网优先：2026-09-28 起是「多端同步」下自己的分组（与「双栈连接」「DDNS 直连域名」同级）。
       它和双栈连接回答的是同一个问题的两半——「先走哪条路」（局域网 → IPv6 → IPv4），
       因此同样只在本机作为成员时才有内容，条件与 showDualStack 一致并登记进导航。
       分组顺序 = 页面顺序：它在双栈连接之前登记，见 settingsDomains.test.ts 的顺序守卫。 -->
  <SettingsGroup
    v-if="showLanGroup"
    class="settings-native"
    anchor="sync-lan"
    title="局域网优先"
    hint="中枢与本机同网段时优先直连内网地址：延迟最低，不占公网、不绕隧道"
    :badge="lanBadge"
    :badge-tone="lanBadgeTone"
  >
    <div class="lan-config">
      <label class="lan-toggle">
        <input v-model="preferLan" type="checkbox" :disabled="saving" @change="savePreferLan" />
        <span>
          <strong>优先局域网</strong>
          <span class="faint small">
            同网段时先试中枢通告的内网地址，探不到再按中枢地址本身的顺序连（跨网段、容器网络、VPN、
            手机蜂窝这些场景探不到内网地址，此时行为与不开这个开关完全一样）。
          </span>
        </span>
      </label>

      <!-- 实时状态（会变）走状态条：底框 + 状态点，与上面的灰色说明文字区分开 -->
      <p class="lan-state state-strip" :class="lanChannelClass">
        <span class="state-dot" aria-hidden="true" />
        <span>{{ lanStateText }}</span>
      </p>

      <div class="lan-probes">
        <p class="lan-probes-title">候选地址探测记录</p>
        <ul v-if="lanCandidates.length" class="lan-probe-list">
          <li v-for="(item, index) in lanCandidates" :key="`${item.kind}-${item.url}-${index}`">
            <span class="lan-probe-kind">{{ item.label }}</span>
            <code class="lan-probe-url">{{ item.url }}</code>
            <span v-if="item.ok" class="lan-probe-ok">
              ✓ {{ typeof item.latencyMs === 'number' ? `${item.latencyMs}ms` : '可达' }}
            </span>
            <span v-else class="lan-probe-bad">✗ {{ item.error || '不可达' }}</span>
          </li>
        </ul>
        <p v-else class="faint small">还没有探测记录：下一轮连接会先试局域网，再按中枢地址逐级降级。</p>
      </div>

      <p class="lan-note faint small">
        优先级固定为 局域网 → IPv6 → IPv4，三个都不通才算断开（断开时本机照常读写，改动排队等恢复）。
        命中后地址会被缓存，网络切换或定期重探一轮，恢复了自动升回上一级。
      </p>
    </div>
  </SettingsGroup>

  <!-- 双栈连接：2026-09-29 起独立成组（多端同步 → 双栈连接，与「同步群组」「DDNS 直连域名」同级）。
       在此之前它是成员端绑定表单下面的一块平铺内容：与上面的表单只剩 4px（相邻 margin 折叠），
       既贴得近、又不能收起；提成独立分组后既有自己的目录项与色带折叠，间距也和别的分组一致。
       只在本机作为成员连中枢域名时才有内容：条件同样登记进导航（见 setup 里的
       useSettingsAnchorVisible），非成员设备不会留下点不动的死锚点。
       分组顺序 = 页面顺序：它在 DDNS 分组之前登记，见 settingsDomains.test.ts 的顺序守卫。 -->
  <SettingsGroup
    v-if="showDualStack"
    class="settings-native"
    anchor="sync-dualstack"
    title="双栈连接（IPv6 优先）"
    hint="中枢域名同时有 IPv4/IPv6 时先走 IPv6，连不上自动改用 IPv4；协议族只在两次传输之间切换"
    :badge="dualStackBadge"
    :badge-tone="dualStackBadgeTone"
  >
    <div class="dualstack-config">
      <label class="dualstack-toggle">
        <input v-model="dualStack.enabled" type="checkbox" @change="saveDualStack(true)" />
        <span>
          <strong>启用双栈策略</strong>
          <span class="faint small">
            关掉后域名连接交回系统默认（IPv6/IPv4 由操作系统排序）。恢复即自动切回；
            切换只发生在两次传输之间，不会打断正在上传／下载的文件。
          </span>
        </span>
      </label>
      <!-- 实时状态（会变）走状态条：底框 + 状态点，与上面的灰色说明文字区分开（2026-09-27） -->
      <p v-if="dualStackStateText" class="dualstack-state state-strip" :class="dualStackTone">
        <span class="state-dot" aria-hidden="true" />
        <span>{{ dualStackStateText }}</span>
      </p>
      <div v-show="dualStack.enabled" class="dualstack-fields">
        <div class="field-row">
          <label for="ds-failures">判定 IPv6 不通：连续失败</label>
          <div class="ds-inputs">
            <input id="ds-failures" v-model.number="dualStack.failureThreshold" type="number" min="1" max="20" />
            <span class="faint small">次，或累计卡住</span>
            <input id="ds-window" v-model.number="dualStack.windowSeconds" type="number" min="1" max="120" />
            <span class="faint small">秒（任一满足即改用 IPv4）</span>
          </div>
        </div>
        <div class="field-row">
          <label for="ds-probe">回探节奏：IPv4 每成功</label>
          <div class="ds-inputs">
            <input id="ds-probe" v-model.number="dualStack.probeAfterSuccesses" type="number" min="1" max="1000" />
            <span class="faint small">次回探一次 IPv6；单次连接超时</span>
            <input id="ds-timeout" v-model.number="dualStack.connectTimeoutMs" type="number" min="500" max="30000" step="500" />
            <span class="faint small">毫秒</span>
          </div>
        </div>
        <div class="sync-actions">
          <button class="btn" type="button" :disabled="saving" @click="saveDualStack()">保存双栈设置</button>
        </div>
      </div>
    </div>
  </SettingsGroup>

  <!-- DDNS 直连域名：2026-09-28 起独立成组（方案 A）——它只在「这台设备担任中枢」时才有内容，
       因此除了这里的 v-if，还把同一条件登记进导航（useSettingsAnchorVisible），
       避免非中枢设备留下一个点不动的死锚点。 -->
  <SettingsGroup
    v-if="showDdns"
    class="settings-native"
    anchor="sync-ddns"
    title="DDNS 直连域名"
    hint="只有中枢可开启：把一条域名指向中枢公网 IP，成员绑定中枢时可直接填这个域名"
  >
    <DdnsSection />
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
import { isGroupCollapsed, toggleGroupCollapsed } from '../../lib/settingsCollapse';
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
  { key: 'homeCards', label: '主页卡片多端同步', hint: '卡片种类、顺序、尺寸和布局；默认关闭' },
  { key: 'settings', label: '设置多端同步', hint: '主题、编辑模式、搜索同义词、专名勘误、AI 工作区显示偏好；默认关闭。账户凭据、绑定和本机配置不参与' },
  { key: 'knowledge', label: '知识库多端同步', hint: '知识页面、普通附件和收集箱' },
  { key: 'materials', label: '原始资料多端同步', hint: '文档、对话、灵感碎片及提炼状态' },
  { key: 'assets', label: '图片资产多端同步', hint: '页面引用的图片文件' },
  { key: 'aiWorkspace', label: 'AI 工作区多端同步', hint: '自动生成的日志、索引和关系库' },
  { key: 'sessions', label: '会话多端同步', hint: '已完成的 Agent 会话（手机端直接访问中枢会话）' },
  { key: 'board', label: '任务看板多端同步', hint: '最新提炼的任务看板（手机端直接访问中枢看板）' },
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
const inviteLink = computed(() => {
  const peer = newPeer.value;
  if (!peer || !inviteHubUrl.value) return '';
  return buildInviteLink({ hubUrl: inviteHubUrl.value, token: peer.token, name: peer.name });
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
  if (role === 'hub') return '中枢运行中';
  if (role === 'member') return '已绑定中枢';
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

const connectionLabel = computed(() => {
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
  try {
    await navigator.clipboard.writeText(text);
    notify.success('已复制');
  } catch {
    notify.error('复制失败，请手动选择复制');
  }
}

/** 复制邀请链接：一句话说清「这条链接拿去干什么」（与上面通用复制的提示区分开） */
async function copyInviteLink(): Promise<void> {
  const link = inviteLink.value;
  if (!link) return;
  try {
    await navigator.clipboard.writeText(link);
    notify.success('邀请链接已复制：发到那台设备上粘贴导入，或用手机扫二维码');
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
  inviteNotice.value = `已识别：${describeInvite(invite)}。确认无误后点下面的「保存并绑定」。`;
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
  if (applyInviteText()) notify.success('已从二维码读出中枢地址与绑定令牌');
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
  inviteText.value = raw;
  if (applyInviteText()) notify.success('已从邀请链接填好中枢地址与绑定令牌');
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
  pollTimer = window.setInterval(loadStatus, 5000);
});

// 面板已经在设置页开着、用户又点了一条邀请链接（如从聊天软件切回来）：同样就地填表
watch(pendingJoinLink, () => applyPendingJoinLink());

onUnmounted(() => {
  if (pollTimer !== null) window.clearInterval(pollTimer);
});
</script>

<style scoped>
.sync-category-list { display: grid; gap: 8px; }
.sync-category-row { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--border); }
.sync-category-row > span:first-of-type { flex: 1; min-width: 0; display: grid; gap: 4px; }
.sync-category-row > input { flex-shrink: 0; accent-color: var(--success); }
.sync-category-row > span:last-child { white-space: nowrap; color: var(--text-faint); }
.sync-category-row > input:checked ~ span:last-child { color: var(--success); }
.role-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr));
  gap: 14px;
  margin: 22px 4px 16px;
}
.role-card {
  border: 1px solid var(--border, rgba(127, 127, 127, 0.25));
  border-radius: 8px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.role-card h4 { margin: 0; }
.role-card p { margin: 0; font-size: 13px; line-height: 1.6; opacity: 0.85; flex: 1; }

.role-banner {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  background: var(--bg-soft, rgba(127, 127, 127, 0.08));
  border-radius: 8px;
  padding: 12px 14px;
  margin: 22px 4px 16px;
  flex-wrap: wrap;
}
.role-banner div { display: flex; flex-direction: column; gap: 2px; font-size: 14px; }

.sync-role-note {
  background: var(--bg-soft, rgba(127, 127, 127, 0.08));
  border-radius: 8px;
  padding: 12px 14px;
  font-size: 13px;
  line-height: 1.7;
  margin: 0 4px 16px;
}
.sync-role-note p { margin: 0; }

.peers-block { margin: 0 4px 16px; }
.peers-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.peers-head h4 { margin: 0; }
.peer-list {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.peer-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  background: var(--bg-soft, rgba(127, 127, 127, 0.08));
  border-radius: 8px;
  padding: 10px 12px;
}
.peer-info { display: flex; flex-direction: column; gap: 2px; }
.peer-info strong { display: flex; align-items: center; gap: 8px; }
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}
.dot.on { background: var(--success, #2e9e5b); }
.dot.off { background: var(--border, rgba(127, 127, 127, 0.4)); }
.peer-actions { display: flex; align-items: center; gap: 10px; }

/* 成员绑定地址：一条地址一行（标签 + 地址 + 复制），没有地址时给一句可执行的说明 */
.member-addresses {
  margin: 0 4px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.address-head { display: flex; flex-direction: column; gap: 2px; }
.address-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.address-row {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--bg-soft, rgba(127, 127, 127, 0.08));
  border-radius: 8px;
  padding: 8px 12px;
  flex-wrap: wrap;
}
.address-kind {
  font-size: 12px;
  color: var(--text-faint);
  white-space: nowrap;
}
.address-url {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.address-warn {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--warning-text, #b8860b);
  background: var(--bg-soft, rgba(127, 127, 127, 0.08));
  border-radius: 8px;
  padding: 10px 12px;
}
.lan-access-toggle {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 13px;
  line-height: 1.7;
}
.lan-access-toggle > span { display: flex; flex-direction: column; gap: 2px; }
.lan-access-toggle input { margin-top: 3px; }

.token-line {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.token-line .token-code-host {
  min-width: 0;
}
.copy-row .token-code-host {
  flex: 1;
  min-width: 0;
}

.new-peer-card {
  border: 1px solid var(--warning, #d8a012);
  border-radius: 8px;
  padding: 14px;
  margin: 0 4px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.new-peer-card h4 { margin: 0; font-size: 14px; }

/* ---- 邀请：二维码 + 复制链接（中枢）/ 粘贴 + 扫码（成员） ---- */
/* 二维码与说明左右排：窄屏（手机看中枢设置页）自动换行，二维码不会被压小 */
.invite-card {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  flex-wrap: wrap;
  background: var(--bg-soft, rgba(127, 127, 127, 0.08));
  border-radius: 8px;
  padding: 12px;
}
.invite-card-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
  min-width: min(240px, 100%);
}
.invite-card-body strong { font-size: 13px; }
.invite-card-body p { margin: 0; }
.invite-actions { display: flex; gap: 10px; flex-wrap: wrap; }
.invite-address-row { max-width: 520px; }

.invite-import-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.invite-import-row input { flex: 1; min-width: min(220px, 100%); }
.invite-import-row .btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.invite-notice {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  word-break: break-all;
}
.invite-notice.ok { color: var(--success, #2e9e5b); }
.invite-notice.bad { color: var(--danger, #d64545); }
.copy-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.copy-row code {
  flex: 1;
  word-break: break-all;
  background: var(--bg-soft, rgba(127, 127, 127, 0.08));
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 12px;
}

.sync-config {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0 4px 4px;
}
.field-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field-row label { font-size: 13px; font-weight: 600; }
.field-row input,
.field-row textarea,
.field-row :deep(input) {
  padding: 8px 10px;
  font-size: 13px;
}
.sync-actions { display: flex; gap: 10px; }

/* 运行状态摘要：一眼看出「正常不正常」，细节在「同步详情」独立窗口里（设置页不再被日志拉长）。
   实时状态用全局 .state-strip（底框 + 状态点），这里只留摘要自己的排版 */
.sync-summary {
  margin: 8px 4px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.summary-line {
  flex-wrap: wrap;
  font-size: 13px;
}
.summary-line strong.ok { color: var(--success, #2e9e5b); }
.summary-line strong.bad { color: var(--danger, #d64545); }
.sync-summary .sync-actions { align-items: center; }
.sync-summary .btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.sync-error {
  color: var(--danger, #d64545);
  font-size: 12px;
  margin: 0;
  word-break: break-all;
}

.faint { opacity: 0.65; }
.small { font-size: 12px; }
.empty-panel { font-size: 13px; opacity: 0.7; }

/* 双栈连接：2026-09-29 起是独立分组（多端同步 → 双栈连接），卡片外框、色带、折叠箭头
   与间距都由 SettingsGroup / settings.css 统一给，这里只排卡内内容。
   在此之前它是成员端绑定表单下面的一块平铺内容：与表单只剩 4px（相邻 margin 折叠）、
   又不能收起——用户报「和上面的贴得太近，而且不能收缩」。 */
.dualstack-config {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.dualstack-toggle {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  cursor: pointer;
}
.dualstack-toggle input { margin-top: 3px; }
.dualstack-toggle > span { display: flex; flex-direction: column; gap: 6px; }
.dualstack-state { margin: 0; word-break: break-all; }
.dualstack-fields { display: flex; flex-direction: column; gap: 12px; }
.ds-inputs { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ds-inputs input { width: 92px; }

/* 局域网优先：与「双栈连接」同一套卡内排版（卡片外框与色带由 SettingsGroup / settings.css 给） */
.lan-config {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.lan-toggle {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  cursor: pointer;
}
.lan-toggle input { margin-top: 3px; }
.lan-toggle > span { display: flex; flex-direction: column; gap: 6px; }

/* 状态点跟着通道走：颜色来自 .link-<key> 的 --channel（与侧栏胶囊同一颗颜色），
   这里只提高优先级盖过 settings.css 里 .state-strip .state-dot 的中性底色 */
.lan-state .state-dot { background: var(--channel); }
.lan-state { margin: 0; word-break: break-all; }

.lan-probes { display: flex; flex-direction: column; gap: 6px; }
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
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.lan-probe-list li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  font-size: 12.5px;
}
.lan-probe-kind { flex: none; color: var(--text-secondary); }
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
.lan-note { margin: 0; line-height: 1.6; }

@media (max-width: 768px) {
  /* 分组卡片在移动端已由 settings.css 收窄，内部块只需跟随 4px 内边距 */
  .ddns-block {
    padding-bottom: 6px;
  }
}
</style>
