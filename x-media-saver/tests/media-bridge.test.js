import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
const extractor = await readFile(new URL("../video-data.js", import.meta.url), "utf8");
const bridge = await readFile(new URL("../media-bridge.js", import.meta.url), "utf8");
const videoUrl = "https://video.twimg.com/tweet_video/Fixture.mp4";
const data = { rest_id: "123", legacy: { extended_entities: { media: [{ type: "video", video_info: { variants: [{ content_type: "video/mp4", url: videoUrl }] } }] } } };
function setup(responseData = data, status = 200, headers = {}, search = "?filter=photo") {
  const messages = [], handlers = new Map();
  const response = { ok: status >= 200 && status < 300, status, headers: { get: name => headers[name] ?? null }, clone() { return { async json() { if (responseData instanceof Error) throw responseData; return responseData; } }; } };
  const promise = Promise.resolve(response);
  class FakeXHR {
    constructor() { this.listeners = new Map(); }
    open(method, url) { this.opened = { method, url }; }
    getResponseHeader(name) { return headers[name] ?? null; }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
  }
  const window = {
    fetch() { return promise; },
    postMessage(message, origin) { messages.push({ message, origin }); },
    addEventListener(type, callback) { handlers.set(type, callback); }
  };
  const context = vm.createContext({ window, location: { origin: "https://x.com", href: "https://x.com/artist/media" + search, pathname: "/artist/media", search }, URL, XMLHttpRequest: FakeXHR });
  vm.runInContext(extractor, context);
  vm.runInContext(bridge, context);
  return { window, promise, messages, handlers, FakeXHR };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test("fetch interception preserves the original promise and publishes only video metadata", async () => {
  const { window, promise, messages } = setup();
  assert.equal(window.fetch("/i/api/graphql/test/HomeTimeline"), promise);
  await flush();
  assert.equal(messages.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(messages[0])), { origin: "https://x.com", message: { type: "XIS_VIDEO_DATA", items: [{ postId: "123", videos: [videoUrl] }] } });
});

test("unrelated requests are ignored and early video metadata is replayed for content scripts", async () => {
  const { window, messages, handlers } = setup();
  window.fetch("https://evil.com/i/api/graphql/test/HomeTimeline");
  window.fetch("/i/api/graphql/test/HomeTimeline");
  await flush();
  assert.equal(messages.length, 1);
  handlers.get("message")({ source: window, origin: "https://x.com", data: { type: "XIS_REQUEST_VIDEO_CACHE" } });
  assert.equal(messages.length, 2);
  assert.equal(messages[1].message.items[0].postId, "123");
});

test("XHR interception extracts JSON responses and leaves request parameters intact", () => {
  const { FakeXHR, messages } = setup();
  const xhr = new FakeXHR();
  xhr.open("GET", "/i/api/graphql/test/TweetDetail");
  xhr.status = 200; xhr.responseType = "json"; xhr.response = data;
  xhr.listeners.get("load")();
  assert.deepEqual(xhr.opened, { method: "GET", url: "/i/api/graphql/test/TweetDetail" });
  assert.equal(messages[0].message.items[0].videos[0], videoUrl);
});

test("media-grid photo metadata includes every image and replays after content scripts start", async () => {
  const photoData = { rest_id: "456", core: { user_results: { result: { core: { screen_name: "artist" } } } }, legacy: { extended_entities: { media: [
    { type: "photo", media_url_https: "https://pbs.twimg.com/media/One.jpg" },
    { type: "photo", media_url_https: "https://pbs.twimg.com/media/Two.jpg" }
  ] } } };
  const { window, messages, handlers } = setup(photoData);
  window.fetch("/i/api/graphql/test/UserMedia");
  await flush();
  const photos = messages.find(item => item.message.type === "XIS_PHOTO_DATA");
  assert.equal(photos.message.items[0].images.length, 2);
  assert.equal(photos.message.items[0].author, "artist");
  handlers.get("message")({ source: window, origin: "https://x.com", data: { type: "XIS_REQUEST_VIDEO_CACHE" } });
  assert.deepEqual(messages.findLast(item => item.message.type === "XIS_PHOTO_DATA"), photos);
});

test("media timeline rate limits are visible, while unrelated API failures are ignored", async () => {
  const { window, messages } = setup({}, 429);
  window.fetch("/i/api/graphql/test/ExploreSidebar");
  await flush();
  assert.equal(messages.length, 0);
  window.fetch("/i/api/graphql/test/UserMedia");
  await flush();
  assert.equal(messages[0].message.type, "XIS_TIMELINE_STATUS");
  assert.equal(messages[0].message.path, "/artist/media");
  assert.match(messages[0].message.error, /限流.*429/);
});

