export const streamBitrates = [0, 64, 96, 128, 192, 256, 320];

export function supportsStreamBitrate(provider) {
  return ['navidrome', 'subsonic', 'opensubsonic'].includes(provider);
}

export function normalizeStreamBitrates(value) {
  return {
    network: ['wifi', 'cellular'].includes(value?.network) ? value.network : 'auto',
    wifi: streamBitrates.includes(value?.wifi) ? value.wifi : 0,
    cellular: streamBitrates.includes(value?.cellular) ? value.cellular : 0,
  };
}

export function preferredStreamBitrate(settings, connection) {
  if (settings.network !== 'auto') return settings[settings.network];
  if (connection?.type === 'cellular') return settings.cellular;
  if (connection?.type === 'wifi' || connection?.type === 'ethernet') return settings.wifi;
  return 0;
}
