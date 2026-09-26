# IPv6 直连优先 + Cloudflare 隧道兜底（智能接入）

Engram 的远程访问支持双通道自动择优：客户端启动时按「直连地址 → 上次成功通道 → 主地址」逐个探测（`/health`，直连 1.5 秒、其余 3.5 秒强制超时），**IPv6/局域网直连可达就秒进直连**（低延迟、无中转、不占隧道流量），不可达自动落回主地址（如 Cloudflare Tunnel，永保可用）。直连恢复后的下一次启动自动切回，全程无感。

```
手机 / 浏览器
  ├─ 直连通道（优先）：手机蜂窝 IPv6 ──运营商路由──▶ 家宽 IPv6 ──▶ Engram
  │   例：http://<ddns.xxx.com>:18080   ← 需路由器放行 IPv6 入站（一次性）
  └─ 隧道兜底：Cloudflare Tunnel（或任何可公网访问的主地址）
      例：https://engram.xxx.com
```

仓库代码零域名硬编码：直连地址由**服务端通告**——部署侧在 `main/.env`（不入库）配置 `DIRECT_ACCESS_URL`，经 `/health` 下发给已登录客户端；Android 本地优先版可在 设置 → 多端同步 → 同步群组 为中枢额外填写局域网 / IPv6 直连地址，主地址不可达时按顺序尝试。

## 服务端配置（部署侧）

1. 在 `main/` 同目录创建/编辑 `.env`（该文件被 gitignore，不会入库）：

   ```dotenv
   DIRECT_ACCESS_URL=http://<你的DDNS域名>:<端口>
   # 例：DIRECT_ACCESS_URL=http://ddns.xxx.com:18080
   ```

   注意：compose 会自动读取同目录 `.env` 做变量插值，无需修改 `docker-compose.yml`。

2. 重建容器生效：

   ```bash
   docker compose up -d
   ```

3. 验证通告生效（应返回 `{"ok":"ok","direct":"..."}`；未配置时仍返回纯文本 `ok`，一切行为与旧版一致）：

   ```bash
   curl http://localhost:18080/health
   ```

未配置 `DIRECT_ACCESS_URL` 时，所有客户端行为与历史版本完全一致（纯隧道/主地址访问），该功能零成本可退。

## DDNS（让域名跟踪家宽 IPv6）

家宽 IPv6 前缀会不定期变化（运营商重拨），需要 DDNS 定期把稳定 IPv6 写入 DNS AAAA 记录。

**优先用应用内置 DDNS**（v1.1.37+，设置 → 多端同步 → 同步群组 → 「DDNS 直连域名」）：填 Cloudflare API Token（Zone.DNS Edit 权限）与记录域名即可，服务端默认每 5 分钟探测本机公网 IP、与 Cloudflare 记录比对、变化才写（自动甄别排除 IPv6 隐私临时地址，IPv4 经回声服务取公网地址），无需在宿主机另装 DDNS 客户端或计划任务；Docker 部署也可用 `DDNS_TOKEN`/`DDNS_RECORD` 等环境变量配置。

**宿主机手动方案**（兜底——容器内看不到宿主网卡、宿主网络复杂的场景仍建议在宿主侧维护解析）以 Cloudflare DNS 为例（PowerShell，计划任务每 5 分钟）：

- 选**稳定地址**：优先 DHCPv6 分配的后缀（`Get-NetIPAddress` 的 `SuffixOrigin = Dhcp`），排除隐私临时地址（`Temporary`）
- 每次运行与现有 AAAA 比对，变化才更新（幂等）
- TTL 建议 60–300 秒

## 中枢域名的双栈连接（IPv6 优先 → IPv4 → 定期回探）

上面那节解决的是「客户端选哪个入口地址」；这节解决的是**同一个域名同时有 A 与 AAAA 记录时，成员端连中枢走哪一族**。

场景：中枢域名（家宽 DDNS 域）既解析出 IPv4 又解析出 IPv6，但 IPv6 入站可能被路由器 / 光猫 / 运营商挡掉。操作系统的 happy-eyeballs 是「每个请求都先试 IPv6，超时再回退 IPv4」——IPv6 不通时每个请求都要白等一个连接超时，而且它不会记住「这个域名走不通 IPv6」。

成员端（Docker / 桌面端内置服务、Android 本地优先版）连中枢时按下面的策略选协议族：

