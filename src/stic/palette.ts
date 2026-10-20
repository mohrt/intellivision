/** The STIC's 16 colours as RGB, as jzIntv shows them (matched by eye against a TV). */
export const PALETTE_RGB: readonly number[] = [
  0x000000, // 0 black
  0x002dff, // 1 blue
  0xff3d10, // 2 red
  0xc9cfab, // 3 tan
  0x386b3f, // 4 dark green
  0x00a756, // 5 green
  0xfaea50, // 6 yellow
  0xfffcff, // 7 white
  0xbdacc8, // 8 grey
  0x24b8ff, // 9 cyan
  0xffb41f, // 10 orange
  0x546e00, // 11 brown
  0xff4e57, // 12 pink
  0xa496ff, // 13 light blue
  0x75cc80, // 14 yellow-green
  0xb51a58, // 15 purple
];

/** The palette as canvas pixels (little-endian ABGR). */
export const PALETTE: Uint32Array = Uint32Array.from(PALETTE_RGB, (rgb) => {
  const r = (rgb >> 16) & 0xff;
  const g = (rgb >> 8) & 0xff;
  const b = rgb & 0xff;
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
});
