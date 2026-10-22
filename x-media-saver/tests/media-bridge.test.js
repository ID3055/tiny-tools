import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
const extractor = await readFile(new URL("../video-data.js", import.meta.url), "utf8");
const bridge = await readFile(new URL("../media-bridge.js", import.meta.url), "utf8");
const videoUrl = "https://video.twimg.com/tweet_video/Fixture.mp4";
const data = { rest_id: "123", legacy: { extended_entities: { media: [{ type: "video", video_info: { variants: [{ content_type: "video/mp4", url: videoUrl }] } }] } } };
function setup(responseData = data, status = 200) {
  const messages = [], handlers = new Map();
  const response = { ok: status >= 200 && status < 300, status, clone() { return { async json() { return responseData; } }; } };
  const promise = Promise.resolve(response);
  class FakeXHR {
    constructor() { this.listeners = new Map(); }
    open(method, url) { this.opened = { method, url }; }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
  }
  const window = {
    fetch() { return promise; },
    postMessage(message, origin) { messages.push({ message, origin }); },
    addEventListener(type, callback) { handlers.set(type, callback); }
  };
  const context = vm.createContext({ window, location: { origin: "https://x.com", href: "https://x.com/artist/media", pathname: "/artist/media" }, URL, XMLHttpRequest: FakeXHR });
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
  assert.deepEqual(messages.at(-1), photos);
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
  assert.match(messages.at(-1).message.error, /429/);
  const xhr = new FakeXHR();
  xhr.open("GET", "/i/api/graphql/test/UserMedia");
  xhr.listeners.get("timeout")();
  assert.match(messages.at(-1).message.error, /超时/);
});