| 阶段 | 行为 |
| --- | --- |
| 默认 | 域名同时有 A/AAAA 时，只按 IPv6 地址建连；同一个请求内连不上立刻用 IPv4 兜底，请求照常成功 |
| 判定不通 | IPv6 **连续失败 3 次**或**累计卡住 15 秒**（任一满足）→ 改用 IPv4，此后不再每个请求先撞一次 IPv6 |
| 回探 | 在 IPv4 上每成功 10 次，下一次**不带请求体**的请求先试一次 IPv6：通了切回 IPv6 优先，不通继续用 IPv4（只试一次） |
| 传输途中 | 协议族只在**建连那一刻**选定，一次请求（含大文件上传/下载、SSE 长连接）全程同一条连接，绝不中途切换 |

几条实现口径：

- **按域名分别记账**：同一进程里每个中枢域名一份状态（`IPv6 优先 / 已切 IPv4` + 计数），进程重启回到「IPv6 优先」重新学一遍（家宽 IPv6 恢复了，下次启动自然就用上）。
- **不固定 IP**：只控制协议族，地址仍每次由系统解析——DDNS 把域名更新到新 IPv6 前缀后，下一次建连就能取到新地址，不会被旧 IP 粘住。
- **回探不插队**：回探挂在下一次请求的起点，且只挑不带请求体的请求（GET 等），不会把一次大文件上传先送给 IPv6 再重传一遍。
- **IP 直连不参与**：中枢地址填的是 `192.168.x.x` / `127.0.0.1` / `http://[IPv6]` 这类字面量时行为与历史版本完全一致。
- **单栈域名照旧、但状态不糊弄人**：域名只有 A 或只有 AAAA 时没得选，直接用存在的那一族，并把设置页那行状态校准到实际在用的协议族（不会出现「明明只有 A 记录却显示正在用 IPv6」）；DDNS 之后补上另一族记录时，自动回到「IPv6 优先」重新试。

### 配置

设置 → 多端同步 → 同步群组 → **双栈连接（IPv6 优先）**：一个开关 + 三个阈值（连续失败次数、累计秒数、IPv4 成功次数后回探），并就地显示每个中枢域名**当前走的是哪一族、还差几次回探**。默认开启，默认阈值就是上表的 3 次 / 15 秒 / 10 次；关掉即回到系统默认排序（IPv6/IPv4 由操作系统决定）。

| 设置键 | 默认 | 取值范围 | 含义 |
| --- | --- | --- | --- |
| `sync_dualstack_enabled` | `1`（开） | `0` / `1` | 是否启用双栈策略 |
| `sync_dualstack_failures` | `3` | 1–20 | IPv6 连续失败多少次改用 IPv4 |
| `sync_dualstack_window_ms` | `15000` | 1000–120000 | IPv6 累计卡住多少毫秒改用 IPv4 |
| `sync_dualstack_probe_after` | `10` | 1–1000 | IPv4 每成功多少次回探一次 IPv6 |
| `sync_dualstack_connect_timeout_ms` | `5000` | 500–30000 | 单次连接尝试的超时 |

Android 端把同一套参数存在手机本地设置里；两端（`main/server/src/sync/dualStack.ts` 与 `main/mobile/android/app/src/main/java/com/engram/app/DualStack.kt`）用同一套口径与同一组默认值。

### 看效果 / 排查

- 设置页「同步群组 → 双栈连接」下面那行字就是实时状态：`hub.xxx.com：正在用 IPv4（IPv6 连续失败 3 次；IPv4 已成功 7 次，再成功 3 次回探一次 IPv6）`。
- 同步详情里会记两条关键事件：`dualstack-ipv4-fallback`（IPv6 连不上，已改用 IPv4）与 `dualstack-ipv6-recovered`（回探成功，切回 IPv6 优先）；`dualstack-probe-failed` 表示这次回探仍不通、继续用 IPv4。
- 想立刻回到 IPv6 优先试一遍：把开关关掉再打开（会清掉学到的状态），或重启该端进程。

## 路由器放行 IPv6 入站（一次性，普通固件路由器）

IPv6 没有 NAT 的「天然保护」，路由器默认用**有状态防火墙**丢弃所有 WAN→LAN 新入站连接——这是「手机有 IPv6 却连不上」的最常见根因（NAS 侧连 SYN 都看不到）。放行步骤：

1. **验证包是否到达**：手机用**蜂窝网络**（不要连家里 Wi-Fi）访问 `http://[NAS的IPv6]:18080/health`；同时在 NAS 上观察：

   ```powershell
   Get-NetTCPConnection -LocalPort 18080 -State SynReceived,Established
   ```

   有手机 IPv6 的连接 → 包已到达，问题在 NAS（防火墙/端口，见下）；始终没有 → 包被上游丢弃（路由器/光猫/运营商）。

