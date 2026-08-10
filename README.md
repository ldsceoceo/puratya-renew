# MWS (cloud.puratya.com) 自动续期

> 自动续期 [MWS](https://cloud.puratya.com) 免费 Bot 托管服务，防止到期被停止。
>
> **纯 HTTP API 方案**：无需浏览器、无需过 Cloudflare 盾、无需 GPU/Chrome。

通过 GitHub Actions 定时运行，使用 **Node.js 纯 HTTP API** 完成：

1. 用 JWT 直接调用 MWS API 续期 Bot（免费账号自动续期默认为关闭，需要手动续期）
2. JWT 失效（401）时自动用 `DISCORD_TOKEN` 走 **Discord OAuth** 换取新 JWT
3. 新 JWT 自动写回 GitHub Secrets，下次运行免登录
4. Telegram 推送续期结果

## 技术方案

MWS（cloud.puratya.com）是一个日文 Discord Bot 托管平台，登录方式为 **Discord OAuth**（无账号密码）。

认证方式（均已实测）：

| 方式 | 说明 |
|---|---|
| `Authorization: Bearer <JWT>` | 直接调用 API，最稳定，脚本首选 |
| Cookie `__Host-mrtcloud_token=<JWT>` | 浏览器默认方式，脚本不依赖 |

续期端点：`POST /api/bots/{id}/renew`（免费 Bot 计时器重置为满 7 天）。

**JWT 换新流程**（JWT 过期时触发）：
1. 访问 `/api/auth/login` → 302 到 Discord 授权页，捕获 `state`
2. 用 `DISCORD_TOKEN` 调 Discord OAuth 授权 API → 拿到回调 URL（含 `code`）
3. 跟随回调链：`cloud-api/auth/callback?code=...` → 302 → `cloud.puratya.com/auth/success?code=<MWS授权码>`
4. `POST /api/auth/exchange`，body `{"code": <MWS授权码>}` → 返回 `{"token": "<新JWT>"}`（同时下发 `__Host-mrtcloud_token` cookie）
5. 新 JWT 自动写回 GitHub Secret `MWSTOKEN`

> **为什么需要代理**：Discord OAuth 授权 API 在国内网络无法直连。GitHub Actions runner
> 在海外可直连；如遇访问问题，可配置 `NODE_LINK` 代理（sing-box，自动安装启动）。

## 功能

- ✅ 纯 HTTP API 续期，零浏览器依赖（无需 Chrome / playwright / 过盾）
- ✅ JWT 自动续期：失效时 Discord OAuth 自动换新并写回 Secret
- ✅ 智能跳过：剩余时间仍充足（默认 >24h）时自动跳过续期
- ✅ 支持多个 Bot（默认续期账号下全部 Bot，也可用 `BOT_IDS` 指定）
- ✅ Telegram 通知（含账号、续期结果、JWT 有效期）
- ✅ 日志自动上传为 Actions Artifact（保留 3 天）
- ✅ 自动清理历史运行记录（保留最近 2 次）

## 配置

在仓库 `Settings → Secrets and variables → Actions` 中添加以下 Secrets：

| Secret 名称 | 必填 | 说明 |
|---|---|---|
| `MWSTOKEN` | ✅ | MWS 登录 JWT（见下方获取方式） |
| `DISCORD_TOKEN` | ✅ | Discord Token（JWT 失效时自动换新 JWT 用） |
| `REPO_TOKEN` | ✅ | GitHub Token，用于写回新 JWT 到 `MWSTOKEN`（需 `repo` 权限） |
| `NODE_LINK` | ❌ | 代理节点地址（支持 vless/vmess/trojan/ss/socks5），仅 Discord 无法直连时需要 |
| `BOT_IDS` | ❌ | 要续期的 Bot ID，逗号分隔；留空则续期全部 |
| `EMAIL` | ❌ | 通知中显示的账号名（可选） |
| `TG_BOT_TOKEN` | ❌ | Telegram Bot Token |
| `TG_CHAT_ID` | ❌ | Telegram Chat ID |

### 获取 MWSTOKEN（MWS JWT）

1. 浏览器登录 [cloud.puratya.com](https://cloud.puratya.com)（Discord OAuth）
2. F12 → Application → Cookies → `https://cloud.puratya.com`
3. 找到 Cookie `__Host-mrtcloud_token`，复制其 Value（形如 `eyJhbGciOiJIUzI1NiIs...`）
4. 填入 Secret `MWSTOKEN`

> JWT 有效期约 30 天。配置 `DISCORD_TOKEN` 后，脚本会在 JWT 失效时自动换新并写回，
> 无需手动更新。

### 获取 DISCORD_TOKEN

任意支持"开发者模式"的浏览器登录 Discord（网页版即可）：

1. 打开 [discord.com/app](https://discord.com/app) 并登录
2. F12 → Network → 刷新页面，过滤 `api/v9`
3. 任意请求的请求头中复制 `authorization` 字段值（形如 `MTQxNDY5NzM0...`）
4. 填入 Secret `DISCORD_TOKEN`

> ⚠️ Discord Token 属于敏感凭证，务必保证 Secrets 安全，不要泄露到公开渠道。

### ⚙️ REPO_TOKEN 权限要求

- 必须是 **Personal Access Token (Classic)**，勾选 **`repo`** 权限
  （用于 `gh secret set MWSTOKEN` 写回新 JWT）
- 获取路径：GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)
- 如不需要自动写回 JWT，可省略该 Secret（脚本会打印新 JWT 供手动更新）

### NODE_LINK 代理格式（可选）

仅当 GitHub Actions runner 无法直连 Discord 时需要。支持：

- `vless://uuid@server:port?security=reality&sni=...&type=ws&...`
- `vmess://base64encoded`
- `trojan://password@server:port?sni=...&type=ws&...`
- `ss://base64@server:port`
- `socks5://user:pass@server:port` 或 `socks5://server:port`

## 使用

### GitHub Actions（推荐）

1. Fork 本仓库
2. 在仓库 Secrets 中配置 `MWSTOKEN`、`DISCORD_TOKEN`、`REPO_TOKEN`
3. （可选）配置 `NODE_LINK`、`BOT_IDS`、`TG_BOT_TOKEN`、`TG_CHAT_ID`
4. 工作流每天 UTC 01:30（北京时间 09:30）自动运行，也可在 Actions 页面手动触发 `workflow_dispatch`

### 本地运行

```bash
# 零依赖，无需 npm install
# 配置登录凭证（二选一即可，同时配置则优先 JWT）
export MWSTOKEN="eyJhbGciOi..."
export DISCORD_TOKEN="MTQxNDY5NzM0..."
# （可选）指定要续期的 Bot ID
export BOT_IDS="9414"
# （可选）Telegram 通知
export TG_BOT_TOKEN="123456:ABC..."
export TG_CHAT_ID="123456789"
# 运行
node renew.js
```

> 本地运行 Discord OAuth 换新需要能访问 Discord（国内网络需先开代理，并将
> `PROXY_SERVER` 指向代理地址；脚本对 Discord 请求会自动走该代理）。

## 注意事项

- MWS 免费账号 `auto_renew=false`，需要脚本主动续期
- 续期会将 Bot 计时器重置为满 7 天；脚本默认剩余 >24h 时跳过（可用 `RENEW_THRESHOLD_HOURS` 调整）
- 日志和 Telegram 通知中的敏感信息（Token 等）均已脱敏
- 若 JWT 失效且 Discord OAuth 失败，脚本会推送失败通知并退出（不会误续期）

---

**⚠️ 免责声明**：本脚本仅供学习交流使用，使用者需遵守 [MWS](https://cloud.puratya.com) 的服务条款。因使用本脚本造成的任何问题，作者不承担任何责任。
