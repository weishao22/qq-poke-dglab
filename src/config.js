const fs = require('fs');
const path = require('path');

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, '..', 'config.json');

const DEFAULTS = {
  onebot: {
    wsUrl: 'ws://127.0.0.1:6700/',
    accessToken: '',
  },
  dglab: {
    controllerId: '',
    sendsPerSec: 10,
  },
  trigger: {
    enabled: true,
    matchSelf: true,
    targetQq: [],
    groupIds: [],
    allowedPokers: [],
    cooldownSec: 5,
    pokeDedupSec: 3,
    stack: true,              // 同一目标短时内再次触发时追加时长（不中断当前波形）
    strengthRetry: true,      // 每次电击额外重发一次强度指令，防止 App 端强度丢失
    notifyGroup: true,
    notifyText: '【电击联动】{gear}（通道 {channel} 强度 {strength}，{duration} 秒）',
    gearMode: 'fixed',
  },
  gears: [
    { name: '一档 · 轻颤', channel: 'A', strength: 20, freqMs: 100, waveStrength: 40, durationSec: 1 },
    { name: '二档 · 酥麻', channel: 'A', strength: 40, freqMs: 50, waveStrength: 60, durationSec: 2 },
    { name: '三档 · 强烈', channel: 'A', strength: 80, freqMs: 30, waveStrength: 80, durationSec: 3 },
    { name: '四档 · 猛烈', channel: 'A', strength: 120, freqMs: 20, waveStrength: 90, durationSec: 4 },
    { name: '五档 · 暴击', channel: 'A', strength: 160, freqMs: 10, waveStrength: 100, durationSec: 5 },
  ],
  currentGear: 1,
  adminQq: [],
  security: {
    loginPasswordHash: '',
    sessionHours: 168,
    captchaEnabled: false,
    capSiteKey: '242df05265',
    capServerUrl: 'https://cap.qyserver.s.odn.cc',
    capSecret: '',
  },
  web: {
    host: '0.0.0.0',
    port: 8081,
    publicAddr: '',
  },
};

function clamp(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function numList(v) {
  if (!Array.isArray(v)) return [];
  return v.map(String).map((s) => s.trim()).filter(Boolean);
}

function normalizeGear(g) {
  const src = g && typeof g === 'object' ? g : {};
  const channel = src.channel === 'B' || src.channel === 'AB' ? src.channel : 'A';
  return {
    name: String(src.name || '档位').slice(0, 32),
    channel,
    strength: clamp(src.strength, 0, 200),
    freqMs: clamp(src.freqMs, 10, 1000),
    waveStrength: clamp(src.waveStrength, 0, 100),
    durationSec: clamp(src.durationSec, 1, 300),
    customWave: String(src.customWave || '').slice(0, 500),
  };
}

function normalize(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const gears = Array.isArray(src.gears) && src.gears.length
    ? src.gears.map(normalizeGear)
    : DEFAULTS.gears.map(normalizeGear);
  const trig = src.trigger && typeof src.trigger === 'object' ? src.trigger : {};
  const onebot = src.onebot && typeof src.onebot === 'object' ? src.onebot : {};
  const dglab = src.dglab && typeof src.dglab === 'object' ? src.dglab : {};
  const web = src.web && typeof src.web === 'object' ? src.web : {};
  const sec = src.security && typeof src.security === 'object' ? src.security : {};
  return {
    onebot: {
      wsUrl: String(onebot.wsUrl || DEFAULTS.onebot.wsUrl),
      accessToken: String(onebot.accessToken || ''),
    },
    dglab: {
      controllerId: String(dglab.controllerId || ''),
      sendsPerSec: clamp(dglab.sendsPerSec !== undefined ? dglab.sendsPerSec : DEFAULTS.dglab.sendsPerSec, 1, 10),
    },
    trigger: {
      enabled: trig.enabled !== undefined ? !!trig.enabled : DEFAULTS.trigger.enabled,
      matchSelf: trig.matchSelf !== undefined ? !!trig.matchSelf : DEFAULTS.trigger.matchSelf,
      targetQq: numList(trig.targetQq),
      groupIds: numList(trig.groupIds),
      allowedPokers: numList(trig.allowedPokers),
      cooldownSec: clamp(trig.cooldownSec !== undefined ? trig.cooldownSec : DEFAULTS.trigger.cooldownSec, 0, 86400),
      pokeDedupSec: clamp(trig.pokeDedupSec !== undefined ? trig.pokeDedupSec : DEFAULTS.trigger.pokeDedupSec, 0, 60),
      stack: trig.stack !== undefined ? !!trig.stack : DEFAULTS.trigger.stack,
      strengthRetry: trig.strengthRetry !== undefined ? !!trig.strengthRetry : DEFAULTS.trigger.strengthRetry,
      notifyGroup: trig.notifyGroup !== undefined ? !!trig.notifyGroup : DEFAULTS.trigger.notifyGroup,
      notifyText: String(trig.notifyText || DEFAULTS.trigger.notifyText),
      gearMode: trig.gearMode === 'cycle' ? 'cycle' : 'fixed',
    },
    gears,
    currentGear: clamp(src.currentGear, 1, gears.length),
    adminQq: numList(src.adminQq),
    security: {
      loginPasswordHash: String(sec.loginPasswordHash || '').slice(0, 300),
      sessionHours: clamp(sec.sessionHours !== undefined ? sec.sessionHours : DEFAULTS.security.sessionHours, 1, 720),
      captchaEnabled: sec.captchaEnabled !== undefined ? !!sec.captchaEnabled : DEFAULTS.security.captchaEnabled,
      capSiteKey: String(sec.capSiteKey || DEFAULTS.security.capSiteKey).trim(),
      capServerUrl: String(sec.capServerUrl || DEFAULTS.security.capServerUrl).replace(/\/+$/, ''),
      capSecret: String(sec.capSecret || '').slice(0, 300),
    },
    web: {
      host: String(web.host || DEFAULTS.web.host),
      port: clamp(web.port !== undefined ? web.port : DEFAULTS.web.port, 1, 65535),
      publicAddr: String(web.publicAddr || '').replace(/\/+$/, ''),
    },
  };
}

let current = null;

function load() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2) + '\n');
    } catch {}
  }
  current = normalize(raw);
  return current;
}

function save() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2) + '\n');
    return true;
  } catch (e) {
    return false;
  }
}

function get() {
  return current;
}

function apply(next) {
  const prev = current || {};
  const nextCfg = normalize(next);
  // 安全字段合并：页面提交的配置不携带哈希/密钥时保留现有值（哈希仅通过专门接口修改）
  const ns = next && next.security;
  if (!ns || !String(ns.loginPasswordHash || '')) {
    nextCfg.security.loginPasswordHash = (prev.security && prev.security.loginPasswordHash) || '';
  }
  if (!ns || !String(ns.capSecret || '')) {
    nextCfg.security.capSecret = (prev.security && prev.security.capSecret) || '';
  }
  current = nextCfg;
  save();
  return current;
}

module.exports = { load, save, get, apply, normalizeGear, defaults: () => JSON.parse(JSON.stringify(DEFAULTS)), path: CONFIG_PATH };
