const { EventEmitter } = require('events');
const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('crypto');
const logger = require('./logger');
const { buildFrames } = require('./wave');

// 内置 DG-LAB Socket V3 WebSocket 服务器（协议参考 dglab-websocket-server-main/v3-server.ts
// 与 郊狼网页控制台/server.js）。本程序同时充当「控制端」：DG-LAB App 作为被控端，
// 扫码连接 ws://<host>:<port>/<controllerId> 后与本程序配对，戳一戳触发时直接下发
// strength-* / clear-* / pulse-* 指令。

const HEARTBEAT_MS = 60000;
const IDLE_TIMEOUT_MS = 5 * 60000;
const PULSE_REPLACE_DELAY_MS = 150;
const CLOSE_INVALID_TARGET = 4001;

function normalizeChannel(value, fallback) {
  const v = value === undefined || value === null ? fallback : value;
  if (v === 1 || v === '1' || v === 'A' || v === 'a') return { letter: 'A', number: 1 };
  if (v === 2 || v === '2' || v === 'B' || v === 'b') return { letter: 'B', number: 2 };
  return undefined;
}

class DglabV3Server extends EventEmitter {
  constructor() {
    super();
    this.wss = null;
    this.httpServer = null;
    this.controllerId = '';
    this.sendsPerSec = 10;
    this.connections = new Map();   // clientId -> { ws, idleTimer }
    this.wsToClientId = new Map();  // ws -> clientId
    this.webToApp = new Map();      // 控制端 -> 被控端
    this.appToWeb = new Map();      // 被控端 -> 控制端
    this.pulseTimers = new Map();   // `<controllerId>:<A|B>` -> task
    this.heartbeatTimer = null;
  }

  init(controllerId, sendsPerSec) {
    if (!this.controllerId && controllerId) this.controllerId = controllerId;
    this.sendsPerSec = Math.min(10, Math.max(1, Number(sendsPerSec) || 10));
    return this;
  }

  get appId() {
    return this.webToApp.get(this.controllerId) || '';
  }

  get paired() {
    return this.webToApp.has(this.controllerId);
  }

