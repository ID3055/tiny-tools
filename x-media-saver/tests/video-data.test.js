import test from "node:test";
import assert from "node:assert/strict";
import "../video-data.js";
const { extractVideos } = globalThis.XImageSaverVideoData;
const variant = (name, bitrate) => ({ url: `https://video.twimg.com/ext_tw_video/123/pu/vid/avc1/720x1280/${name}.mp4`, content_type: "video/mp4", bitrate });
const tweet = (id, media) => ({ rest_id: id, legacy: { extended_entities: { media } } });

test("selects the highest-bitrate MP4 and ignores HLS playlists", () => {
  const low = variant("low", 256000), high = variant("high", 2176000);
  const result = extractVideos({ data: { result: tweet("123", [{ type: "video", video_info: { variants: [low, { url: "https://video.twimg.com/a.m3u8", content_type: "application/x-mpegURL" }, high] } }]) } });
  assert.deepEqual(result, [{ postId: "123", videos: [high.url] }]);
});

test("preserves quoted-post identities, multiple videos and animated GIF MP4s", () => {
  const a = variant("one", 1), b = variant("two", 2);
  const outer = tweet("123", [{ type: "video", video_info: { variants: [a] } }, { type: "animated_gif", video_info: { variants: [b] } }]);
  outer.quoted_status_result = { result: tweet("999", [{ type: "video", video_info: { variants: [b] } }]) };
  assert.deepEqual(extractVideos(outer).sort((a, b) => a.postId.localeCompare(b.postId)), [{ postId: "123", videos: [a.url, b.url] }, { postId: "999", videos: [b.url] }]);
});

test("rejects untrusted variant URLs and ignores photos", () => {
  const urls = ["https://evil.com/a.mp4", "https://video.twimg.com:444/tweet_video/a.mp4", "https://user@video.twimg.com/tweet_video/a.mp4"];
  assert.deepEqual(extractVideos(tweet("123", [{ type: "video", video_info: { variants: urls.map(url => ({ url, content_type: "video/mp4" })) } }, { type: "photo", video_info: { variants: [variant("a", 1)] } }])), []);
});

const { extractPhotoPosts } = globalThis.XImageSaverVideoData;
test("extracts all photos with their actual authors from media grids and quotes", () => {
  const outer = tweet("123", [{ type: "photo", media_url_https: "https://pbs.twimg.com/media/One.jpg" }, { type: "photo", media_url_https: "https://pbs.twimg.com/media/Two.png" }, { type: "video", media_url_https: "https://pbs.twimg.com/media/VideoPoster.jpg" }]);
  outer.core = { user_results: { result: { core: { screen_name: "artist" } } } };
  const quote = tweet("999", [{ type: "photo", media_url_https: "https://pbs.twimg.com/media/Quote.jpg" }]);
  quote.core = { user_results: { result: { legacy: { screen_name: "other" } } } };
  outer.quoted_status_result = { result: quote };
  const posts = extractPhotoPosts(outer);
  assert.deepEqual(posts.find(post => post.postId === "123"), { author: "artist", postId: "123", images: ["https://pbs.twimg.com/media/One.jpg", "https://pbs.twimg.com/media/Two.png"] });
  assert.equal(posts.find(post => post.postId === "999").author, "other");
});
test("rejects photo entries with missing authors and invalid sources", () => {
  const node = tweet("123", [{ type: "photo", media_url_https: "https://evil.com/a.jpg" }, { type: "photo", media_url_https: "https://pbs.twimg.com/profile_images/a.jpg" }]);
  node.user = { screen_name: "artist" };
  assert.deepEqual(extractPhotoPosts(node), []);
  delete node.user;
  node.legacy.extended_entities.media = [{ type: "photo", media_url_https: "https://pbs.twimg.com/media/Good.jpg" }];
  assert.deepEqual(extractPhotoPosts(node), []);
});

test("author video metadata preserves authors, quotes, GIFs and the highest MP4 quality", () => {
  const { extractVideoPosts } = globalThis.XImageSaverVideoData;
  const high = variant("high", 2000), low = variant("low", 500), gif = variant("gif", 1);
  const outer = tweet("123", [{ type: "video", video_info: { variants: [low, high] } }, { type: "animated_gif", video_info: { variants: [gif] } }]);
  outer.core = { user_results: { result: { core: { screen_name: "artist" } } } };
  const quote = tweet("999", [{ type: "video", video_info: { variants: [low] } }]);
  quote.user = { screen_name: "other" };
  outer.quoted_status_result = { result: quote };
  const posts = extractVideoPosts(outer);
  assert.deepEqual(posts.find(post => post.postId === "123"), { author: "artist", postId: "123", videos: [high.url, gif.url] });
  assert.equal(posts.find(post => post.postId === "999").author, "other");
  assert.deepEqual(extractVideoPosts(tweet("888", outer.legacy.extended_entities.media)), []);
});
