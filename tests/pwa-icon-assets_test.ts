import { assert, assertEquals } from "jsr:@std/assert@1.0.14";

const ICON_SIZE = 512;
const SAFE_ZONE_RADIUS = ICON_SIZE * 0.4;
const BACKGROUND = [0x17, 0x13, 0x1f, 0xff] as const;
const publicAsset = (name: string) => new URL(`../apps/web/public/${name}`, import.meta.url);

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function paeth(left: number, above: number, upperLeft: number): number {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance
    ? left
    : aboveDistance <= upperLeftDistance
    ? above
    : upperLeft;
}

async function pixels(name: string): Promise<Uint8Array> {
  const file = await Deno.readFile(publicAsset(name));
  assertEquals([...file.subarray(0, 8)], [...PNG_SIGNATURE], `${name} must be a PNG`);

  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const compressedParts: Uint8Array[] = [];
  let width = 0;
  let height = 0;
  let offset = 8;
  while (offset < file.length) {
    const length = view.getUint32(offset);
    const type = new TextDecoder().decode(file.subarray(offset + 4, offset + 8));
    const data = file.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
      height = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(4);
      assertEquals([...data.subarray(8, 13)], [8, 6, 0, 0, 0], `${name} must be RGBA8`);
    } else if (type === "IDAT") {
      compressedParts.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += length + 12;
  }
  assertEquals(width, ICON_SIZE, `${name} must be ${ICON_SIZE}px wide`);
  assertEquals(height, ICON_SIZE, `${name} must be ${ICON_SIZE}px high`);
  assert(compressedParts.length > 0, `${name} must contain image data`);

  const compressedLength = compressedParts.reduce((sum, part) => sum + part.length, 0);
  const compressed = new Uint8Array(compressedLength);
  let compressedOffset = 0;
  for (const part of compressedParts) {
    compressed.set(part, compressedOffset);
    compressedOffset += part.length;
  }
  const inflated = new Uint8Array(
    await new Response(
      new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate")),
    ).arrayBuffer(),
  );
  const stride = width * 4;
  assertEquals(inflated.length, height * (stride + 1), `${name} has unexpected pixel data`);
  const decoded = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sourceRow = y * (stride + 1);
    const filter = inflated[sourceRow];
    assert(filter <= 4, `${name} uses an invalid PNG filter`);
    for (let x = 0; x < stride; x++) {
      const raw = inflated[sourceRow + 1 + x];
      const target = y * stride + x;
      const left = x >= 4 ? decoded[target - 4] : 0;
      const above = y > 0 ? decoded[target - stride] : 0;
      const upperLeft = y > 0 && x >= 4 ? decoded[target - stride - 4] : 0;
      const predictor = filter === 1
        ? left
        : filter === 2
        ? above
        : filter === 3
        ? Math.floor((left + above) / 2)
        : filter === 4
        ? paeth(left, above, upperLeft)
        : 0;
      decoded[target] = (raw + predictor) & 0xff;
    }
  }
  return decoded;
}

Deno.test("maskable PWA icon is opaque, distinct, and safe to crop", async () => {
  const [maskable, ordinary] = await Promise.all([
    pixels("icon-maskable-512.png"),
    pixels("icon-512.png"),
  ]);

  let foregroundPixels = 0;
  let differsFromOrdinary = false;
  const center = ICON_SIZE / 2;

  for (let offset = 0; offset < maskable.length; offset += 4) {
    const pixelIndex = offset / 4;
    const x = pixelIndex % ICON_SIZE;
    const y = Math.floor(pixelIndex / ICON_SIZE);
    const rgba = maskable.subarray(offset, offset + 4);

    assertEquals(rgba[3], 255, `maskable icon has transparency at ${x},${y}`);
    if (!differsFromOrdinary) {
      differsFromOrdinary = rgba.some((channel, channelIndex) =>
        channel !== ordinary[offset + channelIndex]
      );
    }

    const isBackground = rgba.every((channel, channelIndex) =>
      channel === BACKGROUND[channelIndex]
    );
    if (!isBackground) {
      foregroundPixels++;
      const distance = Math.hypot(x + 0.5 - center, y + 0.5 - center);
      assert(
        distance <= SAFE_ZONE_RADIUS,
        `branded content at ${x},${y} falls outside the maskable safe zone`,
      );
    }
  }

  assert(foregroundPixels > 10_000, "maskable icon must contain the branded mark");
  assert(differsFromOrdinary, "maskable and ordinary icons must not be identical");

  for (
    const [x, y] of [[0, 0], [ICON_SIZE - 1, 0], [0, ICON_SIZE - 1], [ICON_SIZE - 1, ICON_SIZE - 1]]
  ) {
    const offset = (y * ICON_SIZE + x) * 4;
    assertEquals(
      [...maskable.subarray(offset, offset + 4)],
      [...BACKGROUND],
      `maskable icon corner ${x},${y} must be full-bleed background`,
    );
  }
});
