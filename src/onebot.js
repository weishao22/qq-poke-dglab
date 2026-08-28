const { EventEmitter } = require('events');
const { WebSocket } = require('ws');

const LOGIN_ECHO = 'kilo_get_login';
const RECONNECT_MS = 5000;

// OneBot V11 正向 WebSocket 客户端（连接 / 通用端点，一条连接同时收事件、发 API）
// 参考 onebot-11/communication/ws.md 与 qq-bridge 的 OneBotWebSocket 实现
class OneBotClient extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.url = '';
    this.token = '';
    this.connected = false;
    this.selfId = 0;
    this.reconnectTimer = null;
    this.closedByUser = false;
  }

  setConfig(url, token) {
    this.url = String(url || '');
    this.token = String(token || '');
  }

  isReady() {
    return this.connected;
  }

  start() {
    this.closedByUser = false;
    this.connect();
  }

  stop() {
    this.closedByUser = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) {
      // 先摘除旧连接的全部监听再关闭，防止重连瞬间旧连接缓冲的事件被重复派发
      const old = this.ws;
      old.removeAllListeners();
      try { old.close(); } catch {}
      this.ws = null;
    }
    this.connected = false;
  }

  restart() {
    this.stop();
    this.closedByUser = false;
    this.connect();
  }

  connect() {
    if (!this.url) return;
    const opts = this.token ? { headers: { Authorization: `Bearer ${this.token}` } } : {};
    let ws;
    try {
      ws = new WebSocket(this.url, opts);
    } catch (e) {
      this.emit('error', `连接 OneBot 失败: ${e.message}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.emit('connected');
      this.sendApi('get_login_info', {}, LOGIN_ECHO);
    });

    ws.on('message', (raw) => {
      let data;
      try { data = JSON.parse(raw.toString()); } catch { return; }
      if (data && data.post_type) {
        this.emit('event', data);
        return;
      }
      if (data && data.echo === LOGIN_ECHO && data.status === 'ok' && data.data && data.data.user_id) {
        this.selfId = Number(data.data.user_id);
        this.emit('ready', this.selfId);
      }
    });

    ws.on('close', () => {
      if (this.connected) {
        this.connected = false;
        this.emit('disconnected');
      }
      this.scheduleReconnect();
    });

    ws.on('error', (e) => {
      if (!this.closedByUser) this.emit('error', e && e.message ? e.message : 'OneBot WebSocket 错误');
    });
  }

  scheduleReconnect() {
    if (this.closedByUser || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_MS);
  }

  sendApi(action, params, echo) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(JSON.stringify({ action, params: params || {}, echo }));
      return true;
    } catch {
      return false;
    }
  }

  sendGroupMessage(groupId, text) {
    return this.sendApi('send_group_msg', {
      group_id: groupId,
      message: [{ type: 'text', data: { text: String(text) } }],
    });
  }
}

module.exports = OneBotClient;
