export class FnMusicError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function prepareFnMusicSource({ url, username, password }) {
  const address = String(url ?? '').trim();
  const match = /^(https?):\/\/([^/?#]+)(\/[^?#]*)?$/i.exec(address);
  if (!match) throw new FnMusicError(400, '请输入音桥的 HTTP(S) 服务器地址，例如 http://nas:14040');
  let target;
  try {
    target = new URL(address);
  } catch {
    throw new FnMusicError(400, '音桥服务器地址无效');
  }
  if (target.username || target.password || target.search || target.hash ||
    /%(?:2f|5c|00)/i.test(target.pathname) || /[\\\x00-\x1f\x7f]/.test(address) ||
    /\/(?:music|rest)(?:\/|$)/i.test(target.pathname)) {
    throw new FnMusicError(400, '请填写音桥服务地址，省略 /music、/rest 和账号密码');
  }
  if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password) {
    throw new FnMusicError(400, '请输入已在音桥绑定的飞牛音乐独立账号和密码');
  }
  const authority = match[2];
  if (target.protocol === 'http:' && !/:\d+$/.test(authority) && target.pathname === '/') {
    target.port = '14040';
  }
  return { url: target.href, username, password };
}
