const catalog = [
  ['After Hours', 'Velvet Atlas', 'Midnight Tape', 164],
  ['Blue Static', 'Nova Lane', 'Blue Static', 148],
  ['Soft Signal', 'Mira Kos', 'Still Life', 168],
  ['Paper Planes', 'Orion Park', 'Daydream Radio', 145],
  ['Golden Haze', 'Luna Harbor', 'Golden Haze', 156],
  ['Slow Motion', 'Velvet Atlas', 'Midnight Tape', 162],
  ['Nocturne', 'Fern & Fields', 'Night Studies', 171],
  ['Last Light', 'Mira Kos', 'Still Life', 153],
];

export const demoTracks = catalog.map(([title, artist, album, duration], index) => ({
  id: `demo-${index + 1}`,
  title,
  artist,
  album,
  duration,
  src: `/assets/demo-${index + 1}.m4a`,
  cover: `/assets/cover-${index + 1}.jpg`,
  provider: 'demo',
}));
