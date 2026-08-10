/*
 * MWS (cloud.puratya.com) 自动续期脚本
 *
 * 方案：纯 HTTP API，无需浏览器/过盾。
 *   1. 用 JWT (Authorization: Bearer) 直接调 MWS API 续期 Bot
 *   2. JWT 失效 (401) 时，用 DISCORD_TOKEN 走 Discord OAuth 换新 JWT
 *   3. 新 JWT 自动写回 GitHub Secrets，下次运行免登录
 *   4. Telegram 通知结果
 *
 * 环境变量：
 *   MWSTOKEN       MWS JWT（默认登录凭证，可选；格式如 eyJhbGciOi...）
 *   DISCORD_TOKEN  Discord Token（JWT 失效时 OAuth 换新 JWT 用，建议配置）
 *   GH_TOKEN       GitHub PAT（或 REPO_TOKEN），写回 MWSTOKEN 到 Secrets（可选）
 *   BOT_IDS        要续期的 Bot id，逗号分隔；默认续期全部 Bot（可选）
 *   RENEW_THRESHOLD_HOURS  剩余小时数低于该值才续期，默认 24（可选）
 *   PROXY_SERVER   代理地址（可选），如 socks5://127.0.0.1:1080
 *   TG_BOT_TOKEN / TG_CHAT_ID  Telegram 通知（可选）
 *   EMAIL          通知中显示的账号名（可选）
 */

const https = require('https');
const http = require('http');
const net = require('net');
const tls = require('tls');
const { URL } = require('url');
const { execFile } = require('child_process');

// ====================== 配置 ======================
const BASE_URL = 'https://cloud.puratya.com';
const API_BASE = 'https://cloud.puratya.com/api';
const OAUTH_BASE = 'https://cloud-api.puratya.com';
const DISCORD_CLIENT_ID = '1508034084377464903';
const OAUTH_REDIRECT_URI = 'https://cloud-api.puratya.com/auth/callback';
const OAUTH_SCOPE = 'identify';
const DISCORD_AUTHORIZE = 'https://discord.com/api/v9/oauth2/authorize';
const DISCORD_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