test("HTTP 200 API errors and XHR timeouts preserve a useful timeline failure reason", async () => {
  const { window, messages, FakeXHR } = setup({ errors: [{ code: 88, message: "Rate limit exceeded" }] });
  window.fetch("/i/api/graphql/test/UserMedia");
  await flush();
  assert.match(messages.at(-1).message.error, /API 88/);
  const xhr = new FakeXHR();
  xhr.open("GET", "/i/api/graphql/test/UserMedia");
  xhr.listeners.get("timeout")();
  assert.match(messages.at(-1).message.error, /超时/);
});

test("author video metadata is published and replayed separately from single-post video data", async () => {
  const videoData = { ...data, core: { user_results: { result: { legacy: { screen_name: "artist" } } } } };
  const { window, messages, handlers } = setup(videoData);
  window.fetch("/i/api/graphql/test/UserMedia");
  await flush();
  const published = messages.find(item => item.message.type === "XIS_AUTHOR_VIDEO_DATA");
  assert.deepEqual(JSON.parse(JSON.stringify(published.message.items)), [{ author: "artist", postId: "123", videos: [videoUrl] }]);
  handlers.get("message")({ source: window, origin: "https://x.com", data: { type: "XIS_REQUEST_VIDEO_CACHE" } });
  assert.deepEqual(messages.findLast(item => item.message.type === "XIS_AUTHOR_VIDEO_DATA"), published);
});

const timeline = instructions => ({ data: { user: { result: { timeline_v2: { timeline: { instructions } } } } } });
const terminal = { type: "TimelineTerminateTimeline", direction: "Bottom" };
test("only explicit bottom termination confirms the end of a media timeline", async () => {
  for (const [instructions, ended] of [[[], false], [[{ ...terminal, direction: "Top" }], false], [[terminal], true]]) {
    const { window, messages } = setup(timeline(instructions));
    window.fetch("/i/api/graphql/test/UserMedia"); await flush();
    assert.equal(messages.at(-1).message.ended, ended);
    assert.equal(messages.at(-1).message.search, "?filter=photo");
  }
});
test("rate errors anywhere in the API errors include accurate HTTP and retry evidence", async () => {
  const reset = Math.floor(Date.now() / 1000) + 300;
  const { window, messages } = setup({ errors: [{ code: 1 }, { code: 88 }] }, 200, { "x-rate-limit-reset": String(reset) });
  window.fetch("/i/api/graphql/test/UserMedia"); await flush();
  const state = messages.at(-1).message;
  assert.equal(state.reason, "rate-limit");
  assert.match(state.error, /HTTP 200.*API 88/);
  assert.equal(state.retryAt, reset * 1000);
  assert.equal(state.ended, false);
});
test("Retry-After and non-JSON failures retain network diagnostics", async () => {
  const { window, messages } = setup({}, 429, { "retry-after": "120" });
  const before = Date.now(); window.fetch("/i/api/graphql/test/UserMedia"); await flush();
  assert.ok(messages.at(-1).message.retryAt >= before + 120000);
  assert.equal(messages.at(-1).message.reason, "rate-limit");
});
test("older concurrent successes cannot erase a later failure and cache replay retains it", async () => {
  const { window, messages, FakeXHR, handlers } = setup();
  const first = new FakeXHR(), second = new FakeXHR();
  first.open("GET", "/i/api/graphql/test/UserMedia"); second.open("GET", "/i/api/graphql/test/UserMedia");
  second.status = 429; second.listeners.get("load")();
  first.status = 200; first.responseType = "json"; first.response = timeline([]); first.listeners.get("load")();
  assert.equal(messages.at(-1).message.reason, "rate-limit");
  handlers.get("message")({ source: window, origin: "https://x.com", data: { type: "XIS_REQUEST_VIDEO_CACHE" } });
  assert.equal(messages.at(-1).message.reason, "rate-limit");
});

