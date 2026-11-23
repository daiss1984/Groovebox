const black = [0, 0, 0];
const white = [255, 255, 255];

function luminance(rgb) {
  const [red, green, blue] = rgb.map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function contrast(first, second) {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function coverColor(pixels) {
  const colors = new Map();
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3] < 128) continue;
    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    const key = (red >> 5) * 64 + (green >> 5) * 8 + (blue >> 5);
    const bucket = colors.get(key) || { channels: [0, 0, 0], count: 0, weight: 0 };
    bucket.channels[0] += red;
    bucket.channels[1] += green;
    bucket.channels[2] += blue;
    bucket.count += 1;
    bucket.weight += 1 + (Math.max(red, green, blue) - Math.min(red, green, blue)) / 100;
    colors.set(key, bucket);
  }
  let dominant;
  for (const bucket of colors.values()) {
    if (!dominant || bucket.weight > dominant.weight) dominant = bucket;
  }
  return dominant?.channels.map(channel => Math.round(channel / dominant.count));
}

export function playButtonColors(cover, panel) {
  const surface = panel.match(/^#[a-f0-9]{6}$/i) ? panel.slice(1).match(/../g).map(channel => parseInt(channel, 16)) : black;
  const mixWith = luminance(surface) > 0.5 ? black : white;
  let background = cover;
  for (let blend = 1; contrast(background, surface) < 3.5 && blend <= 10; blend++) {
    background = cover.map((channel, index) => Math.round((channel * (10 - blend) + mixWith[index] * blend) / 10));
  }
  const text = contrast(background, black) > contrast(background, white) ? 'black' : 'white';
  return { background: `rgb(${background.join(', ')})`, text };
}