const MWSTOKEN = process.env.MWSTOKEN || process.env.SESSION_TOKEN || '';
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
const GH_TOKEN = process.env.GH_TOKEN || process.env.REPO_TOKEN || '';
const BOT_IDS = (process.env.BOT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const RENEW_THRESHOLD_HOURS = parseInt(process.env.RENEW_THRESHOLD_HOURS || '24', 10);
const PROXY = process.env.PROXY_SERVER || '';
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';
const EMAIL = process.env.EMAIL || '';

// 解析 DISCORD_TOKEN（兼容 "备注,真实token" 格式）
let DC_TOKEN = '';
if (DISCORD_TOKEN) {
  const parts = DISCORD_TOKEN.split(',');
  DC_TOKEN = parts[parts.length - 1].trim();
}

if (!MWSTOKEN && !DC_TOKEN) {
  console.error('❌ 缺少登录凭证：请设置 MWSTOKEN 或 DISCORD_TOKEN');
  process.exit(1);
}

// ====================== Cookie Jar ======================
class CookieJar {
  constructor() {
    this.cookies = {}; // host -> { name: value }
  }

  _host(u) {
    return new URL(u).hostname.toLowerCase();
  }

  storeFromResponse(u, setCookieHeaders) {
    const host = this._host(u);
    if (!setCookieHeaders) return;
    const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    for (const raw of list) {
      const parts = raw.split(';');
      const eq = parts[0].indexOf('=');
      if (eq === -1) continue;
      const name = parts[0].slice(0, eq).trim();
      const value = parts[0].slice(eq + 1).trim();
      const lower = raw.toLowerCase();
      // __Host- 前缀 cookie 仅用于设置它的主机
      let domain = host;
      const dm = /domain=([^;]+)/i.exec(raw);
      if (dm && !name.startsWith('__Host-')) {
        domain = dm[1].trim().replace(/^\./, '').toLowerCase();
      }
      // 过期/删除
      const isDelete = value === '' || /max-age=0/i.test(raw) || /expires=thu, 01 jan 1970/i.test(raw);
      if (isDelete) {
        if (this.cookies[domain]) delete this.cookies[domain][name];
        continue;
      }
      if (!this.cookies[domain]) this.cookies[domain] = {};
      this.cookies[domain][name] = value;
    }
  }

  cookieHeader(u) {
    const host = this._host(u);
    const parts = [];
    for (const [domain, map] of Object.entries(this.cookies)) {
      if (host === domain || host.endsWith('.' + domain)) {
        for (const [name, value] of Object.entries(map)) parts.push(`${name}=${value}`);
      }
    }
    return parts.join('; ');
  }

  get(name) {
    for (const map of Object.values(this.cookies)) {
      if (map[name] !== undefined) return map[name];
    }
    return null;
  }
}

// ====================== HTTP 客户端 ======================
// 通过 SOCKS5 代理建立隧道（对 HTTPS 目标生效）
function socks5Connect(proxyUrl, targetHost, targetPort, timeout) {
  return new Promise((resolve, reject) => {
    const p = new URL(proxyUrl);
    const proxyPort = p.port || 1080;
    const socket = net.connect(proxyPort, p.hostname);
    const fail = (msg) => { socket.destroy(); reject(new Error(msg)); };
    socket.setTimeout(timeout, () => fail('SOCKS5 代理连接超时'));
    socket.on('error', reject);

    const send = (buf) => {
      if (socket.destroyed) return;
      socket.write(buf);
    };

    socket.once('data', (d1) => {
      if (d1[0] !== 0x05 || d1[1] !== 0x00) { fail('SOCKS5 握手失败'); return; }
      // 发送连接请求
      const hostBuf = Buffer.from(targetHost, 'utf-8');
      const req = Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
        hostBuf,
        Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
      ]);
      send(req);
      socket.once('data', (d2) => {
        if (d2[0] !== 0x05 || d2[1] !== 0x00) { fail('SOCKS5 连接目标失败'); return; }
        socket.setTimeout(0);
        resolve(socket);
      });
    });

    send(Buffer.from([0x05, 0x01, 0x00]));
  });
}

// 通过 HTTP 代理建立 CONNECT 隧道（对 HTTPS 目标生效，常用于 Discord/Telegram）
function httpProxyConnect(proxyUrl, targetHost, targetPort, timeout) {
  return new Promise((resolve, reject) => {
    const p = new URL(proxyUrl);
    const proxyIsHttps = p.protocol === 'https:';
    const proxyMod = proxyIsHttps ? https : http;
    const proxyPort = p.port || (proxyIsHttps ? 443 : 80);

    const headers = { Host: `${targetHost}:${targetPort}` };
    if (p.username || p.password) {
      headers['Proxy-Authorization'] =
        'Basic ' + Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64');
    }

    const preq = proxyMod.request({
      host: p.hostname,
      port: proxyPort,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers,
      timeout,
    });
    preq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`代理 CONNECT 失败: HTTP ${res.statusCode}`));
        return;
      }
      resolve(socket);
    });
    preq.on('error', reject);
    preq.on('timeout', () => preq.destroy(new Error('代理连接超时')));
    preq.end();
  });
}

// 是否需要走代理（仅 Discord / Telegram 这类国内无法直连的域名走代理）
function shouldProxy(url) {
  if (!PROXY) return false;
  const host = new URL(url).hostname;
  return /(^|\.)(discord\.com|telegram\.org)$/i.test(host);
}

