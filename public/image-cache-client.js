export const imageCacheBudget = Object.freeze({ defaultMiB: 250, minMiB: 50, maxMiB: 2048 });

export class ImageCacheError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ImageCacheError';
    this.code = code;
  }
}

function requestImageCache(action, data) {
  const worker = globalThis.navigator?.serviceWorker?.controller;
  if (!worker || typeof MessageChannel === 'undefined') return Promise.reject(new ImageCacheError('unsupported'));
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    function complete(error, value) {
      clearTimeout(timer);
      channel.port1.close();
      if (error) reject(new ImageCacheError(error));
      else resolve(value);
    }
    const timer = setTimeout(() => complete('timeout'), 10000);
    channel.port1.onmessage = ({ data: reply }) => {
      if (reply?.ok === true && reply.value) complete(undefined, reply.value);
      else complete(reply?.code === 'invalid_budget' ? 'invalid_budget' : 'storage_unavailable');
    };
    channel.port1.onmessageerror = () => complete('storage_unavailable');
    try {
      worker.postMessage({ action, ...data }, [channel.port2]);
    } catch {
      channel.port2.close();
      complete('storage_unavailable');
    }
  });
}

export function readImageCachePolicy() {
  return requestImageCache('artwork-cache-policy');
}

export function configureImageCache({ limitMiB } = {}) {
  if (!Number.isInteger(limitMiB) || limitMiB < imageCacheBudget.minMiB || limitMiB > imageCacheBudget.maxMiB) {
    return Promise.reject(new ImageCacheError('invalid_budget'));
  }
  return requestImageCache('artwork-cache-configure', { limitMiB });
}

export function clearImageCache() {
  return requestImageCache('artwork-cache-clear');
}

export function resumeImageCache() {
  return requestImageCache('artwork-cache-resume');
}
