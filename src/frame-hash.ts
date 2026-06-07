export function hashFrameBuffer(buffer: Uint32Array | undefined): string {
  if (!buffer || buffer.length === 0) {
    return "no-frame";
  }

  let hash = 0x811c9dc5;
  const stride = Math.max(1, Math.floor(buffer.length / 1024));

  for (let index = 0; index < buffer.length; index += stride) {
    hash ^= buffer[index] ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}
