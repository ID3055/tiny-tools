import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
if (!globalThis.crypto) globalThis.crypto = webcrypto;

let listener, changed, requests, prepared, local, session, records, bytes, failures, nextId, state, releases;
const extensionId = "test-extension";
function storage(getStore) {
  return {
    async get(keys) {
      const store = getStore();
      const names = Array.isArray(keys) ? keys : [keys];
      return structuredClone(Object.fromEntries(names.filter(key => key in store).map(key => [key, store[key]])));
    },
    async set(values) { Object.assign(getStore(), structuredClone(values)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete getStore()[key]; }
  };
}
globalThis.chrome = {
  runtime: {
    id: extensionId,
    getURL: path => `chrome-extension://${extensionId}/${path}`,
    onMessage: { addListener(callback) { listener = callback; } },
    async getContexts() { return [{ contextType: "OFFSCREEN_DOCUMENT" }]; },
    async sendMessage(message) {
      if (message.type === "XIS_PREPARE_MEDIA") {
        prepared.push(message.url);
        if (failures.has(message.url)) return { ok: false, error: "NETWORK_FAILED" };
        const hash = createHash("sha256").update(bytes.get(message.url) || message.url).digest("hex");
        return { ok: true, hash, blobUrl: `blob:chrome-extension://${extensionId}/${hash}` };
      }
      releases.push(message);
      return { ok: true };
    }
  },
  offscreen: { async createDocument() {} },
  storage: { local: storage(() => local), session: storage(() => session) },
  downloads: {
    onChanged: { addListener(callback) { changed = callback; } },
    async download(options) {
      requests.push(options);
      const id = nextId++;
      records[id] = { id, state, exists: true, filename: `/Downloads/${options.filename}`, url: options.url, byExtensionId: extensionId };
      return id;
    },
    async search(query) {
      if (query.id !== undefined) return records[query.id] ? [structuredClone(records[query.id])] : [];
      return Object.values(records).filter(item => new RegExp(query.urlRegex).test(item.url)).map(item => structuredClone(item));
    }
  }
};
await import("../background.js");
const sender = { url: "https://x.com/home", tab: { id: 7 } };
const one = "https://pbs.twimg.com/media/One?format=jpg&name=orig";
const two = "https://pbs.twimg.com/media/Two?format=png&name=orig";
const post = { author: "artist", postId: "123456", images: [one, two] };
const message = (data, source = sender) => new Promise(resolve => listener(data, source, resolve));
const tick = () => new Promise(resolve => setImmediate(resolve));
async function finish(started, source = sender) {
  assert.equal(started.ok, true);
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await message({ type: "XIS_JOB_STATUS", jobId: started.jobId }, source);
    assert.equal(result.ok, true, result.error);
    if (!result.pending) return result;
    await tick();
  }
  throw new Error("job did not finish");
}
const save = (value = post, force = false) => message({ type: "XIS_DOWNLOAD_POST", post: value, force }).then(finish);
beforeEach(() => { requests = []; prepared = []; releases = []; local = {}; session = {}; records = {}; bytes = new Map(); failures = new Set(); nextId = 1; state = "complete"; });

test("saves checked bytes once, under the configured author/media directories", async () => {
  local.rootFolder = "X收藏";
  const result = await save();
  assert.equal(result.complete, 2);
  assert.equal(result.skipped, 0);
  assert.equal(requests[0].filename, "X收藏/artist/图片/123456_1.jpg");
  assert.ok(requests.every(item => item.url.startsWith("blob:chrome-extension://")));
  assert.equal(prepared.length, 2);
  assert.ok(Object.keys(local).some(key => key.startsWith("xis:sha256:")));
});

test("same URL skips existing files without reading or hashing them again", async () => {
  await save();
  const result = await save();
  assert.equal(result.skipped, 2);
  assert.equal(result.complete, 0);
  assert.equal(prepared.length, 2);
  assert.equal(requests.length, 2);
});

test("identical bytes under different URLs and post filenames are skipped", async () => {
  bytes.set(one, "identical image"); bytes.set(two, "identical image");
  const result = await save();
  assert.equal(result.complete, 1);
  assert.equal(result.skipped, 1);
  assert.equal(prepared.length, 2);
  assert.equal(requests.length, 1);
  assert.ok(releases.some(item => item.type === "XIS_RELEASE_BLOB"));
});

