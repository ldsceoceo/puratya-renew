# MWS (cloud.puratya.com) 自动续期

> 自动续期 [MWS](https://cloud.puratya.com) 免费 Bot 托管服务，防止到期被停止。

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

**⚠️ 免责声明**：本脚本仅供学习交流使用，使用者需遵守 [MWS](https://cloud.puratya.com) 的服务条款。因使用本脚本造成的任何问题，作者不承担任何责任。
