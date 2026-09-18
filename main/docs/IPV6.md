# IPv6 直连优先 + Cloudflare 隧道兜底（智能接入）

Engram 的远程访问支持双通道自动择优：客户端启动时按「直连地址 → 上次成功通道 → 主地址」逐个探测（`/health`，直连 1.5 秒、其余 3.5 秒强制超时），**IPv6/局域网直连可达就秒进直连**（低延迟、无中转、不占隧道流量），不可达自动落回主地址（如 Cloudflare Tunnel，永保可用）。直连恢复后的下一次启动自动切回，全程无感。

```
手机 / 浏览器
  ├─ 直连通道（优先）：手机蜂窝 IPv6 ──运营商路由──▶ 家宽 IPv6 ──▶ Engram
  │   例：http://<ddns.xxx.com>:18080   ← 需路由器放行 IPv6 入站（一次性）
  └─ 隧道兜底：Cloudflare Tunnel（或任何可公网访问的主地址）
      例：https://engram.xxx.com
```

仓库代码零域名硬编码：直连地址由**服务端通告**——部署侧在 `main/.env`（不入库）配置 `DIRECT_ACCESS_URL`，经 `/health` 下发给已登录客户端；Android 本地优先版可在 设置 → 多端同步 为中枢额外填写局域网 / IPv6 直连地址，主地址不可达时按顺序尝试。

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

**优先用应用内置 DDNS**（v1.1.37+，设置 → DDNS 直连）：填 Cloudflare API Token（Zone.DNS Edit 权限）与记录域名即可，服务端默认每 5 分钟探测本机公网 IP、与 Cloudflare 记录比对、变化才写（自动甄别排除 IPv6 隐私临时地址，IPv4 经回声服务取公网地址），无需在宿主机另装 DDNS 客户端或计划任务；Docker 部署也可用 `DDNS_TOKEN`/`DDNS_RECORD` 等环境变量配置。

**宿主机手动方案**（兜底——容器内看不到宿主网卡、宿主网络复杂的场景仍建议在宿主侧维护解析）以 Cloudflare DNS 为例（PowerShell，计划任务每 5 分钟）：

- 选**稳定地址**：优先 DHCPv6 分配的后缀（`Get-NetIPAddress` 的 `SuffixOrigin = Dhcp`），排除隐私临时地址（`Temporary`）
- 每次运行与现有 AAAA 比对，变化才更新（幂等）
- TTL 建议 60–300 秒

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
