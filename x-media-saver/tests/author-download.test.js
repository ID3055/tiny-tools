import test from "node:test";
import assert from "node:assert/strict";
import "../core.js";
import "../author-download.js";
const { profile, run, locate } = globalThis.XImageSaverAuthor;
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
  assert.deepEqual(await run(task.options), { posts: 2, found: 3, saved: 3, skipped: 0, failed: 0 });
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
  assert.deepEqual(await run(task.options), { posts: 1, found: 1, saved: 0, skipped: 1, failed: 0 });
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
  assert.deepEqual(await run(task.options), { posts: 1, found: 1, saved: 0, skipped: 0, failed: 1 });
});

test("failure reasons stay observable after later successful posts and stopping", async () => {
  const task = setup({ posts: () => [photo("artist", "1", "Bad"), photo("artist", "2", "Good")],
    save: async post => post.postId === "1" ? { complete: 0, skipped: 0, failed: 1, error: "NETWORK_TIMEOUT" } : { complete: 1, skipped: 0, failed: 0 } });
  assert.deepEqual(await run(task.options), { posts: 2, found: 2, saved: 1, skipped: 0, failed: 1 });
  assert.match(task.updates.at(-1).error, /帖子 1.*NETWORK_TIMEOUT/);
  assert.equal(task.updates.at(-1).post.postId, "2");
});

test("rate limiting preserves completed counts and stops before the next post", async () => {
  let saves = 0;
  const task = setup({ posts: () => [photo("artist", "1", "One", "Two"), photo("artist", "2", "Three")],
    save: async () => { saves++; return { complete: 1, skipped: 0, failed: 1, error: "媒体读取失败（HTTP 429）。" }; } });
  assert.deepEqual(await run(task.options), { posts: 1, found: 2, saved: 1, skipped: 0, failed: 1 });
  assert.equal(saves, 1);
  assert.equal(task.updates.at(-1).phase, "blocked");
  assert.match(task.updates.at(-1).error, /429/);
});

test("waiting for the next page reports elapsed time without claiming completion", async () => {
  const task = setup();
  await run(task.options);
  assert.ok(task.updates.some(state => state.phase === "waiting" && state.waitSeconds > 0 && state.limitSeconds === 3));
  assert.equal(task.updates.at(-1).phase, "stalled");
});

test("a multi-photo post is counted once when more metadata for it arrives", async () => {
  let expanded = false;
  const task = setup({ posts: () => [photo("artist", "1", ...expanded ? ["One", "Two", "Three"] : ["One"])], advance: () => { expanded = true; return "bottom"; } });
  assert.deepEqual(await run(task.options), { posts: 1, found: 3, saved: 3, skipped: 0, failed: 0 });
});

test("fast location checks hundreds of saved posts in batches and stops at the first unknown", async () => {
  const posts = Array.from({ length: 251 }, (_, index) => photo("artist", String(index + 1), `Image${index}`));
  const batches = [], confirmed = [], advances = [];
  const task = setup({ posts: () => posts,
    lookup: async batch => { batches.push(batch.length); return batch.map(post => ({ postId: post.postId, total: post.images.length, saved: post.postId === "251" ? 0 : post.images.length })); },
    confirmed: post => confirmed.push(...post.images), advance: () => advances.push(true)
  });
  assert.deepEqual(await locate(task.options), { posts: 251, checked: 251, skipped: 250 });
  assert.deepEqual(batches, [100, 100, 51]);
  assert.equal(advances.length, 0);
  assert.equal(task.calls.length, 0);
  assert.equal(task.updates.at(-1).phase, "located");
  assert.equal(task.updates.at(-1).target.postId, "251");
  const resume = setup({ posts: () => posts, skipImages: confirmed });
  resume.options.save = async post => { resume.calls.push(post); resume.controller.abort(); return { complete: 1, skipped: 0, failed: 0 }; };
  await run(resume.options);
  assert.equal(resume.calls.length, 1);
  assert.equal(resume.calls[0].postId, "251");
});

test("fast location stops at a partially saved multi-photo post", async () => {
  const task = setup({ posts: () => [photo("artist", "1", "One", "Two")], lookup: async () => [{ postId: "1", total: 2, saved: 1 }] });
  assert.deepEqual(await locate(task.options), { posts: 1, checked: 2, skipped: 1 });
  assert.equal(task.updates.at(-1).phase, "located");
  assert.equal(task.updates.at(-1).target.images.length, 2);
  assert.equal(task.updates.at(-1).targetSaved, 1);
});

