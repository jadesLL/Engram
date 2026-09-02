# IPv6 直连优先 + Cloudflare 隧道兜底（智能接入）

Engram 的远程访问支持双通道自动择优：客户端启动时按「直连地址 → 上次成功通道 → 主地址」逐个探测（`/health`，直连 1.5 秒、其余 3.5 秒强制超时），**IPv6/局域网直连可达就秒进直连**（低延迟、无中转、不占隧道流量），不可达自动落回主地址（如 Cloudflare Tunnel，永保可用）。直连恢复后的下一次启动自动切回，全程无感。

```
手机 / 桌面端
  ├─ 直连通道（优先）：手机蜂窝 IPv6 ──运营商路由──▶ 家宽 IPv6 ──▶ Engram
  │   例：http://<ddns.example.com>:18080   ← 需路由器放行 IPv6 入站（一次性）
  └─ 隧道兜底：Cloudflare Tunnel（或任何可公网访问的主地址）
      例：https://engram.example.com
```

仓库代码零域名硬编码：直连地址由**服务端通告**——部署侧在 `main/.env`（不入库）配置 `DIRECT_ACCESS_URL`，经 `/health` 下发给已登录客户端；安卓 APP 与桌面端也提供可选手填直连地址（在网页端 设置 → 账户与外观 的「连接通道」区可一键复制）。

## 服务端配置（部署侧）

1. 在 `main/` 同目录创建/编辑 `.env`（该文件被 gitignore，不会入库）：

   ```dotenv
   DIRECT_ACCESS_URL=http://<你的DDNS域名>:<端口>
   # 例：DIRECT_ACCESS_URL=http://ddns.example.com:18080
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

家宽 IPv6 前缀会不定期变化（运营商重拨），需要 DDNS 定期把稳定 IPv6 写入 DNS AAAA 记录。以 Cloudflare DNS 为例（PowerShell，计划任务每 5 分钟）：

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

## 安全须知

- 直连路径**绕过 Cloudflare Access**（如有），防线是应用密码 + 登录限速（同 IP 连续 5 次失败锁 10 分钟）。请确保密码强度。
- 直连为明文 HTTP 时，公网链路理论可被嗅探（家宽/蜂窝被定向嗅探的现实风险低）。介意者可用反代（如 Lucky/caddy）给直连加 HTTPS + 自动证书（Let's Encrypt DNS 验证无需开 80 端口），然后把 `DIRECT_ACCESS_URL` 配成 `https://…` 即可，客户端无需任何改动。
- `DIRECT_ACCESS_URL` 通告给「已通过 Cloudflare Access 登录的本地启动页」读取（服务端 CORS 白名单仅放行 Capacitor/Electron 本地页，任意第三方网页读不到）。