test("current X photo and video timeline endpoints report errors for their own filter", async () => {
  for (const [endpoint, search] of [["UserPhotoTimeline", "?filter=photo"], ["UserVideoTimeline", ""], ["UserMedia", ""]]) {
    const { window, messages } = setup({}, 429, {}, search);
    window.fetch(`/i/api/graphql/test/${endpoint}`); await flush();
    assert.equal(messages.at(-1)?.message.reason, "rate-limit", endpoint);
    assert.equal(messages.at(-1).message.search, search);
  }
  const { window, messages } = setup({}, 429);
  window.fetch("/i/api/graphql/test/UserVideoTimeline"); await flush();
  assert.equal(messages.length, 0);
});
test("a new media request invalidates a previous explicit end while it is pending", async () => {
  const { window, messages } = setup(timeline([terminal]));
  window.fetch("/i/api/graphql/test/UserPhotoTimeline"); await flush();
  assert.equal(messages.at(-1).message.ended, true);
  window.fetch("/i/api/graphql/test/UserPhotoTimeline");
  assert.equal(messages.at(-1).message.reason, "loading");
  assert.equal(messages.at(-1).message.ended, false);
  assert.ok(Number.isFinite(messages.at(-1).message.observedAt));
  await flush();
});

test("non-JSON and access failures are diagnosed without fabricating rate limits", async () => {
  for (const [status, reason] of [[200, "response"], [429, "rate-limit"], [403, "access"], [503, "http"]]) {
    const { window, messages } = setup(new Error("HTML response"), status);
    window.fetch("/i/api/graphql/test/UserPhotoTimeline"); await flush();
    assert.equal(messages.at(-1).message.reason, reason);
    assert.match(messages.at(-1).message.error, new RegExp(`HTTP ${status}`));
  }
});
test("XHR exposes API errors and retry dates", () => {
  const date = new Date(Date.now() + 600000).toUTCString();
  const { FakeXHR, messages } = setup({}, 200, { "retry-after": date });
  const xhr = new FakeXHR(); xhr.open("GET", "/i/api/graphql/test/UserPhotoTimeline");
  xhr.status = 200; xhr.responseType = "json"; xhr.response = { errors: [{ code: 88 }] };
  xhr.listeners.get("load")();
  assert.equal(messages.at(-1).message.retryAt, Date.parse(date));
  assert.equal(messages.at(-1).message.reason, "rate-limit");
});
test("current photo timeline response shape supports explicit termination and ignores nested timelines", async () => {
  for (const [body, expected] of [[{ data: { user: { result: { timeline: { timeline: { instructions: [terminal] } } } } } }, true], [{ quote: timeline([terminal]) }, false]]) {
    const { window, messages } = setup(body);
    window.fetch("/i/api/graphql/test/UserPhotoTimeline"); await flush();
    assert.equal(messages.at(-1).message.ended, expected);
  }
});

test("an older concurrent failure remains observable before a newer success", () => {
  const { FakeXHR, messages } = setup();
  const first = new FakeXHR(), second = new FakeXHR();
  first.open("GET", "/i/api/graphql/test/UserPhotoTimeline"); second.open("GET", "/i/api/graphql/test/UserPhotoTimeline");
  first.status = 429; first.listeners.get("load")();
  assert.equal(messages.at(-1)?.message.reason, "rate-limit");
  second.status = 200; second.responseType = "json"; second.response = timeline([]); second.listeners.get("load")();
  assert.equal(messages.at(-1).message.reason, "ok");
});
test("a successful cursor-only page that repeats the requested bottom cursor has no next page", async () => {
  const cursor = "fixture-bottom-cursor";
  const instructions = [{ type: "TimelineAddEntries", entries: ["Top", "Bottom"].map(cursorType => ({ content: { entryType: "TimelineTimelineCursor", cursorType, value: cursorType === "Bottom" ? cursor : "top" } })) }];
  for (const [input, body, expected] of [[cursor, timeline(instructions), true], ["different", timeline(instructions), false], [undefined, timeline(instructions), false], [cursor, timeline([]), false], [cursor, { ...timeline(instructions), errors: [{ code: 88 }] }, false], [cursor, timeline([{ ...instructions[0], entries: [...instructions[0].entries, { content: { entryType: "TimelineTimelineItem" } }] }]), false]]) {
    const { window, messages } = setup(body);
    window.fetch("/i/api/graphql/test/UserPhotoTimeline?variables=" + encodeURIComponent(JSON.stringify({ cursor: input })));
    await flush();
    assert.equal(messages.at(-1).message.exhausted, expected);
    assert.equal(messages.at(-1).message.ended, false);
    assert.equal(messages.at(-1).message.cursor, undefined, "Opaque cursors remain inside the bridge");
  }
});