test("switching from fast location preserves totals from the first download update", async () => {
  const post = photo("artist", "1", "One", "Two");
  const images = post.images.map(url => XImageSaverCore.originalImage(url).url);
  const task = setup({ posts: () => [post], initialProgress: { posts: 201, postIds: ["1"], found: 402, skipped: 400, postId: "1", images, savedInPost: 0 } });
  task.options.save = async () => { task.controller.abort(); return { complete: 2, skipped: 0, failed: 0 }; };
  assert.deepEqual(await run(task.options), { posts: 201, found: 402, saved: 2, skipped: 400, failed: 0 });
  assert.deepEqual(task.updates[0], { posts: 201, found: 402, saved: 0, skipped: 400, failed: 0, phase: "running" });
  assert.ok(task.updates.every(update => update.found >= 402 && update.skipped >= 400));
});

test("a partially saved boundary post is counted once across fast and normal modes", async () => {
  const post = photo("artist", "1", "One", "Two", "Three");
  const images = post.images.map(url => XImageSaverCore.originalImage(url).url);
  const task = setup({ posts: () => [post], initialProgress: { posts: 201, postIds: ["1"], found: 403, skipped: 401, postId: "1", images, savedInPost: 1 } });
  task.options.save = async () => { task.controller.abort(); return { complete: 1, skipped: 1, failed: 1 }; };
  assert.deepEqual(await run(task.options), { posts: 201, found: 403, saved: 1, skipped: 401, failed: 1 });
});

test("fast location waits for newly loaded metadata and ignores other authors and unsafe media", async () => {
  let page = 0;
  const task = setup({ posts: () => page > 2 ? [photo("other", "9", "Other"), { ...photo("artist", "1", "Valid"), images: ["https://evil.com/a.jpg", "https://pbs.twimg.com/media/Valid.jpg"] }] : [],
    advance: () => String(page++), lookup: async batch => batch.map(post => ({ postId: post.postId, total: post.images.length, saved: 0 })) });
  assert.deepEqual(await locate(task.options), { posts: 1, checked: 1, skipped: 0 });
  assert.equal(task.updates.at(-1).target.postId, "1");
});

test("stopping or navigating during a history query prevents further scrolling and locating", async () => {
  for (const action of ["stop", "navigate"]) {
    let current = true, advances = 0;
    const task = setup({ posts: () => [photo("artist", "1", "One")], current: () => current, advance: () => advances++,
      lookup: async () => { if (action === "stop") task.controller.abort(); else current = false; return [{ postId: "1", total: 1, saved: 0 }]; } });
    await locate(task.options);
    assert.equal(advances, 0);
    assert.equal(task.updates.at(-1).phase, action === "stop" ? "stopped" : "navigated");
  }
});

test("fast location rejects incomplete query results instead of skipping unknown photos", async () => {
  const task = setup({ posts: () => [photo("artist", "1", "One")], lookup: async () => [] });
  await assert.rejects(locate(task.options), /查询结果无效/);
});

test("fast location reports stalled loading without claiming all history is saved", async () => {
  let queries = 0;
  const task = setup({ posts: () => [photo("artist", "1", "One")], lookup: async () => { queries++; return [{ postId: "1", total: 1, saved: 1 }]; } });
  assert.deepEqual(await locate(task.options), { posts: 1, checked: 1, skipped: 1 });
  assert.equal(queries, 1);
  assert.equal(task.updates.at(-1).phase, "stalled");
});

