const crypto = require('crypto');

// 密码哈希：scrypt 加盐存储，格式 scrypt:<saltHex>:<hashHex>
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hashHex] = parts;
  try {
    const hash = crypto.scryptSync(String(password), salt, 64);
    const expect = Buffer.from(hashHex, 'hex');
    return hash.length === expect.length && crypto.timingSafeEqual(hash, expect);
  } catch {
    return false;
  }
}

// Cap 人机验证服务端校验（Cap Standalone /siteverify，reCAPTCHA 兼容契约）。
// 规则：缺令牌、无效令牌、服务不可达、配置缺失 → 一律失败（fail-closed）。
async function verifyCapToken(sec, token) {
  const secret = process.env.CAP_SECRET_KEY || (sec && sec.capSecret) || '';
  const siteKey = (sec && sec.capSiteKey || '').trim();
  const serverUrl = (sec && sec.capServerUrl || '').replace(/\/+$/, '');
  if (!siteKey || !serverUrl) return { ok: false, error: '人机验证服务未配置' };
  if (!secret) return { ok: false, error: '人机验证密钥未配置（设置中填写或设置 CAP_SECRET_KEY 环境变量）' };
  if (!token || typeof token !== 'string' || !token.trim()) return { ok: false, error: '缺少人机验证令牌' };

  let res;
  try {
    res = await fetch(`${serverUrl}/${siteKey}/siteverify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, response: token.trim() }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return { ok: false, error: '人机验证服务不可达，请稍后再试' };
  }
  let data = null;
  try { data = await res.json(); } catch {}
  if (res.ok && data && data.success === true) return { ok: true };
  const detail = data && data.error ? ` (${data.error})` : '';
  return { ok: false, error: `人机验证失败${detail}` };
}

module.exports = { hashPassword, verifyPassword, verifyCapToken };