test("same filenames with different bytes are kept rather than falsely skipped", async () => {
  await save({ ...post, images: [one] });
  const result = await save({ ...post, images: [two] });
  assert.equal(result.complete, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].conflictAction, "uniquify");
});

test("successful history survives deleted files and cleared native download history", async () => {
  await save();
  records[1].exists = false;
  delete records[2];
  const result = await save();
  assert.equal(result.skipped, 2);
  assert.equal(requests.length, 2);
  assert.equal(prepared.length, 2);
  const status = await message({ type: "XIS_POST_STATUS", post });
  assert.equal(status.saved, 2);
  assert.equal(status.total, 2);
  assert.ok(Object.values(local).filter(value => value.completedAt).every(value => value.completedAt > 0));
});

test("deleted content stays skipped even at a new URL", async () => {
  bytes.set(one, "same bytes"); bytes.set(two, "same bytes");
  await save({ ...post, images: [one] });
  records[1].exists = false;
  const result = await save({ ...post, images: [two] });
  assert.equal(result.skipped, 1);
  assert.equal(requests.length, 1);
});

test("Shift force bypasses URL and content history but collapses duplicates within the post", async () => {
  bytes.set(one, "same bytes"); bytes.set(two, "same bytes");
  await save();
  delete records[1];
  const result = await save(post, true);
  assert.equal(result.complete, 1);
  assert.equal(result.skipped, 1);
  assert.equal(requests.length, 2);
  assert.equal(prepared.length, 4);
  const again = await save();
  assert.equal(again.skipped, 2);
  assert.equal(prepared.length, 4);
});

test("failed forced replacement preserves the previous successful history", async () => {
  const value = { ...post, images: [one] };
  await save(value);
  state = "interrupted";
  const forced = await save(value, true);
  assert.equal(forced.failed, 1);
  delete records[1];
  const result = await save(value);
  assert.equal(result.skipped, 1);
  assert.equal(requests.length, 2);
});

test("interrupted attempts remain retryable and never become successful history", async () => {
  state = "interrupted";
  const value = { ...post, images: [one] };
  assert.equal((await save(value)).failed, 1);
  assert.equal((await message({ type: "XIS_POST_STATUS", post: value })).saved, 0);
  state = "complete";
  assert.equal((await save(value)).complete, 1);
  assert.equal(requests.length, 2);
});

test("pending downloads become durable only after the browser reports completion", async () => {
  state = "in_progress";
  const value = { ...post, images: [one] };
  const started = await message({ type: "XIS_DOWNLOAD_POST", post: value });
  for (let i = 0; i < 20; i++) await tick();
  assert.equal((await message({ type: "XIS_POST_STATUS", post: value })).saved, 0);
  assert.ok(!Object.values(local).some(value => value.completedAt));
  records[1].state = "complete";
  changed({ id: 1, state: { current: "complete" } });
  await finish(started);
  delete records[1];
  assert.equal((await save(value)).skipped, 1);
});

test("pending aliases are all promoted after completion", async () => {
  state = "in_progress";
  bytes.set(one, "same bytes"); bytes.set(two, "same bytes");
  const started = await message({ type: "XIS_DOWNLOAD_POST", post });
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(requests.length, 1);
  records[1].state = "complete";
  changed({ id: 1, state: { current: "complete" } });
  await finish(started);
  delete records[1];
  assert.equal((await save()).skipped, 2);
  assert.equal(prepared.length, 2);
});

test("old complete records migrate even when the file has been deleted", async () => {
  const key = `xis:url:${JSON.stringify(["artist/图片", "One", "jpg"])}`;
  local[key] = { id: 90 };
  records[90] = { id: 90, state: "complete", exists: false, filename: "/Downloads/artist/图片/old.jpg" };
  assert.equal((await save({ ...post, images: [one] })).skipped, 1);
  delete records[90];
  assert.equal((await save({ ...post, images: [one] })).skipped, 1);
  assert.equal(prepared.length, 0);
});

