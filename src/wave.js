// 郊狼 V3 波形帧工具（参考 coyote/v3/README.md 与 coyote/README.md）
// 每个帧 = 16 位十六进制 = 4 字节波形频率 + 4 字节波形强度，代表 100ms 输出

function clamp(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function hexByte(v) {
  return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0').toUpperCase();
}

// 波形频率 ms (10~1000) → V3 协议值 (10~240)
function msToV3(ms) {
  ms = clamp(ms, 10, 1000);
  if (ms <= 100) return ms;
  if (ms <= 600) return (ms - 100) / 5 + 100;
  return (ms - 600) / 10 + 200;
}

// 默认脉冲包络（8 帧 = 0.8s 一个循环，中继会循环补齐到设定时长）
const ENVELOPE = [1, 0.7, 0.4, 0.25, 0.15, 0.25, 0.4, 0.7];

// 自定义波形解析，返回 16 位 hex 帧数组；未设置或格式无效返回 null。
// 支持两种写法（可混用，逗号/空格/分号分隔，每个 token 代表 100ms 一帧）：
//   1) "频率ms:波形强度" 对：100:60, 50:40, 30:20
//   2) 直接 16 位十六进制帧：646464643C3C3C3C, 3232323228282828
function parseCustomWave(text) {
  if (text === undefined || text === null) return null;
  const str = String(text).replace(/^\uFEFF/, '').trim();
  if (!str) return null;
  const tokens = str.split(/[\s,，;；]+/).filter(Boolean);
  const frames = [];
  for (const tok of tokens) {
    if (/^[0-9a-fA-F]{16}$/.test(tok)) {
      frames.push(tok.toUpperCase());
      continue;
    }
    const m = tok.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    if (!m) return null;
    const freqMs = Number(m[1]);
    const wave = Number(m[2]);
    if (freqMs < 10 || freqMs > 1000 || wave < 0 || wave > 100) return null;
    frames.push(hexByte(msToV3(freqMs)).repeat(4) + hexByte(wave).repeat(4));
  }
  return frames.length ? frames : null;
}

// 档位是否配置了「有效」的自定义波形
function hasCustomWave(gear) {
  const g = gear || {};
  if (!g.customWave || !String(g.customWave).trim()) return false;
  return !!parseCustomWave(g.customWave);
}

// 按档位生成一组循环波形帧；配置了自定义波形时优先使用
function buildFrames(gear) {
  const custom = parseCustomWave(gear && gear.customWave);
  if (custom && custom.length) return custom;
  const f = hexByte(msToV3(gear.freqMs));
  return ENVELOPE.map((m) => f.repeat(4) + hexByte(clamp(gear.waveStrength * m, 0, 100)).repeat(4));
}

module.exports = { clamp, hexByte, msToV3, buildFrames, parseCustomWave, hasCustomWave, ENVELOPE };