const videoPost = (author, postId, ...names) => ({ author, postId, images: ["https://pbs.twimg.com/media/Poster.jpg"], videos: names.map(name => `https://video.twimg.com/tweet_video/${name}.mp4`) });
test("video batches save only the author's MP4s, reject unsafe URLs and stop after the in-flight post", async () => {
  const task = setup({ mediaType: "video", posts: () => [videoPost("other", "9", "Other"), { ...videoPost("artist", "8", "One", "Two", "One"), videos: [...videoPost("artist", "8", "One", "Two", "One").videos, "https://evil.com/Video.mp4"] }, videoPost("artist", "7", "Later")] });
  task.options.save = async post => { task.calls.push(post); task.controller.abort(); return { complete: 2, skipped: 0, failed: 0 }; };
  assert.deepEqual(await run(task.options), { posts: 1, found: 2, saved: 2, skipped: 0, failed: 0 });
  assert.deepEqual(task.calls[0].images, []);
  assert.deepEqual(task.calls[0].videos, videoPost("artist", "8", "One", "Two").videos);
  assert.equal(task.calls.length, 1);
});
test("video fast location batches history and retains partial-post totals when downloading", async () => {
  const values = Array.from({ length: 251 }, (_, index) => videoPost("artist", String(index + 1), `Video${index}`));
  values[250] = videoPost("artist", "251", "PartialOne", "PartialTwo");
  const batches = [];
  const task = setup({ mediaType: "video", posts: () => values, lookup: async batch => {
    batches.push(batch.length);
    return batch.map(post => ({ postId: post.postId, total: post.videos.length, saved: post.postId === "251" ? 1 : post.videos.length }));
  } });
  assert.deepEqual(await locate(task.options), { posts: 251, checked: 252, skipped: 251 });
  assert.deepEqual(batches, [100, 100, 51]);
  const located = task.updates.at(-1);
  const resume = setup({ mediaType: "video", posts: () => [located.target], initialProgress: { posts: located.posts, postIds: located.postIds, found: located.checked, skipped: located.skipped, postId: located.target.postId, videos: located.target.videos, savedInPost: located.targetSaved } });
  resume.options.save = async () => { resume.controller.abort(); return { complete: 1, skipped: 1, failed: 0 }; };
  assert.deepEqual(await run(resume.options), { posts: 251, found: 252, saved: 1, skipped: 251, failed: 0 });
});

test("video URL query aliases count once and stay skipped across fast-to-normal transition", async () => {
  const url = "https://video.twimg.com/tweet_video/Alias.mp4";
  const value = { author: "artist", postId: "8", images: [], videos: [`${url}?tag=1`, `${url}?tag=2`] };
  const task = setup({ mediaType: "video", posts: () => [value] });
  task.options.save = async post => { task.calls.push(post); return { complete: post.videos.length, skipped: 0, failed: 0 }; };
  assert.deepEqual(await run(task.options), { posts: 1, found: 1, saved: 1, skipped: 0, failed: 0 });
  assert.equal(task.calls[0].videos.length, 1);
  const skipped = setup({ mediaType: "video", posts: () => [value], skipMedia: [`${url}?tag=3`] });
  assert.equal((await run(skipped.options)).found, 0);
  assert.equal(skipped.calls.length, 0);
});

for (const runner of [run, locate]) {
  test(`${runner.name} stops on a timeline error between posts and retains counts`, async () => {
    let failed = false;
    const task = setup({ posts: () => [photo("artist", "1", "One"), photo("artist", "2", "Two")],
      diagnose: () => failed ? { reason: "rate-limit", error: "X 已限流（HTTP 429）" } : null,
      save: async () => { failed = true; return { complete: 1, skipped: 0, failed: 0 }; },
      lookup: async batch => { failed = true; return batch.map(p => ({ postId: p.postId, total: 1, saved: 1 })); } });
    await runner(task.options);
    assert.equal(task.updates.at(-1).phase, "blocked");
    assert.equal(task.updates.at(-1).stopReason, "rate-limit");
    assert.match(task.updates.at(-1).stopError, /429/);
    assert.equal(task.updates.at(-1).posts, runner === run ? 1 : 2);
  });
  test(`${runner.name} drains collected posts before reporting an explicit timeline end`, async () => {
    const task = setup({ posts: () => [photo("artist", "1", "One")], ended: () => true,
      lookup: async batch => batch.map(p => ({ postId: p.postId, total: 1, saved: 1 })) });
    await runner(task.options);
    assert.equal(task.updates.at(-1).phase, "ended");
    assert.equal(task.updates.at(-1).posts, 1);
  });
}

for (const runner of [run, locate]) {
  test(`${runner.name} finishes a cursor-exhausted page immediately after draining metadata`, async () => {
    let waits = 0, expanded = false;
    const task = setup({ posts: () => [photo("artist", "1", "One"), ...expanded ? [photo("artist", "2", "Two")] : []], ended: () => "exhausted",
      wait: async () => { waits++; },
      save: async () => { expanded = true; return { complete: 1, skipped: 0, failed: 0 }; },
      lookup: async batch => { expanded = true; return batch.map(p => ({ postId: p.postId, total: 1, saved: 1 })); } });
    await runner(task.options);
    assert.equal(task.updates.at(-1).phase, "exhausted");
    assert.equal(task.updates.at(-1).posts, 2);
    assert.equal(waits, 0);
  });
}
