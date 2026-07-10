declare module "imagescript/wasm/node/png.js" {
  interface Decoder {
    decode(data: Uint8Array): { width: number; height: number; framebuffer: Uint8Array };
  }
  const codec: { init(): Promise<Decoder> };
  export default codec;
}

declare module "imagescript/wasm/node/jpeg.js" {
  interface Decoder {
    load(data: Uint8Array): { width: number; height: number; buffer: Uint8Array };
  }
  const codec: { init(): Promise<Decoder> };
  export default codec;
}
