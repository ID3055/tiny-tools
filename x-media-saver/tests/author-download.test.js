import test from "node:test";
import assert from "node:assert/strict";
import "../core.js";
import "../author-download.js";
const { profile, run } = globalThis.XImageSaverAuthor;
const photo = (author, postId, ...names) => ({ author, postId, images: names.map(name => `https://pbs.twimg.com/media/${name}?format=jpg&name=small`) });
function setup(overrides = {}) {
  let time = 0;
  const controller = new AbortController(), calls = [], updates = [];
  return { controller, calls, updates, options: {
    author: "artist", signal: controller.signal, current: () => true,
    posts: () => [], advance: () => "bottom", now: () => time, stallMs: 3000,
    wait: async () => { time += 1000; }, update: state => updates.push(state),
    save: async post => { calls.push(post); return { complete: post.images.length, skipped: 0, failed: 0 }; },
    ...overrides
  } };
}
test("recognizes only author home/media routes", () => {
  assert.deepEqual(profile("/Artist_1/media"), { author: "Artist_1", media: true });
  assert.deepEqual(profile("/Artist_1/"), { author: "Artist_1", media: false });
  for (const path of ["/home", "/i/media", "/search", "/artist/status/123", "/artist/likes", "/"]) assert.equal(profile(path), null);
});
test("collects all photos, excludes other authors and deduplicates recycled posts", async () => {
  const task = setup({ posts: () => [photo("ARTIST", "1", "One", "Two"), photo("other", "2", "Other"), photo("artist", "3", "One"), photo("artist", "4", "Four")] });
  assert.deepEqual(await run(task.options), { found: 3, saved: 3, skipped: 0, failed: 0 });
  assert.equal(task.calls.length, 2);
  assert.ok(task.calls.every(post => post.images.every(url => url.includes("name=orig")) && post.videos.length === 0));
  assert.equal(task.updates.at(-1).phase, "stalled");
});
test("continues through video-only pages while scrolling makes progress", async () => {
  let page = 0;
  const task = setup({ posts: () => page >= 8 ? [photo("artist", "8", "OldPhoto")] : [], advance: () => String(Math.min(page++, 9)) });
  await run(task.options);
  assert.equal(task.calls.length, 1);
  assert.equal(task.calls[0].postId, "8");
});
test("stopping waits for the current post and starts no further downloads", async () => {
  const task = setup({ posts: () => [photo("artist", "1", "One"), photo("artist", "2", "Two")] });
  task.options.save = async post => { task.calls.push(post); task.controller.abort(); return { complete: 0, skipped: 1, failed: 0 }; };
  assert.deepEqual(await run(task.options), { found: 1, saved: 0, skipped: 1, failed: 0 });
  assert.equal(task.calls.length, 1);
  assert.equal(task.updates.at(-1).phase, "stopped");
});
test("changing author stops before another post can be downloaded", async () => {
  let current = true;
  const task = setup({ current: () => current, posts: () => [photo("artist", "1", "One"), photo("artist", "2", "Two")] });
  task.options.save = async post => { task.calls.push(post); current = false; return { complete: 1, skipped: 0, failed: 0 }; };
  await run(task.options);
  assert.equal(task.calls.length, 1);
  assert.equal(task.updates.at(-1).phase, "navigated");
});
test("counts download failures and ignores unsafe URLs", async () => {
  const task = setup({ posts: () => [{ author: "artist", postId: "1", images: ["https://evil.com/a.jpg", "https://pbs.twimg.com/media/Good.jpg"] }], save: async () => ({ complete: 0, skipped: 0, failed: 1 }) });
  assert.deepEqual(await run(task.options), { found: 1, saved: 0, skipped: 0, failed: 1 });
});
