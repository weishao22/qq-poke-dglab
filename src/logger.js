const lines = [];
const MAX_LINES = 500;
const subscribers = new Set();

function fmt(v) {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.message;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function log(level, ...args) {
  const time = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `[${time}] [${level.toUpperCase()}] ${args.map(fmt).join(' ')}`;
  lines.push(line);
  if (lines.length > MAX_LINES) lines.shift();
  for (const cb of subscribers) { try { cb(line); } catch {} }
  const fn = console[level] || console.log;
  fn(line);
}

// 订阅新日志行，返回取消函数
function subscribe(cb) {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

module.exports = {
  log,
  info: (...a) => log('info', ...a),
  warn: (...a) => log('warn', ...a),
  error: (...a) => log('error', ...a),
  tail: (n) => lines.slice(-(n || MAX_LINES)),
  all: () => [...lines],
  subscribe,
};