// 返回 { status, headers, body, finalUrl }，自动跟随重定向并维护 cookie jar
function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const {
      method = 'GET',
      headers = {},
      body = null,
      jar = null,
      maxRedirects = 10,
      redirects = 0,
      timeout = 30000,
    } = options;

    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    const useProxy = shouldProxy(url);
    const targetPort = u.port ? Number(u.port) : (isHttps ? 443 : 80);

    const headersFinal = { 'User-Agent': DISCORD_UA, ...headers };
    if (jar) {
      const ck = jar.cookieHeader(url);
      if (ck) headersFinal['Cookie'] = ck;
    }
    if (body && !headersFinal['Content-Type']) headersFinal['Content-Type'] = 'application/json';
    if (body) headersFinal['Content-Length'] = Buffer.byteLength(body);

    const reqOptions = { method, headers: headersFinal, timeout };
    if (useProxy) {
      // 通过 createConnection 建立代理隧道；https 目标需再包裹 TLS
      reqOptions.createConnection = (opts, oncreate) => {
        const host = u.hostname;
        const port = targetPort;
        const isSocks = /^socks5:\/\//i.test(PROXY) || /^socks:\/\//i.test(PROXY);
        const tunnel = isSocks ? socks5Connect(PROXY, host, port, timeout) : httpProxyConnect(PROXY, host, port, timeout);
        tunnel
          .then((socket) => {
            socket.setTimeout(timeout);
            if (!isHttps) { oncreate(null, socket); return; }
            // 在已建隧道上执行 TLS 握手（servername=目标主机）
            const tlsSocket = tls.connect({ socket, servername: host, host, port });
            tlsSocket.once('secureConnect', () => oncreate(null, tlsSocket));
            tlsSocket.on('error', oncreate);
          })
          .catch(oncreate);
      };
    }

    // 显式指定 hostname/port，避免 node 对 URL 端口解析错误
    const req = mod.request(Object.assign({}, reqOptions, {
      hostname: u.hostname,
      port: targetPort,
      path: u.pathname + u.search,
    }), (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const respHeaders = res.headers;
        if (jar && respHeaders['set-cookie']) {
          jar.storeFromResponse(url, respHeaders['set-cookie']);
        }
        const status = res.statusCode || 0;
        const isRedirect = status >= 300 && status < 400 && respHeaders.location;
        if (isRedirect && redirects < maxRedirects) {
          const next = new URL(respHeaders.location, url);
          request(next.href, { ...options, redirects: redirects + 1 })
            .then(resolve)
            .catch(reject);
          return;
        }
        resolve({
          status,
          headers: respHeaders,
          body: raw.toString('utf-8'),
          finalUrl: res.url || url,
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    if (body) req.write(body);
    req.end();
  });
}

// 便捷 JSON 请求（Bearer 认证）
async function api(path, { method = 'GET', token = '', body = null, jar = null } = {}) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const resp = await request(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
    jar,
  });
  let json = null;
  try { json = JSON.parse(resp.body); } catch (e) { /* 非 JSON 响应 */ }
  return { status: resp.status, data: json, raw: resp.body, headers: resp.headers };
}

// ====================== Telegram 通知 ======================
async function sendTg(message) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    console.log('[WARN] 未配置 TG 信息，跳过通知');
    return;
  }
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
  try {
    await request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text: message, parse_mode: 'Markdown' }),
      timeout: 15000,
    });
    console.log('[INFO] 📡 TG 通知已发送');
  } catch (e) {
    console.log(`[ERROR] TG 发送失败: ${e.message}`);
  }
}

function maskAccount(s) {
  if (!s) return '(未设置)';
  return s.length > 8 ? s.slice(0, 4) + '...' + s.slice(-4) : '***';
}

function bjTime() {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  return now.toISOString().replace('T', ' ').slice(0, 19);
}

// ====================== 写回 Secrets ======================
async function writeTokenToSecret(newToken) {
  if (!newToken) return false;
  if (!GH_TOKEN) {
    console.log('[WARN] 🔑 未配置 GH_TOKEN，无法自动写回；请手动更新 Secret MWSTOKEN');
    return false;
  }
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.log('[WARN] 🔑 非 GitHub Actions 环境，跳过 token 写回');
    return false;
  }
  return new Promise((resolve) => {
    const env = { ...process.env, GH_TOKEN };
    execFile('gh', ['secret', 'set', 'MWSTOKEN', '--body', newToken, '--repo', repo],
      { env, timeout: 30000 }, (err, stdout, stderr) => {
        if (err) {
          console.log(`[WARN] 🔑 写回失败: ${(stderr || err.message).trim().slice(0, 200)}`);
          console.log(`[WARN] 🔑 请手动更新 Secret MWSTOKEN = ${newToken.slice(0, 6)}...${newToken.slice(-4)}`);
          resolve(false);
        } else {
          console.log(`[INFO] ✅ 新 JWT 已写回 GitHub Secret MWSTOKEN (len=${newToken.length})`);
          resolve(true);
        }
      });
  });
}

