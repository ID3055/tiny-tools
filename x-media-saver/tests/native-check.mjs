// Requires an isolated agent-browser session launched with --enable-unsafe-extension-debugging.
// node --experimental-websocket tests/native-check.mjs [agent-browser-session]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, mkdir, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const browserSession = process.argv[2] || "xis-v12";
const wsUrl = execFileSync("agent-browser", ["--session", browserSession, "get", "cdp-url"], { encoding: "utf8" }).trim();
const output = join(root, "test-results", `native-${Date.now()}`);
await mkdir(output, { recursive: true });
const videoFile = join(output, "source.mp4");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=32x32:d=0.2", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", videoFile]);
const image = await readFile(join(root, "icons", "48.png"));
const video = await readFile(videoFile);
const pending = new Map();
const sessions = new Map();
const errors = [];
const hits = new Map();
let nextId = 1, extensionId, pageSession;
const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
function cdp(method, params = {}, sessionId) {
  const id = nextId++;
  const message = { id, method, params };
  if (sessionId) message.sessionId = sessionId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify(message));
  });
}
const variants = [
  { content_type: "video/mp4", bitrate: 256000, url: "https://video.twimg.com/ext_tw_video/444/pu/vid/avc1/32x32/FixtureLow.mp4" },
  { content_type: "video/mp4", bitrate: 2176000, url: "https://video.twimg.com/ext_tw_video/444/pu/vid/avc1/32x32/FixtureHigh.mp4" }
];
const header = (author, id) => `<div data-testid="User-Name">${author}<a href="https://x.com/${author}/status/${id}"><time>today</time></a></div>`;
const photo = (id, name) => `<a href="https://x.com/native_artist/status/${id}/photo/1"><div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/${name}?format=png&name=small"></div></a>`;
const bar = '<div role="group"><button data-testid="reply">reply</button></div>';
const html = `<!doctype html><title>Extension native integration test</title><article data-testid="tweet" id="photos">${header("native_artist", "111")}${photo("111", "FixtureA")}${photo("111", "FixtureB")}${bar}</article><article data-testid="tweet" id="video">${header("native_artist", "444")}<div data-testid="videoPlayer">video player</div>${bar}</article><script>fetch('/i/api/graphql/fixture/Timeline').then(r=>r.json())</script>`;
const graph = JSON.stringify({ data: { result: { rest_id: "444", legacy: { extended_entities: { media: [{ type: "video", video_info: { variants } }] } } } } });
async function onEvent(event) {
  if (event.method === "Target.attachedToTarget") {
    const { sessionId, targetInfo } = event.params;
    sessions.set(targetInfo.targetId, { sessionId, info: targetInfo });
    try {
      await cdp("Fetch.enable", { patterns: [
        { urlPattern: "https://x.com/xis-native-test*" },
        { urlPattern: "https://x.com/i/api/graphql/fixture/*" },
        { urlPattern: "https://pbs.twimg.com/media/Fixture*" },
        { urlPattern: "https://video.twimg.com/ext_tw_video/444/*" }
      ] }, sessionId);
    } catch { /* Some background targets have no network domain. */ }
    await cdp("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
    sessions.get(targetInfo.targetId).ready = true;
  }
  if (event.method === "Fetch.requestPaused") {
    const { requestId, request } = event.params;
    const url = new URL(request.url);
    hits.set(request.url, (hits.get(request.url) || 0) + 1);
    let body, type;
    if (url.pathname === "/xis-native-test") { body = Buffer.from(html); type = "text/html"; }
    else if (url.pathname.includes("/i/api/graphql/fixture/")) { body = Buffer.from(graph); type = "application/json"; }
    else if (url.hostname === "video.twimg.com") { body = video; type = "video/mp4"; }
    else { body = image; type = "image/png"; }
    await cdp("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: type }, { name: "Access-Control-Allow-Origin", value: "*" }], body: body.toString("base64") }, event.sessionId);
  }
}
ws.onmessage = event => {
  const data = JSON.parse(event.data);
  if (data.id) {
    const item = pending.get(data.id);
    if (!item) return;
    clearTimeout(item.timer); pending.delete(data.id);
    if (data.error) item.reject(new Error(JSON.stringify(data.error)));
    else item.resolve(data.result);
  } else { void onEvent(data).catch(error => errors.push(error.message)); }
};
async function evaluate(expression, sessionId = pageSession) {
  const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function until(operation, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await operation();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
const checks = [];
try {
  await cdp("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: output });
  await cdp("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  ({ id: extensionId } = await cdp("Extensions.loadUnpacked", { path: root.replace(/\/$/, "") }));
  const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
  pageSession = await until(async () => sessions.get(targetId)?.ready && sessions.get(targetId).sessionId, "page session");
  await cdp("Page.navigate", { url: "https://x.com/xis-native-test" }, pageSession);
  await until(() => evaluate("document.querySelectorAll('.xis-save').length === 2"), "photo and video buttons");
  checks.push("Native content scripts capture GraphQL variants and inject photo/video buttons");
  await evaluate("document.querySelector('#photos .xis-save').click()");
  await until(() => evaluate("document.querySelector('#photos .xis-save').dataset.state === 'done'"), "photo save");
  const toast = await evaluate("document.querySelector('#xis-toast').textContent");
  assert.match(toast, /已保存 1 个文件.*跳过 1 个重复/);
  checks.push("Native offscreen SHA-256 skips byte-identical photos at different URLs");
  const originalHits = () => [...hits].filter(([url]) => url.includes("name=orig")).reduce((sum, [,count]) => sum + count, 0);
  assert.equal(originalHits(), 2);
  await evaluate("document.querySelector('#photos .xis-save').click()");
  await until(() => evaluate("document.querySelector('#photos .xis-save').dataset.state === 'done'"), "duplicate click");
  assert.match(await evaluate("document.querySelector('#xis-toast').textContent"), /全部 2 个文件已下载过/);
  assert.equal(originalHits(), 2);
  checks.push("Repeated saves check durable history and perform no new media fetch");
  await evaluate("document.querySelector('#video .xis-save').click()");
  await until(() => evaluate("document.querySelector('#video .xis-save').dataset.state === 'done'"), "video save");
  assert.equal([...hits.keys()].filter(url => url.includes("FixtureHigh")).length, 1);
  assert.equal([...hits.keys()].filter(url => url.includes("FixtureLow")).length, 0);
  checks.push("Highest-bitrate MP4 is fetched and saved through the native downloads API");
  const targets = await cdp("Target.getTargets");
  const worker = targets.targetInfos.find(item => item.type === "service_worker" && item.url === `chrome-extension://${extensionId}/background.js`);
  const workerSession = sessions.get(worker.targetId)?.sessionId || (await cdp("Target.attachToTarget", { targetId: worker.targetId, flatten: true })).sessionId;
  const downloads = await evaluate("chrome.downloads.search({}).then(items => items.filter(i => i.byExtensionId === chrome.runtime.id).map(({id,filename,state,exists})=>({id,filename,state,exists})))", workerSession);
  assert.equal(downloads.length, 2);
  const photoRecord = downloads.find(item => item.filename.endsWith(".png"));
  const videoRecord = downloads.find(item => item.filename.endsWith(".mp4"));
  // CDP's download directory override may flatten extension subdirectories; requested names are unit-tested.
  assert.deepEqual(await readFile(photoRecord.filename), image);
  assert.deepEqual(await readFile(videoRecord.filename), video);
  checks.push("Saved image and playable MP4 bytes exactly match the single fetched sources");
  await unlink(photoRecord.filename);
  await until(async () => {
    const [item] = await evaluate(`chrome.downloads.search({id:${photoRecord.id}})`, workerSession);
    return item.exists === false;
  }, "browser file deletion detection");
  await evaluate("document.querySelector('#photos .xis-save').click()");
  await until(() => evaluate("document.querySelector('#photos .xis-save').dataset.state === 'done'"), "save after delete");
  assert.equal(originalHits(), 2);
  checks.push("Deleted files remain skipped without another media fetch");
  await evaluate("chrome.downloads.erase({})", workerSession);
  await cdp("Page.reload", {}, pageSession);
  await until(() => evaluate("document.querySelector('#photos .xis-save')?.dataset.state === 'done'"), "saved badge after page reload");
  await evaluate("document.querySelector('#photos .xis-save').click()");
  await until(() => evaluate("document.querySelector('#photos .xis-save').dataset.state === 'done'"), "skip after native history erased");
  assert.equal(originalHits(), 2);
  checks.push("Saved badges and skip behavior survive page reload and clearing native download history");
  await evaluate("document.querySelector('#photos .xis-save').dispatchEvent(new MouseEvent('click', { bubbles:true, shiftKey:true }))");
  await until(() => evaluate("document.querySelector('#photos .xis-save').dataset.state === 'done'"), "forced save after delete");
  assert.equal(originalHits(), 4);
  assert.match(await evaluate("document.querySelector('#xis-toast').textContent"), /已保存 1 个文件.*跳过 1 个重复/);
  const replacements = await evaluate("chrome.downloads.search({}).then(items=>items.filter(i=>i.byExtensionId===chrome.runtime.id))", workerSession);
  assert.equal(replacements.length, 1);
  assert.deepEqual(await readFile(replacements[0].filename), image);
  checks.push("Shift-click restores the deleted image while merging identical images in the same post");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: checks.length, checks, downloads, output }, null, 2));
} finally {
  ws.close();
  for (const item of pending.values()) clearTimeout(item.timer);
}