  attach(httpServer) {
    this.httpServer = httpServer;
    this.wss = new WebSocketServer({ noServer: true });
    httpServer.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), HEARTBEAT_MS);
    return this;
  }

  handleUpgrade(req, socket, head) {
    let targetId = '';
    try {
      const url = new URL(req.url, 'http://localhost');
      // 网页控制台 WS（/ws）由 server.js 处理，不进入 DG-LAB 协议
      if (url.pathname === '/ws') return;
      targetId = (url.searchParams.get('targetId') || url.searchParams.get('tid') || url.pathname.slice(1).trim() || '').trim();
    } catch {
      targetId = '';
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, targetId));
  }

  onConnection(ws, targetId) {
    const clientId = crypto.randomUUID();

    if (targetId) {
      if (!this.isAvailableTarget(targetId)) {
        this.send(ws, { type: 'error', clientId, targetId, message: String(CLOSE_INVALID_TARGET) });
        ws.close(CLOSE_INVALID_TARGET, 'invalid_target_id');
        return;
      }
    }

    this.connections.set(clientId, { ws, idleTimer: null });
    this.wsToClientId.set(ws, clientId);
    this.startIdleTimer(clientId);
    this.send(ws, { type: 'bind', clientId, targetId: '', message: 'targetId' });

    if (targetId) {
      const result = this.pair(targetId, clientId);
      if (!result.ok) {
        this.cancelIdleTimer(clientId);
        this.connections.delete(clientId);
        this.wsToClientId.delete(ws);
        this.send(ws, { type: 'error', clientId, targetId, message: String(CLOSE_INVALID_TARGET) });
        ws.close(CLOSE_INVALID_TARGET, 'invalid_target_id');
        return;
      }
      const bindMsg = { type: 'bind', clientId: targetId, targetId: clientId, message: result.code };
      this.sendToClient(targetId, bindMsg);
      this.send(ws, bindMsg);
      if (targetId === this.controllerId) this.emit('paired', clientId);
    }

    ws.on('message', (raw) => this.onMessage(ws, raw));
    ws.on('close', (code) => this.onClose(ws, code));
    ws.on('error', () => {});
    this.emit('connection', clientId, targetId);
  }

  onMessage(ws, raw) {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return this.sendError(ws, '', '', '403'); }
    if (!data || typeof data !== 'object') return this.sendError(ws, '', '', '403');
    if (!data.type || !data.clientId || !data.targetId || !data.message) return this.sendError(ws, '', '', '403');
    if (typeof data.clientId !== 'string' || typeof data.targetId !== 'string' || typeof data.message !== 'string') {
      return this.sendError(ws, '', '', '403');
    }
    if (!data.clientId.length || !data.targetId.length) return this.sendError(ws, '', '', '403');

    const senderId = this.wsToClientId.get(ws);
    if (senderId !== data.clientId && senderId !== data.targetId) {
      return this.sendError(ws, data.clientId, data.targetId, '404');
    }

    if (data.type === 'heartbeat') return;

    if (data.type === 'bind') {
      return this.handleBind(ws, data);
    }

    // App 上报（feedback/strength）转发给配对的控制端；内置控制端则直接发出事件
    if (data.message.startsWith('feedback') || data.message.startsWith('strength')) {
      if (this.appToWeb.has(senderId)) {
        const webId = this.appToWeb.get(senderId);
        if (webId === this.controllerId) {
          this.emit(data.message.startsWith('feedback') ? 'feedback' : 'strength', data.message);
        } else {
          this.sendToClient(webId, { type: data.type, clientId: senderId, targetId: webId, message: data.message });
        }
        return;
      }
    }

    const rt = typeof data.type === 'number' ? data.type : (/^\d+$/.test(data.type) ? parseInt(data.type, 10) : undefined);
    if (rt === 1 || rt === 2 || rt === 3) {
      if (senderId !== data.clientId) return this.sendError(ws, data.clientId, data.targetId, '404');
      if (!this.isPaired(data.clientId, data.targetId)) return this.sendError(ws, data.clientId, data.targetId, '402');
      const ch = normalizeChannel(data.channel, 1);
      if (!ch) return this.sendError(ws, data.clientId, data.targetId, '406');
      const sendType = rt - 1;
      const strength = rt === 3 ? (typeof data.strength === 'number' ? data.strength : parseInt(data.strength) || 0) : 1;
      const sent = this.sendToClient(data.targetId, {
        type: 'msg', clientId: data.clientId, targetId: data.targetId, message: `strength-${ch.number}+${sendType}+${strength}`,
      });
      if (!sent) return this.sendError(ws, data.clientId, data.targetId, '404');
      return;
    }

    if (rt === 4) {
      if (senderId !== data.clientId) return this.sendError(ws, data.clientId, data.targetId, '404');
      if (!this.isPaired(data.clientId, data.targetId)) return this.sendError(ws, data.clientId, data.targetId, '402');
      const ch = normalizeChannel(data.channel, 1);
      if (!ch) return this.sendError(ws, data.clientId, data.targetId, '406');
      if (data.message.includes('clear')) {
        this.sendToClient(data.targetId, { type: 'msg', clientId: data.clientId, targetId: data.targetId, message: `clear-${ch.number}` });
        this.clearTimer(data.clientId, ch.letter);
      } else {
        const strength = typeof data.strength === 'number' ? data.strength : parseInt(data.strength) || 0;
        this.sendToClient(data.targetId, { type: 'msg', clientId: data.clientId, targetId: data.targetId, message: `strength-${ch.number}+2+${strength}` });
      }
      return;
    }

    if (data.type === 'clientMsg') {
      if (senderId !== data.clientId) return this.sendError(ws, data.clientId, data.targetId, '404');
      if (!this.isPaired(data.clientId, data.targetId)) return this.sendError(ws, data.clientId, data.targetId, '402');
      const ch = normalizeChannel(data.channel);
      if (!ch) return this.sendError(ws, data.clientId, data.targetId, '406');
      const target = this.connections.get(data.targetId);
      if (!target || target.ws.readyState !== WebSocket.OPEN) return this.sendError(ws, data.clientId, data.targetId, '404');
      const time = Math.max(1, parseInt(data.time) || 1);
      const frames = this.parsePulseFrames(data.message);
      if (!frames) return this.sendError(ws, data.clientId, data.targetId, '406');
      this.queuePulse(data.clientId, data.targetId, ch.letter, frames, time, ws);
      return;
    }

    // 其他消息直接转发
    if (this.isPaired(data.clientId, data.targetId)) {
      const recipient = senderId === data.clientId ? data.targetId : data.clientId;
      const swap = data.type === 'msg' && this.appToWeb.has(senderId);
      this.sendToClient(recipient, {
        type: data.type,
        clientId: swap ? senderId : data.clientId,
        targetId: swap ? recipient : data.targetId,
        message: data.message,
      });
    }
  }

  handleBind(ws, data) {
    const webId = data.clientId;
    const appId = data.targetId;
    const result = this.pair(webId, appId);
    const resp = { type: 'bind', clientId: webId, targetId: appId, message: result.code };
    if (!result.ok) return this.send(ws, resp);
    this.sendToClient(webId, resp);
    if (webId !== appId) this.sendToClient(appId, resp);
    if (webId === this.controllerId) this.emit('paired', appId);
  }

  onClose(ws) {
    const clientId = this.wsToClientId.get(ws);
    if (!clientId) return;
    this.cancelIdleTimer(clientId);
    this.wsToClientId.delete(ws);
    this.connections.delete(clientId);
    const pairedId = this.pairedId(clientId);
    const webId = this.webIdFor(clientId);
    if (webId) this.clearClientTimers(webId);
    this.unpair(clientId);
    if (pairedId) {
      const other = this.connections.get(pairedId);
      if (other && other.ws.readyState === WebSocket.OPEN) {
        this.send(other.ws, { type: 'break', clientId: webId || pairedId, targetId: clientId, message: '209' });
        other.ws.close(1000, 'partner_disconnected');
      }
    }
    if (webId === this.controllerId || pairedId === this.controllerId) this.emit('unpaired');
    this.emit('disconnection', clientId);
  }

  sendHeartbeat() {
    for (const [clientId, c] of this.connections) {
      if (c.ws.readyState !== WebSocket.OPEN) continue;
      this.send(c.ws, { type: 'heartbeat', clientId, targetId: this.pairedId(clientId) || '', message: '200' });
    }
  }

  startIdleTimer(clientId) {
    this.cancelIdleTimer(clientId);
    const c = this.connections.get(clientId);
    if (!c) return;
    c.idleTimer = setTimeout(() => this.closeIfUnpaired(clientId), IDLE_TIMEOUT_MS);
  }

  cancelIdleTimer(clientId) {
    const c = this.connections.get(clientId);
    if (c && c.idleTimer) { clearTimeout(c.idleTimer); c.idleTimer = null; }
  }

  closeIfUnpaired(clientId) {
    const c = this.connections.get(clientId);
    if (!c || c.ws.readyState !== WebSocket.OPEN) return;
    if (this.isBound(clientId)) return;
    this.send(c.ws, { type: 'error', clientId, targetId: '', message: 'idle_timeout' });
    c.ws.close(1000, 'idle_timeout');
  }

  // ---- 配对关系 ----
  pair(webId, appId) {
    if (webId === appId) return { ok: false, code: '401' };
    const webOk = webId === this.controllerId || this.connections.has(webId);
    if (!webOk || !this.connections.has(appId)) return { ok: false, code: '401' };
    if (this.isPaired(webId, appId)) return { ok: true, code: '200' };
    if (this.isBound(webId) || this.isBound(appId)) return { ok: false, code: '400' };
    this.webToApp.set(webId, appId);
    this.appToWeb.set(appId, webId);
    this.cancelIdleTimer(appId);
    if (webId !== this.controllerId) this.cancelIdleTimer(webId);
    return { ok: true, code: '200' };
  }

  unpair(clientId) {
    const appId = this.webToApp.get(clientId);
    if (appId) { this.webToApp.delete(clientId); this.appToWeb.delete(appId); return; }
    const webId = this.appToWeb.get(clientId);
    if (webId) { this.appToWeb.delete(clientId); this.webToApp.delete(webId); }
  }

  isBound(clientId) { return this.webToApp.has(clientId) || this.appToWeb.has(clientId); }

  isAvailableTarget(targetId) {
    if (targetId === this.controllerId) return !this.isBound(targetId);
    const c = this.connections.get(targetId);
    return !!c && c.ws.readyState === WebSocket.OPEN && !this.isBound(targetId);
  }

  isPaired(clientId, targetId) {
    return this.webToApp.get(clientId) === targetId || this.appToWeb.get(clientId) === targetId;
  }

  pairedId(clientId) { return this.webToApp.get(clientId) || this.appToWeb.get(clientId) || ''; }

  webIdFor(clientId) {
    if (this.webToApp.has(clientId)) return clientId;
    return this.appToWeb.get(clientId);
  }

  // ---- 电击引擎（内置控制端 -> 已配对 App）----
  // stack=true 时叠加时长：不中断当前波形，追加新帧包；仅更新强度（如有变化）
  shock(gear, stack = false) {
    if (!this.paired) return { ok: false, reason: 'App 未接入（未配对）' };
    const appId = this.appId;
    const channels = gear.channel === 'AB' ? ['A', 'B'] : [gear.channel];
    const frames = buildFrames(gear);
    for (const ch of channels) {
      const num = ch === 'A' ? 1 : 2;
      if (!stack) {
        this.sendToClient(appId, { type: 'msg', clientId: this.controllerId, targetId: appId, message: `clear-${num}` });
      }
      this.sendToClient(appId, { type: 'msg', clientId: this.controllerId, targetId: appId, message: `strength-${num}+2+${gear.strength}` });
      // 强度重发：150ms 后再发一次，防止 App 端偶发丢失强度指令
      if (gear.strengthRetry) {
        setTimeout(() => {
          this.sendToClient(appId, { type: 'msg', clientId: this.controllerId, targetId: appId, message: `strength-${num}+2+${gear.strength}` });
        }, 150);
      }
      this.queuePulse(this.controllerId, appId, ch, frames, gear.durationSec, stack, gear.strength);
    }
    return { ok: true };
  }

  stopAll() {
    if (!this.paired) return { ok: false, reason: 'App 未接入（未配对）' };
    const appId = this.appId;
    for (const ch of ['A', 'B']) {
      this.clearTimer(this.controllerId, ch);
      const num = ch === 'A' ? 1 : 2;
      this.sendToClient(appId, { type: 'msg', clientId: this.controllerId, targetId: appId, message: `clear-${num}` });
      this.sendToClient(appId, { type: 'msg', clientId: this.controllerId, targetId: appId, message: `strength-${num}+2+0` });
    }
    return { ok: true };
  }

  // 指定通道当前剩余波形时长（秒）
  remainingSec(ch) {
    const task = this.pulseTimers.get(`${this.controllerId}:${ch}`);
    if (!task) return 0;
    return Math.max(0, (task.chunks.length - task.index) / this.sendsPerSec);
  }

  // 指定档位通道中是否有仍在输出的波形（用于决定是否叠加）
  channelsActive(channelSpec) {
    const chs = channelSpec === 'AB' ? ['A', 'B'] : [channelSpec];
    return chs.some((c) => this.remainingSec(c) > 0);
  }

  parsePulseFrames(message) {
    const idx = message.indexOf(':');
    if (idx <= 0) return undefined;
    let parsed;
    try { parsed = JSON.parse(message.slice(idx + 1)); } catch { return undefined; }
    if (!Array.isArray(parsed) || !parsed.length) return undefined;
    if (!parsed.every((s) => typeof s === 'string' && /^[0-9a-fA-F]{16}$/.test(s))) return undefined;
    return parsed.map((s) => s.toUpperCase());
  }

  queuePulse(controllerId, appId, channelLetter, frames, timeSec, stack = false, strength = null) {
    const key = `${controllerId}:${channelLetter}`;
    const sps = this.sendsPerSec;
    const totalFrames = Math.max(1, timeSec * 10);
    const fitted = Array.from({ length: totalFrames }, (_, i) => frames[i % frames.length]);
    const packetCount = Math.max(1, timeSec * sps);
    const chunks = [];
    for (let i = 0; i < packetCount; i++) {
      const start = Math.floor((i * fitted.length) / packetCount);
      const end = Math.floor(((i + 1) * fitted.length) / packetCount);
      if (end > start) chunks.push(fitted.slice(start, end));
    }
    const intervalMs = 1000 / sps;
    const num = channelLetter === 'A' ? 1 : 2;

    const old = this.pulseTimers.get(key);
    if (old && stack) {
      // 叠加模式：不中断当前波形，追加新帧包；强度有变化时补发强度
      if (strength !== null && old.strength !== strength) {
        this.sendToClient(appId, { type: 'msg', clientId: controllerId, targetId: appId, message: `strength-${num}+2+${strength}` });
      }
      old.chunks.push(...chunks);
      if (strength !== null) old.strength = strength;
      const remain = old.chunks.length - old.index;
      this.emit('stacked', channelLetter, Math.max(0, remain / sps));
      return;
    }
    if (old) {
      // 替换模式：清空旧波形后重新开始
      this.clearTimer(controllerId, channelLetter);
      this.sendToClient(appId, { type: 'msg', clientId: controllerId, targetId: appId, message: `clear-${num}` });
      setTimeout(() => this.startPulse(key, controllerId, appId, channelLetter, chunks, intervalMs, strength), PULSE_REPLACE_DELAY_MS);
      return;
    }
    this.startPulse(key, controllerId, appId, channelLetter, chunks, intervalMs, strength);
  }

  startPulse(key, controllerId, appId, channelLetter, chunks, intervalMs, strength) {
    const first = chunks[0];
    if (!first) return;
    const target = this.connections.get(appId);
    if (!target || target.ws.readyState !== WebSocket.OPEN) return;
    const task = { controllerId, appId, channel: channelLetter, chunks, index: 0, strength: strength !== null ? strength : null, timer: null };
    const sendNext = () => {
      const t = this.connections.get(appId);
      if (!t || t.ws.readyState !== WebSocket.OPEN) {
        if (task.timer) clearInterval(task.timer);
        this.pulseTimers.delete(key);
        return;
      }
      const chunk = task.chunks[task.index];
      if (chunk === undefined) {
        if (task.timer) clearInterval(task.timer);
        this.pulseTimers.delete(key);
        this.emit('pulseDone', channelLetter);
        return;
      }
      this.send(t.ws, {
        type: 'msg',
        clientId: controllerId,
        targetId: appId,
        message: `pulse-${channelLetter}:${JSON.stringify(chunk)}`,
      });
      task.index += 1;
    };
    sendNext();
    if (task.index >= task.chunks.length) {
      this.pulseTimers.delete(key);
      this.emit('pulseDone', channelLetter);
      return;
    }
    task.timer = setInterval(() => {
      if (task.index >= task.chunks.length) {
        clearInterval(task.timer);
        this.pulseTimers.delete(key);
        this.emit('pulseDone', channelLetter);
      } else {
        sendNext();
      }
    }, intervalMs);
    this.pulseTimers.set(key, task);
  }

  clearTimer(controllerId, channelLetter) {
    const key = `${controllerId}:${channelLetter}`;
    const t = this.pulseTimers.get(key);
    if (t) { if (t.timer) clearInterval(t.timer); this.pulseTimers.delete(key); }
  }

  clearClientTimers(controllerId) {
    for (const [key, t] of this.pulseTimers) {
      if (t.controllerId !== controllerId) continue;
      if (t.timer) clearInterval(t.timer);
      this.pulseTimers.delete(key);
    }
  }

  // ---- 基础工具 ----
  sendToClient(clientId, payload) {
    if (clientId === this.controllerId) {
      // 内置控制端：无独立连接，事件已由内部逻辑处理
      return true;
    }
    const c = this.connections.get(clientId);
    if (!c || c.ws.readyState !== WebSocket.OPEN) return false;
    return this.send(c.ws, payload);
  }

  sendError(ws, clientId, targetId, code) {
    this.send(ws, { type: 'error', clientId, targetId, message: code });
  }

  send(ws, payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try { ws.send(JSON.stringify(payload)); return true; } catch { return false; }
  }
}

module.exports = DglabV3Server;