// ====================== JWT 校验 ======================
async function checkToken(token) {
  const resp = await api('/auth/me', { token });
  if (resp.status === 200 && resp.data && resp.data.id) {
    return { ok: true, me: resp.data };
  }
  return { ok: false, status: resp.status, me: null };
}

function jwtExpiry(token) {
  try {
    const payload = token.split('.')[1];
    const pad = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const data = JSON.parse(Buffer.from(pad, 'base64').toString('utf-8'));
    return data.exp ? data.exp * 1000 : null;
  } catch (e) {
    return null;
  }
}

// ====================== Discord OAuth 换新 JWT ======================
// 流程：
//   1. 访问 /api/auth/login 获取 Discord OAuth state（附带 oauth_state cookie）
//   2. 用 DC_TOKEN POST Discord authorize API，拿回调 URL（含 code）
//   3. 打开回调 URL，捕获新 JWT cookie (__Host-mrtcloud_token)
async function refreshJwtViaDiscord() {
  if (!DC_TOKEN) {
    console.log('[ERROR] 🔑 JWT 失效但未配置 DISCORD_TOKEN，无法换新');
    return null;
  }
  console.log('[INFO] 🔑 通过 Discord OAuth 换新 JWT...');
  const jar = new CookieJar();

  // 1. 获取 state：/api/auth/login → 302 cloud-api/auth/login → 302 discord authorize?state=XXX
  const r1 = await request(`${API_BASE}/auth/login`, { jar, maxRedirects: 0 }).catch(e => ({ status: 0, headers: {} }));
  if (!r1.headers.location) {
    console.log(`[ERROR] 获取登录跳转失败 (status=${r1.status})`);
    return null;
  }
  const r2 = await request(r1.headers.location, { jar, maxRedirects: 0 }).catch(e => ({ status: 0, headers: {} }));
  if (!r2.headers.location || !r2.headers.location.includes('discord.com/oauth2/authorize')) {
    console.log(`[ERROR] 未跳转到 Discord 授权页 (${(r2.headers.location || '').slice(0, 120)})`);
    return null;
  }
  const authUrl = r2.headers.location;
  const state = new URL(authUrl).searchParams.get('state');
  if (!state) {
    console.log('[ERROR] 未能从授权 URL 解析出 state');
    return null;
  }
  console.log('[INFO] ✅ 已获取 OAuth state');

  // 2. Discord authorize API（用 DC_TOKEN）
  const query = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    response_type: 'code',
    redirect_uri: OAUTH_REDIRECT_URI,
    scope: OAUTH_SCOPE,
    state,
  });
  const authorizeUrl = `${DISCORD_AUTHORIZE}?${query.toString()}`;
  const referer = authorizeUrl;

  let discordResp;
  try {
    discordResp = await request(authorizeUrl, {
      method: 'POST',
      headers: {
        accept: '*/*',
        authorization: DC_TOKEN,
        'content-type': 'application/json',
        origin: 'https://discord.com',
        referer,
        'user-agent': DISCORD_UA,
        'x-discord-locale': 'zh-CN',
      },
      body: JSON.stringify({
        permissions: '0',
        authorize: true,
        integration_type: 0,
        location_context: { guild_id: '10000', channel_id: '10000', channel_type: 10000 },
      }),
      maxRedirects: 0,
      timeout: 20000,
    });
  } catch (e) {
    console.log(`[ERROR] Discord OAuth 授权异常: ${e.message}`);
    return null;
  }

  if (discordResp.status !== 200) {
    console.log(`[ERROR] Discord OAuth 授权失败: HTTP ${discordResp.status} - ${discordResp.body.slice(0, 300)}`);
    return null;
  }
  let loc;
  try {
    const d = JSON.parse(discordResp.body);
    loc = d.location || '';
  } catch (e) {
    console.log(`[ERROR] Discord 授权响应解析失败: ${discordResp.body.slice(0, 200)}`);
    return null;
  }
  if (!loc) {
    console.log(`[ERROR] Discord 授权响应中未找到 location: ${discordResp.body.slice(0, 200)}`);
    return null;
  }
  console.log('[INFO] ✅ 拿到回调 URL');

  // 3. 打开回调：cloud-api/auth/callback → 302 → cloud.puratya.com/auth/success?code=xxx
  const cbResp = await request(loc, { jar, maxRedirects: 10, timeout: 30000 }).catch(e => ({ status: 0, body: '' }));

  // 3.1 从最终 URL 解析 MWS 授权码
  const finalUrl = cbResp.finalUrl || loc;
  const authCode = new URL(finalUrl).searchParams.get('code');
  if (!authCode) {
    console.log(`[ERROR] 回调未返回授权码（status=${cbResp.status}，最终 URL=${finalUrl}）`);
    return null;
  }
  console.log('[INFO] ✅ 拿到 MWS 授权码，调用 /api/auth/exchange 换 JWT...');

  // 3.2 POST /api/auth/exchange 换取 JWT（body 返回 token，同时下发 __Host-mrtcloud_token cookie）
  const exResp = await request(`${API_BASE}/auth/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: authCode }),
    jar,
    timeout: 30000,
  }).catch(e => ({ status: 0, body: '' }));

  let newToken = '';
  try {
    const d = JSON.parse(exResp.body);
    newToken = d.token || '';
  } catch (e) { /* 非 JSON */ }
  if (!newToken) newToken = jar.get('__Host-mrtcloud_token') || '';
  if (!newToken) {
    console.log(`[ERROR] /api/auth/exchange 未返回 token（status=${exResp.status}）：${exResp.body.slice(0, 200)}`);
    return null;
  }
  console.log(`[INFO] ✅ 已获取新 JWT (len=${newToken.length})`);

  // 4. 校验新 JWT
  const check = await checkToken(newToken);
  if (!check.ok) {
    console.log(`[ERROR] 新 JWT 校验失败 (status=${check.status})`);
    return null;
  }
  return newToken;
}

// ====================== 续期 ======================
async function renewAll(token) {
  // 获取 Bot 列表
  const list = await api('/bots', { token });
  if (list.status !== 200 || !list.data || !Array.isArray(list.data.bots)) {
    console.log(`[ERROR] 获取 Bot 列表失败 (status=${list.status})`);
    return { ok: false, me: null };
  }
  const bots = list.data.bots;
  if (bots.length === 0) {
    console.log('[INFO] ℹ️ 账号下没有 Bot');
    return { ok: true, me: null, bots: [] };
  }
  console.log(`[INFO] 📋 账号下共 ${bots.length} 个 Bot`);

  const targets = BOT_IDS.length > 0
    ? bots.filter(b => BOT_IDS.includes(String(b.id)))
    : bots;

  if (targets.length === 0) {
    console.log(`[WARN] 未找到匹配的 Bot（指定 ID: ${BOT_IDS.join(',')}）`);
    return { ok: true, me: null, bots: [], results: [] };
  }

  const results = [];
  for (const bot of targets) {
    const timer = bot.timer || {};
    const remainingHours = timer.remaining_hours ?? null;
    const stopAt = timer.stop_at || '';
    console.log(`[INFO] 🤖 Bot #${bot.id} (${bot.name}) | status=${bot.status} | 剩余=${remainingHours}h | 停止于=${stopAt}`);

    let action = 'renew';
    // 若剩余时间仍充足，跳过续期（避免无效请求）
    if (remainingHours !== null && remainingHours > RENEW_THRESHOLD_HOURS) {
      console.log(`[INFO] ⏳ 剩余 ${remainingHours}h > 阈值 ${RENEW_THRESHOLD_HOURS}h，无需续期`);
      results.push({ id: bot.id, name: bot.name, action: 'skip', remainingHours });
      continue;
    }

    const resp = await api(`/bots/${bot.id}/renew`, { method: 'POST', token });
    if (resp.status === 200 && resp.data && resp.data.timer) {
      const t = resp.data.timer;
      console.log(`[INFO] ✅ Bot #${bot.id} 续期成功，新剩余=${t.remaining_hours}h，停止于=${t.stop_at}`);
      results.push({ id: bot.id, name: bot.name, action: 'renewed', remainingHours: t.remaining_hours, stopAt: t.stop_at });
    } else {
      console.log(`[ERROR] ❌ Bot #${bot.id} 续期失败 (status=${resp.status}): ${(resp.data && resp.data.detail) || resp.raw.slice(0, 150)}`);
      results.push({ id: bot.id, name: bot.name, action: 'failed', status: resp.status });
    }
    // 间隔 1.5s，避免触发限流
    await new Promise(r => setTimeout(r, 1500));
  }
  return { ok: true, me: null, bots, results };
}

