const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');
const logger = require('./logger');
const { normalizeGear } = require('./config');
const { hashPassword, verifyPassword, verifyCapToken } = require('./auth');

const STATIC_DIR = path.join(__dirname, '..', 'public');
const CAP_WIDGET_DIR = path.join(__dirname, '..', 'node_modules', 'cap-widget');

const COOKIE_NAME = 'qqcoyote_session';
const LOGIN_MAX_FAILS = 5;
const LOGIN_WINDOW_MS = 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
};

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return false;
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

function getLanIPv4() {
  const nets = os.networkInterfaces();
  const all = [];
  const priv = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        all.push(net.address);
        if (isPrivateIPv4(net.address)) priv.push(net.address);
      }
    }
  }
  return priv[0] || all[0] || '127.0.0.1';
}

function createApiServer(ctx) {
  const { config, onebot, dglab, state, fireShock, applyConnections } = ctx;

  // ---- 会话 ----
  const sessions = new Map(); // token -> { exp }
  const loginFails = new Map(); // ip -> { count, until }

  function parseCookies(req) {
    const out = {};
    const raw = req.headers.cookie || '';
    for (const part of raw.split(';')) {
      const idx = part.indexOf('=');
      if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
    return out;
  }

  function sessionUser(req) {
    const token = parseCookies(req)[COOKIE_NAME];
    if (!token) return null;
    const s = sessions.get(token);
    if (!s) return null;
    if (Date.now() > s.exp) { sessions.delete(token); return null; }
    return token;
  }

  function createSession(res) {
    const token = crypto.randomBytes(24).toString('hex');
    const hours = Math.max(1, config.get().security.sessionHours || 168);
    sessions.set(token, { exp: Date.now() + hours * 3600 * 1000 });
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${hours * 3600}`);
    return token;
  }

  function destroySession(req, res) {
    const token = parseCookies(req)[COOKIE_NAME];
    if (token) sessions.delete(token);
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  }

  function clientIp(req) {
    return (req.socket && req.socket.remoteAddress) || 'unknown';
  }

  function checkLoginRate(ip) {
    const now = Date.now();
    const rec = loginFails.get(ip);
    if (!rec) return { allowed: true, lockedMs: 0 };
    if (now > rec.until) { loginFails.delete(ip); return { allowed: true, lockedMs: 0 }; }
    if (rec.count >= LOGIN_MAX_FAILS) return { allowed: false, lockedMs: rec.until - now };
    return { allowed: true, lockedMs: 0 };
  }

  function recordLoginFail(ip) {
    const now = Date.now();
    const rec = loginFails.get(ip);
    if (!rec || now > rec.until) {
      loginFails.set(ip, { count: 1, until: now + LOGIN_WINDOW_MS });
    } else {
      rec.count += 1;
    }
  }

  function clearLoginFails(ip) {
    loginFails.delete(ip);
  }

  // 登录/设密前的人机验证（开启时强制）；body 由 handleApi 解析后传入
  async function requireCaptcha(body) {
    const sec = config.get().security;
    if (!sec.captchaEnabled) return { ok: true };
    let data = {};
    try { data = JSON.parse(body || '{}'); } catch {}
    return verifyCapToken(sec, data.capToken);
  }

  function passwordSet() {
    return !!config.get().security.loginPasswordHash;
  }

  function maskedConfig() {
    const cfg = config.get();
    const out = JSON.parse(JSON.stringify(cfg));
    out.security = {
      sessionHours: cfg.security.sessionHours,
      captchaEnabled: cfg.security.captchaEnabled,
      capSiteKey: cfg.security.capSiteKey,
      capServerUrl: cfg.security.capServerUrl,
      passwordSet: passwordSet(),
      capSecretSet: !!(process.env.CAP_SECRET_KEY || cfg.security.capSecret),
      loginPasswordHash: '',
      capSecret: '',
    };
    return out;
  }

  // ---- 状态/二维码 ----
  // base 为可选的外部接入地址（通常由前端根据当前页面网址传入）；
  // 未提供时回退到 publicAddr，再回退到局域网 IP 探测
  function appBaseUrl(base) {
    const cfg = config.get();
    if (base && typeof base === 'string' && base.trim()) return base.trim().replace(/\/+$/, '');
    if (cfg.web.publicAddr) return cfg.web.publicAddr;
    return `ws://${getLanIPv4()}:${cfg.web.port}`;
  }

  function statusPayload() {
    const cfg = config.get();
    const now = Date.now();
    return {
      onebot: {
        connected: onebot.connected,
        selfId: onebot.selfId,
        url: cfg.onebot.wsUrl,
      },
      dglab: {
        ready: true,
        paired: dglab.paired,
        controllerId: dglab.controllerId,
        appId: dglab.appId,
        endpoint: `${appBaseUrl()}/${dglab.controllerId}`,
        sendsPerSec: dglab.sendsPerSec,
      },
      trigger: {
        enabled: cfg.trigger.enabled,
        currentGear: cfg.currentGear,
        gearCount: cfg.gears.length,
        gearName: cfg.gears[cfg.currentGear - 1] ? cfg.gears[cfg.currentGear - 1].name : '',
        gearMode: cfg.trigger.gearMode,
        stack: cfg.trigger.stack,
        strengthRetry: cfg.trigger.strengthRetry,
        lastTrigger: state.lastTrigger,
        cooldownUntil: state.cooldownUntil,
        cooldownRemainSec: Math.max(0, Math.ceil((state.cooldownUntil - now) / 1000)),
      },
      pulseRemaining: {
        A: Math.max(0, Math.round(dglab.remainingSec('A'))),
        B: Math.max(0, Math.round(dglab.remainingSec('B'))),
      },
    };
  }

  // 动作处理（HTTP /api/action 与网页 WS 共用）
  async function handleAction(reqData) {
    const action = reqData && reqData.action;
    if (action === 'test') {
      const cfg = config.get();
      let gear;
      if (reqData.gear !== undefined && reqData.gear !== null && reqData.gear !== '') {
        if (typeof reqData.gear === 'object') {
          gear = normalizeGear(reqData.gear);
        } else {
          const n = Number(reqData.gear);
          gear = Number.isInteger(n) && n >= 1 && n <= cfg.gears.length ? cfg.gears[n - 1] : null;
          if (!gear) return { status: 400, body: { ok: false, error: `档位编号范围 1-${cfg.gears.length}` } };
        }
      }
      const r = fireShock({ type: 'web' }, gear || undefined);
      return { status: 200, body: { ok: r.ok, reason: r.reason, trigger: r, currentGear: cfg.currentGear } };
    }
    if (action === 'stop') {
      const r = dglab.stopAll();
      logger.warn(r.ok ? '网页触发紧急停止' : `紧急停止失败: ${r.reason}`);
      return { status: 200, body: { ok: r.ok, reason: r.reason } };
    }
    if (action === 'setGear') {
      const cfg = config.get();
      const n = Number(reqData.gear);
      if (!Number.isInteger(n) || n < 1 || n > cfg.gears.length) {
        return { status: 400, body: { ok: false, error: `档位编号范围 1-${cfg.gears.length}` } };
      }
      cfg.currentGear = n;
      config.save();
      logger.info(`网页切换档位 → ${n} (${cfg.gears[n - 1].name})`);
      return { status: 200, body: { ok: true, currentGear: n } };
    }
    if (action === 'reconnect') {
      applyConnections();
      logger.info('网页触发连接重连');
      return { status: 200, body: { ok: true } };
    }
    return { status: 400, body: { ok: false, error: '未知 action' } };
  }

  // ---- 网页控制台 WebSocket（/ws）：实时状态/日志推送 + 动作下发 ----
  const consoleClients = new Set();
  const consoleWss = new WebSocketServer({ noServer: true });

  function consoleSend(ws, obj) {
    if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); return true; } catch { return false; } }
    return false;
  }

  function broadcastStatus() {
    const payload = { type: 'status', ...statusPayload() };
    for (const c of consoleClients) consoleSend(c, payload);
  }

  function broadcastEvent(name, data) {
    const payload = { type: 'event', name, data: data || null };
    for (const c of consoleClients) consoleSend(c, payload);
  }

  const loggerUnsub = logger.subscribe((line) => {
    const payload = { type: 'log', line };
    for (const c of consoleClients) consoleSend(c, payload);
  });

  // 状态变化实时推送
  onebot.on('connected', broadcastStatus);
  onebot.on('disconnected', broadcastStatus);
  onebot.on('ready', broadcastStatus);
  dglab.on('paired', broadcastStatus);
  dglab.on('unpaired', broadcastStatus);
  dglab.on('connection', broadcastStatus);
  dglab.on('disconnection', broadcastStatus);
  if (ctx.events) {
    ctx.events.on('trigger', (t) => {
      broadcastStatus();
      broadcastEvent('trigger', t);
    });
  }

  async function handleConsoleMessage(ws, raw) {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }
    if (!data || typeof data !== 'object') return;
    if (data.type === 'status') {
      consoleSend(ws, { type: 'status', ...statusPayload() });
    } else if (data.type === 'logs') {
      consoleSend(ws, { type: 'logs', lines: logger.tail(300) });
    } else if (data.type === 'action') {
      const r = await handleAction(data);
      consoleSend(ws, { type: 'actionResult', status: r.status, ...r.body });
      broadcastStatus();
    } else if (data.type === 'pong' || data.type === 'heartbeat') {
      // 心跳，无需处理
    }
  }

  async function handleApi(req, res, url, body) {
    try {
      const sec = config.get().security;
      const isAuthed = !!sessionUser(req);

      // ---- 公开路由 ----
      if (url.pathname === '/api/session' && req.method === 'GET') {
        return sendJson(res, 200, {
          authenticated: isAuthed,
          passwordSet: passwordSet(),
          captchaEnabled: sec.captchaEnabled,
          capSiteKey: sec.capSiteKey,
          capServerUrl: sec.capServerUrl,
        });
      }

      if (url.pathname === '/api/setup' && req.method === 'POST') {
        if (passwordSet()) return sendJson(res, 400, { ok: false, error: '密码已设置，请直接登录' });
        const cap = await requireCaptcha(body);
        if (!cap.ok) return sendJson(res, 400, { ok: false, error: cap.error });
        let data;
        try { data = JSON.parse(body); } catch { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
        const pass = String(data.password || '');
        if (pass.length < 4) return sendJson(res, 400, { ok: false, error: '密码至少 4 位' });
        config.get().security.loginPasswordHash = hashPassword(pass);
        config.save();
        createSession(res);
        logger.info('已设置登录密码');
        return sendJson(res, 200, { ok: true });
      }

      if (url.pathname === '/api/login' && req.method === 'POST') {
        const ip = clientIp(req);
        const rate = checkLoginRate(ip);
        if (!rate.allowed) {
          return sendJson(res, 429, { ok: false, error: `尝试次数过多，请 ${Math.ceil(rate.lockedMs / 1000)} 秒后再试` });
        }
        const cap = await requireCaptcha(body);
        if (!cap.ok) {
          recordLoginFail(ip);
          return sendJson(res, 400, { ok: false, error: cap.error });
        }
        let data;
        try { data = JSON.parse(body); } catch { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
        if (!verifyPassword(data.password, config.get().security.loginPasswordHash)) {
          recordLoginFail(ip);
          logger.warn(`登录失败 (IP ${ip})`);
          return sendJson(res, 401, { ok: false, error: '密码错误' });
        }
        clearLoginFails(ip);
        createSession(res);
        logger.info(`登录成功 (IP ${ip})`);
        return sendJson(res, 200, { ok: true });
      }

      if (url.pathname === '/api/logout' && req.method === 'POST') {
        destroySession(req, res);
        return sendJson(res, 200, { ok: true });
      }

      // ---- 以下全部需要登录 ----
      if (!isAuthed) return sendJson(res, 401, { ok: false, error: '未登录' });

      if (url.pathname === '/api/change-password' && req.method === 'POST') {
        let data;
        try { data = JSON.parse(body); } catch { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
        if (!verifyPassword(data.currentPassword, config.get().security.loginPasswordHash)) {
          return sendJson(res, 400, { ok: false, error: '当前密码错误' });
        }
        const pass = String(data.newPassword || '');
        if (pass.length < 4) return sendJson(res, 400, { ok: false, error: '新密码至少 4 位' });
        config.get().security.loginPasswordHash = hashPassword(pass);
        config.save();
        logger.info('登录密码已修改');
        return sendJson(res, 200, { ok: true });
      }

      if (url.pathname === '/api/status' && req.method === 'GET') {
        return sendJson(res, 200, statusPayload());
      }

      if (url.pathname === '/api/config' && req.method === 'GET') {
        return sendJson(res, 200, maskedConfig());
      }

      if (url.pathname === '/api/config' && req.method === 'POST') {
        let next;
        try { next = JSON.parse(body); } catch { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
        const cfg = config.apply(next);
        applyConnections();
        logger.info('配置已保存，连接已重连');
        return sendJson(res, 200, { ok: true, config: maskedConfig() });
      }

      if (url.pathname === '/api/action' && req.method === 'POST') {
        let reqData;
        try { reqData = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
        const { status, body: out } = await handleAction(reqData);
        return sendJson(res, status, out);
      }

      if (url.pathname === '/api/qr' && req.method === 'GET') {
        if (!dglab.controllerId) return sendJson(res, 503, { ok: false, error: '控制端 ID 尚未初始化' });
        const baseUrl = appBaseUrl(url.searchParams.get('base'));
        const text = `https://www.dungeon-lab.com/app-download.php#DGLAB-SOCKET#${baseUrl}/${dglab.controllerId}`;
        try {
          const dataUrl = await QRCode.toDataURL(text, { width: 240, margin: 1 });
          return sendJson(res, 200, { ok: true, qrText: text, appUrl: `${baseUrl}/${dglab.controllerId}`, dataUrl });
        } catch (e) {
          return sendJson(res, 500, { ok: false, error: `二维码生成失败: ${e.message}` });
        }
      }

      if (url.pathname === '/api/logs' && req.method === 'GET') {
        return sendJson(res, 200, { lines: logger.tail(300), total: logger.all().length });
      }

      return sendJson(res, 404, { ok: false, error: 'Not Found' });
    } catch (e) {
      logger.error('API 处理异常:', e);
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  function serveStatic(req, res, url) {
    // cap-widget 组件（本地托管，避免 CDN 不可达）
    if (url.pathname.startsWith('/cap-assets/')) {
      const rel = url.pathname.slice('/cap-assets/'.length);
      const fp = path.join(CAP_WIDGET_DIR, rel);
      if (!fp.startsWith(CAP_WIDGET_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
      fs.readFile(fp, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not Found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
        res.end(data);
      });
      return;
    }

    let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
    filePath = path.join(STATIC_DIR, filePath);
    if (!filePath.startsWith(STATIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not Found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') {
      return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
    }
    if (url.pathname.startsWith('/api/')) {
      let body = '';
      if (req.method === 'POST') {
        for await (const chunk of req) body += chunk;
      }
      return handleApi(req, res, url, body);
    }
    serveStatic(req, res, url);
  });

  // 升级路由：/ws 走控制台 WS（需登录会话），其余交给 DG-LAB V3 服务器
  server.on('upgrade', (req, socket, head) => {
    let pathname = '/';
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch {}
    if (pathname !== '/ws') return;
    const token = parseCookies(req)[COOKIE_NAME];
    const s = token && sessions.get(token);
    if (!s) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (Date.now() > s.exp) {
      sessions.delete(token);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    consoleWss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('message', (raw) => handleConsoleMessage(ws, raw));
      ws.on('close', () => consoleClients.delete(ws));
      ws.on('error', () => {});
      consoleClients.add(ws);
      consoleSend(ws, { type: 'hello', time: Date.now() });
      consoleSend(ws, { type: 'status', ...statusPayload() });
      consoleSend(ws, { type: 'logs', lines: logger.tail(300) });
      logger.info(`网页控制台已通过 WS 连接 (${clientIp(req)})`);
    });
  });

  const consolePing = setInterval(() => {
    for (const c of consoleClients) {
      if (c.readyState !== 1) { consoleClients.delete(c); continue; }
      if (c.isAlive === false) { try { c.terminate(); } catch {} consoleClients.delete(c); continue; }
      c.isAlive = false;
      try { c.ping(); } catch {}
    }
  }, 30000);

  return {
    getHttpServer: () => server,
    start(port, host) {
      server.listen(port, host, () => {
        logger.info(`网页控制台已启动: http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`);
      });
      server.on('error', (e) => logger.error('控制台服务错误:', e.message));
    },
    stop() {
      try { clearInterval(consolePing); } catch {}
      try { loggerUnsub(); } catch {}
      for (const c of consoleClients) { try { c.terminate(); } catch {} }
      consoleClients.clear();
      try { server.close(); } catch {}
    },
  };
}

module.exports = createApiServer;
