import { translations } from './translations.js';

const shellLabels = {
  'Groovebox · 云端唱片室': 'Groovebox · Cloud Music',
  'Groovebox 网盘音乐播放器': 'Groovebox cloud music player',
  '云端唱片室': 'Cloud Music',
  '主导航': 'Main navigation',
  '音乐': 'Music',
  '发现': 'Discover',
  '全部歌曲': 'All Tracks',
  '专辑': 'Albums',
  '艺人': 'Artists',
  '分类': 'Genres',
  '我的音乐': 'My Music',
  '我喜欢的': 'Favorites',
  '最近播放': 'Recently Played',
  '已下载音乐': 'Downloaded Music',
  '歌单': 'Playlists',
  '新建歌单': 'New Playlist',
  '导入 M3U 歌单': 'Import M3U Playlist',
  '音乐来源': 'Music Sources',
  '设置': 'Settings',
  '菜单': 'Menu',
  '后退': 'Back',
  '前进': 'Forward',
  '回到顶部': 'Back to Top',
  '搜索歌曲、艺人、专辑、文件夹、风格…': 'Search tracks, artists, albums, folders, and genres…',
  '搜索': 'Search',
  '连接网盘': 'Connect Cloud Drive',
  '正在播放': 'Now Playing',
  '音乐播放器': 'Music Player',
  '沉浸播放': 'Immersive Player',
  '选择一首歌曲': 'Choose a track',
  '定位当前歌曲': 'Locate current track',
  '收藏': 'Favorite',
  '随机播放': 'Shuffle',
  '上一首': 'Previous Track',
  '播放': 'Play',
  '下一首': 'Next Track',
  '循环播放': 'Repeat',
  '播放进度': 'Playback Progress',
  '静音': 'Mute',
  '音量': 'Volume',
  '投屏': 'Cast',
  '播放队列': 'Queue',
};

export const languageNames = Object.freeze({ 'zh-CN': '简体中文', en: 'English', ja: '日本語', ko: '한국어' });
export const normalizeLanguage = value =>
  typeof value === 'string' && Object.hasOwn(languageNames, value) ? value : 'zh-CN';

let language = 'zh-CN';
export const getLanguage = () => language;
const translationIndex = { ja: 0, ko: 1 };

export function t(chinese, english, values) {
  const localized = Object.hasOwn(translations, english) ? translations[english][translationIndex[language]] : undefined;
  const message = language === 'zh-CN' ? chinese : (localized ?? english ?? chinese);
  return values ? message.replace(/\{(\w+)\}/g, (placeholder, key) =>
    Object.hasOwn(values, key) ? String(values[key] ?? '') : placeholder) : message;
}

export class InterfaceError extends Error {
  constructor(...translation) {
    super(t(...translation));
    this.translation = translation;
  }
}

// Remember authored shell labels before music data or user input is rendered.
export function initializeShellLanguage(document) {
  const fields = [];
  const text = document.createTreeWalker(document.documentElement, 4);
  while (text.nextNode()) {
    const node = text.currentNode;
    const original = node.nodeValue;
    const label = original.trim();
    if (Object.hasOwn(shellLabels, label)) {
      fields.push(() => { node.nodeValue = original.replace(label, t(label, shellLabels[label])); });
    }
  }
  for (const element of document.querySelectorAll('[aria-label],[title],[placeholder],meta[name="description"]')) {
    for (const attribute of ['aria-label', 'title', 'placeholder', 'content']) {
      const original = element.getAttribute(attribute);
      if (Object.hasOwn(shellLabels, original)) fields.push(() => element.setAttribute(attribute, t(original, shellLabels[original])));
    }
  }
  return value => {
    language = normalizeLanguage(value);
    document.documentElement.lang = language;
    fields.forEach(update => update());
  };
}

export function displayError(error, fallback = t('操作失败，请重试。', 'Something went wrong. Please try again.')) {
  if (error instanceof InterfaceError) return t(...error.translation);
  const message = typeof error === 'string' ? error : error?.message;
  if (!message) return fallback;
  if (language === 'zh-CN') return message;
  const known = {
    '百度设备授权已过期，请重新开始。': 'The Baidu device code expired. Start authorization again.',
    '百度设备授权已过期或不匹配。请重新获取设备码。': 'This device code has expired or no longer matches. Request a new code.',
    '百度设备授权已取消，请重新开始。': 'Baidu authorization was canceled. Start authorization again.',
    '百度拒绝了应用的设备授权，请检查应用配置和网盘权限。': 'Baidu rejected device authorization. Check the app configuration and Netdisk permissions.',
    '百度拒绝了应用凭据。请在更改应用配置中核对同一百度应用的 AppKey 和当前 SecretKey。': 'Baidu rejected the app credentials. Check the App Key and current Secret Key for the same app.',
    '百度拒绝了这次授权码。请重新打开百度授权页面，同意授权后立即粘贴页面显示的新授权码。': 'Baidu rejected this authorization code. Authorize again and paste the new code immediately.',
    '该百度应用没有获准使用此授权方式。请在百度开放平台检查应用状态和网盘接口权限。': 'This Baidu app cannot use this authorization method. Check its status and Netdisk API permissions.',
    '该百度应用可能缺少网盘授权权限。请在百度开放平台检查应用的网盘接口权限。': 'The Baidu app may lack Netdisk permissions. Check its API access in the developer console.',
    '媒体服务器拒绝访问，请检查凭据': 'The media server denied access. Check your credentials.',
  };
  if (Object.hasOwn(known, message)) return t(message, known[message]);
  const withoutNames = message.replace(/“[^”]*”|「[^」]*」/g, '');
  return /\p{Script=Han}/u.test(withoutNames) ? fallback : message;
}