2. **路由器界面**：找「IPv6 防火墙 / IPv6 过滤规则 / WAN→LAN ACL」等设置（注意：很多固件 IPv4 与 IPv6 防火墙是**两个独立开关**，界面显示「防火墙关闭」可能只关了 IPv4）。添加放行规则：**协议 TCP、端口 18080、目标地址填 NAS 的稳定 IPv6**（DDNS 维护的那个地址）。

3. **光猫**：若光猫是路由模式（非桥接），它自己也有一层 IPv6 防火墙，需要同样放行（或联系运营商改桥接）。

4. **仍不通**：在 NAS 临时监听 443/80 对比——标准端口通而 18080 不通，是运营商过滤非标端口（少见但存在），此时可把直连迁到标准端口；都不同则继续向运营商方向排查。

5. 全部放弃直连也无妨：客户端自动走隧道，功能不受任何影响。

## HTTPS 直连（内置 TLS/ACME，v1.1.35+）

直连地址可配置为 **HTTPS**（推荐）：浏览器不再受混合内容限制（https 页面无法探测 http 直连是浏览器硬规则，http 直连下 `/go` 入口页与设置页徽章在浏览器里无法工作），APP 照常。Engram 内置 Let's Encrypt 证书自动签发与续期（DNS-01 验证，无需开 80 端口、无需任何反代组件）。

部署侧在 `main/.env` 增配：

```dotenv
TLS_DOMAIN=<直连域名>            # 如 direct.xxx.com；存在即启用 HTTPS 直连
TLS_DNS_API_TOKEN=<CF token>     # 需 Zone.DNS Edit 权限（写 _acme-challenge TXT），与 DDNS 同一 token 即可
DIRECT_ACCESS_URL=https://<直连域名>
```

配套步骤：

1. **DNS**：直连域名需在 Cloudflare 托管（DNS-01 写 TXT 用），记录为灰云（DNS only）AAAA → NAS 稳定 IPv6。
2. **compose**：新增 `443:8443` 端口映射（v1.1.35 起自带）；宿主 443 若被占用需先释放。
3. **路由器**：追加放行 TCP 443 → NAS 稳定 IPv6（与 18080 同法）。
4. **重建**：`docker compose up -d`。首次签发约 1-2 分钟（期间 HTTP 照常），日志出现 `[tls] 证书已就绪` 即生效；证书 90 天有效，余量不足 30 天自动重签并热更换监听。
5. **验证**：浏览器访问 `https://<直连域名>` 出现绿锁；`/health` 通告的 `direct` 已是 https 地址；设置页徽章显示「直连可用」。

可选：`TLS_EMAIL`（ACME 账户邮箱）、`TLS_ACME_DIRECTORY`（默认 Let's Encrypt 正式环境，测试可切 `https://acme-staging-v02.api.letsencrypt.org/directory`）、`TLS_PORT`（容器内端口，默认 8443）。

证书与账户 key 缓存在数据卷 `tls/` 目录（`cert.pem` / `privkey.pem` / `account.pem`），删除该目录即触发重新签发。

## 跨子域共享登录态（COOKIE_DOMAIN，v1.1.36+）

隧道域与直连域是两个不同域名，浏览器 Cookie 默认按域隔离——从隧道跳到直连需要重新登录。在 `main/.env` 配置：

```dotenv
COOKIE_DOMAIN=<父域>
# 例：COOKIE_DOMAIN=.xxx.com（与直连域名同属的父域，注意带前导点）
```

即可实现：登录一次，隧道域与直连域两个子域共享登录态；设置页「连接通道」处出现**「使用直连访问」一键切换按钮**（直连探测可用时展示），`/go` 入口跳直连也不再需要重新登录。

注意：该父域下**所有子域**都会携带会话 Cookie，请确保父域下没有不可信的子域服务；不配置则维持 host-only 行为（各域各自登录）。已在登录中的旧会话 Cookie 不会自动升级，重新登录一次后生效。

## 安全须知

- 直连路径**绕过 Cloudflare Access**（如有），防线是应用密码 + 登录限速（同 IP 连续 5 次失败锁 10 分钟）。请确保密码强度。
- 直连**推荐配置 HTTPS**（见上节）：明文 HTTP 在公网链路理论可被嗅探，且浏览器侧功能受限。
- `DIRECT_ACCESS_URL` 通告给「已通过 Cloudflare Access 登录的本地启动页」读取（服务端 CORS 白名单仅放行 Capacitor/Electron 本地页，任意第三方网页读不到）。
