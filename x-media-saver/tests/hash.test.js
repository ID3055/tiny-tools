import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { hashBlob } from "../hash.js";

test("streaming SHA-256 matches the standard abc and empty-file vectors", async () => {
  assert.equal(await hashBlob(new Blob(["abc"])), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(await hashBlob(new Blob([])), createHash("sha256").digest("hex"));
});

test("streamed multi-chunk binary files match Node's native SHA-256", async () => {
  const chunk = Uint8Array.from({ length: 131071 }, (_, i) => i % 251);
  const chunks = Array(20).fill(chunk);
  const expected = createHash("sha256");
  for (const part of chunks) expected.update(part);
  assert.equal(await hashBlob(new Blob(chunks)), expected.digest("hex"));
});
