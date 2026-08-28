const crypto = require('crypto');
const { EventEmitter } = require('events');
const config = require('./config');
const logger = require('./logger');
const OneBotClient = require('./onebot');
const DglabV3Server = require('./dglab');
const createApiServer = require('./server');
const { hasCustomWave } = require('./wave');

config.load();
const cfg = () => config.get();

const onebot = new OneBotClient();
const dglab = new DglabV3Server();

// 内置控制端 ID：首次启动生成并持久化，二维码长期有效
if (!cfg().dglab.controllerId) {
  cfg().dglab.controllerId = crypto.randomUUID();
  config.save();
}

const state = {
  cooldownUntil: 0,
  lastTrigger: null,
};

function applyConnections() {
  onebot.setConfig(cfg().onebot.wsUrl, cfg().onebot.accessToken);
  onebot.restart();
  dglab.init(cfg().dglab.controllerId, cfg().dglab.sendsPerSec);
}

function currentGear() {
  const gears = cfg().gears;
  return gears[cfg().currentGear - 1] || gears[0];
}

function fireShock(source, gearOverride) {
  const gear = gearOverride || currentGear();
  if (gear.customWave && String(gear.customWave).trim() && !hasCustomWave(gear)) {
    logger.warn(`档位「${gear.name}」自定义波形格式无效，已回退默认波形: ${String(gear.customWave).trim()}`);
  }
  gear.strengthRetry = cfg().trigger.strengthRetry;
  // 叠加：目标通道仍在输出且开启叠加时，追加时长而非重新开始
  const stack = cfg().trigger.stack && dglab.channelsActive(gear.channel);
  const res = dglab.shock(gear, stack);
  state.lastTrigger = {
    time: Date.now(),
    ok: res.ok,
    reason: res.reason || '',
    gear: gear.name,
    channel: gear.channel,
    strength: gear.strength,
    freqMs: gear.freqMs,
    durationSec: gear.durationSec,
    stack,
    source: source && source.type === 'qq'
      ? `QQ ${source.userId}${source.groupId ? ` (群 ${source.groupId})` : ''}`
      : '网页手动',
  };
  if (res.ok) {
    logger.info(`${stack ? '叠加' : '触发'}: ${gear.name} | 通道${gear.channel} 强度${gear.strength} 频率${gear.freqMs}ms 时长${gear.durationSec}s${stack ? '（延长）' : ''} | 来源: ${state.lastTrigger.source}`);
  } else {
    logger.warn(`联动触发失败: ${res.reason} | 来源: ${state.lastTrigger.source}`);
  }

  // 循环递增只对自动触发/当前档位测试生效；单独测试某一档（指定档位）不改变当前档位
  if (res.ok && cfg().trigger.gearMode === 'cycle' && !gearOverride) {
    cfg().currentGear = (cfg().currentGear % cfg().gears.length) + 1;
    config.save();
    logger.info(`档位循环模式: 下次触发将使用 ${currentGear().name}`);
  }

  events.emit('trigger', state.lastTrigger);

  if (res.ok && cfg().trigger.notifyGroup && source && source.groupId) {
    const text = cfg().trigger.notifyText
      .replace(/\{gear\}/g, gear.name)
      .replace(/\{strength\}/g, String(gear.strength))
      .replace(/\{channel\}/g, gear.channel)
      .replace(/\{duration\}/g, String(gear.durationSec))
      .replace(/\{freq\}/g, String(gear.freqMs))
      .replace(/\{user\}/g, source.userId)
      .replace(/\{target\}/g, source.targetId || '');
    onebot.sendGroupMessage(source.groupId, text);
  }
  return state.lastTrigger;
}

// 戳一戳事件: post_type=notice, notice_type=notify, sub_type=poke
// 指纹去重：同一发起人戳同一目标（同群）在 pokeDedupSec 内只触发一次，
// 防 OneBot 实现重复上报同一戳导致重复电击/重复群通知
const POKE_SEEN_TTL_MS = 10000;
const pokeSeen = new Map();

function handlePoke(ev) {
  const c = cfg();
  if (!c.trigger.enabled) return;

  const target = String(ev.target_id);
  const selfHit = c.trigger.matchSelf && onebot.selfId > 0 && target === String(onebot.selfId);
  const listed = c.trigger.targetQq.includes(target);
  if (!selfHit && !listed) return;
  if (c.trigger.groupIds.length && !c.trigger.groupIds.includes(String(ev.group_id))) return;
  if (c.trigger.allowedPokers.length && !c.trigger.allowedPokers.includes(String(ev.user_id))) return;

  const now = Date.now();
  if (c.trigger.pokeDedupSec > 0) {
    const key = `${ev.group_id || ''}:${target}:${ev.user_id || ''}`;
    const last = pokeSeen.get(key) || 0;
    pokeSeen.set(key, now);
    if (now - last < c.trigger.pokeDedupSec * 1000) {
      logger.info(`重复戳一戳事件已忽略 (${key})，${c.trigger.pokeDedupSec}s 内不再触发`);
      return;
    }
    if (pokeSeen.size > 200) {
      for (const [k, t] of pokeSeen) {
        if (now - t > POKE_SEEN_TTL_MS) pokeSeen.delete(k);
      }
    }
  }

  if (now < state.cooldownUntil) {
    logger.info(`戳一戳命中目标 ${target}，但处于冷却期 (${((state.cooldownUntil - now) / 1000).toFixed(1)}s 后可用)`);
    return;
  }
  state.cooldownUntil = now + c.trigger.cooldownSec * 1000;
  logger.info(`戳一戳命中: 目标 ${target}，发起人 ${ev.user_id}${ev.group_id ? `，群 ${ev.group_id}` : ''}`);
  fireShock({ type: 'qq', userId: String(ev.user_id), targetId: target, groupId: String(ev.group_id || '') });
}