// ====================== 主流程 ======================
async function main() {
  console.log('[INFO] ' + '='.repeat(50));
  console.log('[INFO] MWS (cloud.puratya.com) 自动续期 (HTTP API)');
  console.log('[INFO] ' + '='.repeat(50));
  console.log(`[INFO] JWT: ${MWSTOKEN ? maskAccount(MWSTOKEN) : '(未设置)'} | Discord Token: ${DC_TOKEN ? '已配置' : '(未设置)'}`);

  let token = MWSTOKEN;
  let loginMethod = 'JWT';
  let me = null;

  // 1. 优先用 JWT
  if (token) {
    const check = await checkToken(token);
    if (check.ok) {
      me = check.me;
      console.log(`[INFO] ✅ JWT 有效 (用户: ${me.username || me.id})`);
    } else {
      console.log(`[INFO] ⚠️ JWT 失效 (status=${check.status})，尝试换新...`);
      token = null;
    }
  }

  // 2. JWT 无效 → Discord OAuth 换新
  if (!token) {
    const fresh = await refreshJwtViaDiscord();
    if (!fresh) {
      await sendTg(`❌ MWS 续期失败：JWT 失效且 Discord OAuth 换新失败`);
      process.exit(1);
    }
    token = fresh;
    loginMethod = 'Discord OAuth';
    // 写回 Secrets
    await writeTokenToSecret(fresh);
    me = (await checkToken(token)).me;
  }

  // 3. 续期
  const result = await renewAll(token);

  // 4. 组装通知
  const exp = jwtExpiry(token);
  const expStr = exp ? new Date(exp + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16) : '';
  let lines = [`🇯🇵 MWS 续期通知`, ``];
  if (result.results && result.results.length > 0) {
    let renewed = 0, skipped = 0, failed = 0;
    for (const r of result.results) {
      if (r.action === 'renewed') renewed++;
      else if (r.action === 'skip') skipped++;
      else failed++;
    }
    const status = failed > 0 ? '⚠️ 部分续期失败' : (renewed > 0 ? '✅ 续期完成' : '⏳ 无需续期');
    lines.push(`${status}`);
    lines.push(`👤 账号: \`${me ? (me.username || me.id) : EMAIL || '(未设置)'}\``);
    if (loginMethod === 'Discord OAuth') lines.push(`🔐 登录方式: Discord OAuth（JWT 已自动更新）`);
    for (const r of result.results) {
      if (r.action === 'renewed') lines.push(`✅ Bot #${r.id} (${r.name}) → 剩余 ${r.remainingHours}h`);
      else if (r.action === 'skip') lines.push(`⏳ Bot #${r.id} (${r.name}) → 剩余 ${r.remainingHours}h，无需续期`);
      else lines.push(`❌ Bot #${r.id} (${r.name}) → 续期失败`);
    }
  } else {
    lines.push(`ℹ️ 无续期目标`);
    lines.push(`👤 账号: \`${me ? (me.username || me.id) : EMAIL || '(未设置)'}\``);
  }
  lines.push(`⏱️ 时间: ${bjTime()}`);
  if (expStr) lines.push(`🔑 JWT 有效期至: ${expStr} (北京时间)`);
  lines.push(``);
  lines.push(`MWS Auto Renew (HTTP API)`);
  await sendTg(lines.join('\n'));

  console.log(`[INFO] 🎉 任务完成`);
}

main().catch((e) => {
  console.error(`[ERROR] Fatal: ${e.message}`);
  process.exit(1);
});
