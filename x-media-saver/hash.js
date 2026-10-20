import { sha256 } from "./vendor/noble-hashes/sha2.js";

// Stream large videos through SHA-256 without allocating a whole-file ArrayBuffer.
export async function hashBlob(blob) {
  const hash = sha256.create();
  const reader = blob.stream().getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
    }
    return Array.from(hash.digest(), byte => byte.toString(16).padStart(2, "0")).join("");
  } finally {
    reader.releaseLock();
    hash.destroy();
  }
}