// QQ 群内命令（群消息事件）
function handleCommand(ev) {
  const text = String(ev.raw_message || '').trim();
  if (!text || !text.startsWith('/')) return;
  const c = cfg();
  const userId = String(ev.user_id);
  const isAdmin = c.adminQq.length === 0 || c.adminQq.includes(userId);
  const reply = (t) => { if (ev.group_id) onebot.sendGroupMessage(ev.group_id, t); };

  if (text === '/档位' || text === '/档位帮助') {
    const lines = c.gears.map((g, i) => `${i + 1}. ${g.name}｜强度${g.strength}｜${g.freqMs}ms｜${g.durationSec}s${i === c.currentGear - 1 ? ' ←当前' : ''}`);
    reply(`当前档位: ${currentGear().name}\n${lines.join('\n')}\n管理员: /档位 <编号> 切换 ｜ /电 立即触发 ｜ /电停 紧急停止`);
    return;
  }

  const m = text.match(/^\/档位\s+(\d+)$/);
  if (m) {
    if (!isAdmin) { reply('你没有权限使用该命令'); return; }
    const n = parseInt(m[1], 10);
    if (n < 1 || n > c.gears.length) { reply(`档位编号范围 1-${c.gears.length}`); return; }
    c.currentGear = n;
    config.save();
    logger.info(`QQ ${userId} 切换档位 → ${n} (${currentGear().name})`);
    reply(`已切换到 ${n} 档: ${currentGear().name}（强度${currentGear().strength}）`);
    return;
  }

  if (text === '/电') {
    if (!isAdmin) { reply('你没有权限使用该命令'); return; }
    logger.info(`QQ ${userId} 手动触发电击`);
    const r = fireShock({ type: 'qq', userId, groupId: String(ev.group_id || '') });
    if (!r.ok) reply(`触发失败: ${r.reason}`);
    return;
  }

  if (text === '/电停' || text === '/急停') {
    if (!isAdmin) { reply('你没有权限使用该命令'); return; }
    const r = dglab.stopAll();
    logger.warn(`QQ ${userId} 触发紧急停止${r.ok ? '' : `（失败: ${r.reason}）`}`);
    reply(r.ok ? '已紧急停止：两通道波形清除、强度归零' : `紧急停止失败: ${r.reason}`);
  }
}

// ---- OneBot 事件（客户端 WS → OneBot 服务器）----
onebot.on('connected', () => logger.info('已连接 OneBot WebSocket，正在获取机器人信息...'));
onebot.on('disconnected', () => logger.warn('OneBot 连接断开，5 秒后自动重连'));
onebot.on('ready', (selfId) => logger.info(`已获取机器人 QQ 号 (self_id): ${selfId}`));
onebot.on('error', (msg) => logger.warn(`[OneBot] ${msg}`));
onebot.on('event', (ev) => {
  if (ev.post_type === 'notice' && ev.notice_type === 'notify' && ev.sub_type === 'poke') {
    handlePoke(ev);
  } else if (ev.post_type === 'message' && ev.message_type === 'group') {
    handleCommand(ev);
  }
});

// ---- 内置 DG-LAB V3 服务器（App 作为客户端连接本程序）----
dglab.on('connection', (clientId, targetId) => {
  logger.info(`[中继] 新连接: ${clientId}${targetId ? ` → 目标 ${targetId}` : ''}`);
});
dglab.on('paired', (appId) => logger.info(`App 已配对 (被控端 ${appId})，可以电击`));
dglab.on('unpaired', () => logger.warn('App 已断开配对'));
dglab.on('disconnection', (clientId) => logger.info(`[中继] 连接断开: ${clientId}`));
dglab.on('feedback', (msg) => logger.info(`[App 回传] ${msg}`));
dglab.on('strength', (msg) => logger.info(`[App 强度上报] ${msg}`));
dglab.on('pulseDone', (ch) => logger.info(`[波形] 通道 ${ch} 波形发送完毕`));
dglab.on('stacked', (ch, remainSec) => logger.info(`[叠加] 通道 ${ch} 追加时长，当前剩余约 ${remainSec.toFixed(1)}s`));

// ---- HTTP 控制台 + 内置 V3 WS 服务器（共用端口）----
const events = new EventEmitter();
const api = createApiServer({ config, onebot, dglab, state, fireShock, applyConnections, events });
dglab.attach(api.getHttpServer());
applyConnections();
api.start(cfg().web.port, cfg().web.host);

logger.info('QQ 戳一戳 → 郊狼联动服务已启动');
logger.info(`控制台: http://127.0.0.1:${cfg().web.port}`);
logger.info(`OneBot(客户端): ${cfg().onebot.wsUrl}`);
logger.info(`郊狼中继(本程序内置 V3 服务器): ws://0.0.0.0:${cfg().web.port}/<App 扫码接入>`);
logger.info(`控制端 ID: ${cfg().dglab.controllerId}`);
if (cfg().trigger.enabled) {
  const parts = [];
  if (cfg().trigger.matchSelf) parts.push('戳机器人');
  if (cfg().trigger.targetQq.length) parts.push(`戳指定QQ(${cfg().trigger.targetQq.join(',')})`);
  logger.info(`触发规则: ${parts.join(' / ') || '未配置目标'}`);
}
logger.info(`当前档位: ${cfg().currentGear} (${currentGear().name})，档位模式: ${cfg().trigger.gearMode === 'cycle' ? '循环' : '固定'}`);

process.on('unhandledRejection', (e) => logger.error('unhandledRejection:', e));
process.on('SIGINT', () => {
  logger.info('收到退出信号，正在关闭...');
  onebot.stop();
  api.stop();
  process.exit(0);
});