test("missing unconfirmed old attempts remain retryable", async () => {
  local[`xis:url:${JSON.stringify(["artist/图片", "One", "jpg"])}`] = { id: 90 };
  assert.equal((await save({ ...post, images: [one] })).complete, 1);
});

test("deduplication preserves separate author and configured root directories", async () => {
  await save({ ...post, images: [one] });
  await save({ ...post, author: "another", images: [one] });
  local.rootFolder = "new-root";
  const result = await save({ ...post, images: [one] });
  assert.equal(result.complete, 1);
  assert.equal(requests.length, 3);
});

test("two tabs requesting the same URL or content concurrently create one file", async () => {
  bytes.set(one, "same"); bytes.set(two, "same");
  const first = await message({ type: "XIS_DOWNLOAD_POST", post: { ...post, images: [one] } });
  const second = await message({ type: "XIS_DOWNLOAD_POST", post: { ...post, images: [two] } }, { ...sender, tab: { id: 8 } });
  const results = await Promise.all([finish(first), finish(second, { ...sender, tab: { id: 8 } })]);
  assert.equal(requests.length, 1);
  assert.equal(results.reduce((sum, item) => sum + item.skipped, 0), 1);
});

test("partially failed posts retry only files that were not saved", async () => {
  failures.add(two);
  const result = await save();
  assert.equal(result.complete, 1);
  assert.equal(result.failed, 1);
  assert.match(result.error, /NETWORK_FAILED/);
  failures.clear();
  const retry = await save();
  assert.equal(retry.complete, 1);
  assert.equal(retry.skipped, 1);
  assert.equal(requests.length, 2);
});

test("legacy original-image downloads are recognized without new network reads", async () => {
  records[90] = { id: 90, state: "complete", exists: true, filename: "/Downloads/artist/old_1.jpg", url: one, byExtensionId: extensionId };
  const result = await save({ ...post, images: [one] });
  assert.equal(result.skipped, 1);
  assert.equal(requests.length, 0);
  assert.equal(prepared.length, 0);
});

test("does not mistake a thumbnail or another directory for an existing original", async () => {
  records[90] = { id: 90, state: "complete", exists: true, filename: "/Downloads/artist/old_1.jpg", url: one.replace("orig", "small"), byExtensionId: extensionId };
  const result = await save({ ...post, images: [one] });
  assert.equal(result.complete, 1);
});

test("videos are hashed and stored separately from images", async () => {
  const video = "https://video.twimg.com/ext_tw_video/123/pu/vid/avc1/720x1280/a.mp4?tag=1";
  const result = await save({ ...post, videos: [video] });
  assert.equal(result.complete, 3);
  assert.equal(requests[2].filename, "artist/视频/123456_1.mp4");
});

test("download interruption is reported and blob resources are released", async () => {
  state = "interrupted";
  const result = await save({ ...post, images: [one] });
  assert.equal(result.failed, 1);
  changed({ id: 1, state: { current: "interrupted" } });
  assert.ok(releases.some(item => item.type === "XIS_RELEASE_DOWNLOAD" && item.id === 1));
});

test("untrusted sources and invalid batches cannot start downloads", async () => {
  for (const source of [{ url: "https://evil.com", tab: { id: 1 } }, { url: "https://x.com" }, {}]) assert.equal((await message({ type: "XIS_DOWNLOAD_POST", post }, source)).ok, false);
  assert.equal((await message({ type: "XIS_DOWNLOAD_POST", post: { ...post, images: [one, "https://evil.com/media/a.jpg"] } })).ok, false);
  assert.equal(prepared.length, 0);
  assert.equal(requests.length, 0);
});

test("unknown or cross-tab job queries are rejected", async () => {
  assert.equal((await message({ type: "XIS_JOB_STATUS", jobId: "bad" })).ok, false);
  const started = await message({ type: "XIS_DOWNLOAD_POST", post });
  assert.equal((await message({ type: "XIS_JOB_STATUS", jobId: started.jobId }, { ...sender, tab: { id: 999 } })).ok, false);
  await finish(started);
  assert.equal((await message({ type: "XIS_UNKNOWN" })).ok, false);
});
