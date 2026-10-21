import test from "node:test";
import assert from "node:assert/strict";
import "../core.js";

const { parsePostUrl, originalImage, originalVideo, normalizeFolder, createDownloads } = globalThis.XImageSaverCore;
const post = { author: "artist_01", postId: "1840000000000000000", images: ["https://pbs.twimg.com/media/Example_A?format=jpg&name=small", "https://pbs.twimg.com/media/Example_B.png?name=medium"] };

test("identifies original authors on X, legacy Twitter and photo links", () => {
  for (const url of ["https://x.com/artist_01/status/1840000000000000000", "https://twitter.com/artist_01/status/1840000000000000000/photo/1", "/artist_01/status/1840000000000000000?ref=timeline"]) {
    assert.deepEqual(parsePostUrl(url), { author: post.author, postId: post.postId });
  }
  for (const url of ["https://evil.com/user/status/123", "javascript:alert(1)", "/user/status/abc", "/a_very_long_username/status/123"]) assert.equal(parsePostUrl(url), null);
});

test("requests originals, preserves format and removes unrelated URL parameters", () => {
  assert.deepEqual(originalImage("https://pbs.twimg.com/media/Example_A.jpg?name=small&tracking=1"), {
    url: "https://pbs.twimg.com/media/Example_A?format=jpg&name=orig", key: "Example_A", extension: "jpg"
  });
  assert.equal(originalImage("https://pbs.twimg.com/media/a?format=png&name=large").extension, "png");
  assert.equal(originalImage("https://pbs.twimg.com/media/a?format=jpeg").extension, "jpg");
});

test("rejects avatars, video previews, remote hosts and unsupported files", () => {
  for (const url of ["http://pbs.twimg.com/media/a.jpg", "https://pbs.twimg.com.evil.com/media/a.jpg", "https://pbs.twimg.com:444/media/a.jpg", "https://user:pass@pbs.twimg.com/media/a.jpg", "https://pbs.twimg.com/profile_images/a.jpg", "https://pbs.twimg.com/ext_tw_video_thumb/a.jpg", "https://pbs.twimg.com/media/a?format=html", "https://pbs.twimg.com/media/a.svg"]) assert.throws(() => originalImage(url));
});

test("builds author directories, publish-time filenames and original-quality URLs", () => {
  const files = createDownloads(post);
  assert.deepEqual(files.map(file => file.filename), ["artist_01/图片/2024-09-28_20-06-00_1840000000000000000_1.jpg", "artist_01/图片/2024-09-28_20-06-00_1840000000000000000_2.png"]);
  assert.ok(files.every(file => file.url.endsWith("name=orig") && !file.saveAs && file.conflictAction === "uniquify"));
  assert.equal(createDownloads(post, "X收藏/插画")[0].filename, "X收藏/插画/artist_01/图片/2024-09-28_20-06-00_1840000000000000000_1.jpg");
});

function snowflake(iso, lowerBits = 0n) {
  return (((BigInt(Date.parse(iso)) - 1_288_834_974_657n) << 22n) | lowerBits).toString();
}

test("uses the post's exact UTC+8 publication date across day, year and leap-day boundaries", () => {
  for (const [iso, prefix] of [
    ["2025-12-31T15:59:59.999Z", "2025-12-31_23-59-59"],
    ["2025-12-31T16:00:00.000Z", "2026-01-01_00-00-00"],
    ["2024-02-28T16:00:00.000Z", "2024-02-29_00-00-00"],
    ["2024-02-29T16:00:00.000Z", "2024-03-01_00-00-00"]
  ]) {
    // Max lower bits catch rounding that would move the ID into the next second.
    const postId = snowflake(iso, (1n << 22n) - 1n);
    assert.equal(createDownloads({ ...post, postId })[0].filename, `artist_01/图片/${prefix}_${postId}_1.jpg`);
  }
});

test("publication filenames sort chronologically and do not depend on the computer timezone", () => {
  const previousTZ = process.env.TZ;
  try {
    const posts = ["2026-01-02T00:00:00Z", "2025-12-31T15:59:59Z", "2025-12-31T16:00:00Z"].map(iso => ({ ...post, postId: snowflake(iso) }));
    for (const zone of ["UTC", "America/New_York", "Asia/Tokyo"]) {
      process.env.TZ = zone;
      const filenames = posts.map(value => createDownloads(value)[0].filename);
      assert.deepEqual([...filenames].sort(), [filenames[1], filenames[2], filenames[0]]);
      assert.ok(filenames[2].includes("/2026-01-01_00-00-00_"));
    }
  } finally {
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});

test("keeps legacy filenames when a publication timestamp cannot be recovered", () => {
  for (const postId of ["20", "123456", "20000000000", "9223372036854775808", "9".repeat(30)]) {
    assert.equal(createDownloads({ ...post, postId })[0].filename, `artist_01/图片/${postId}_1.jpg`);
  }
});

test("accepts video-only posts and separates video and image directories", () => {
  const videos = ["https://video.twimg.com/ext_tw_video/123/pu/vid/avc1/720x1280/a.mp4?tag=1"];
  const files = createDownloads({ ...post, videos });
  assert.equal(files[2].filename, "artist_01/视频/2024-09-28_20-06-00_1840000000000000000_1.mp4");
  assert.equal(createDownloads({ ...post, images: [], videos }).length, 1);
});

test("validates downloadable video hosts and formats", () => {
  assert.equal(originalVideo("https://video.twimg.com/tweet_video/animated.mp4").extension, "mp4");
  for (const url of ["https://evil.com/a.mp4", "https://video.twimg.com/a.mp4", "http://video.twimg.com/tweet_video/a.mp4", "https://video.twimg.com/ext_tw_video/123/master.m3u8", "blob:https://x.com/id", "https://user@video.twimg.com/tweet_video/a.mp4", "https://video.twimg.com:444/tweet_video/a.mp4"]) assert.throws(() => originalVideo(url));
});

test("deduplicates multiple sizes of one image while preserving order", () => {
  const files = createDownloads({ ...post, images: [post.images[0], post.images[0].replace("small", "large"), post.images[1]] });
  assert.equal(files.length, 2);
  assert.ok(files[1].filename.endsWith("_2.png"));
});

test("validates relative directories, including Windows reserved paths", () => {
  assert.equal(normalizeFolder("  X收藏\\喜欢  "), "X收藏/喜欢");
  assert.equal(normalizeFolder("  "), "");
  for (const folder of ["../outside", "/absolute", "C:\\pictures", "foo//bar", "foo/./bar", "foo/../bar", "foo/", "CON", "foo/NUL.txt", "foo./bar", "a?b", "a\u0000b", "a".repeat(121), 123]) assert.throws(() => normalizeFolder(folder));
});

test("rejects invalid posts before triggering any downloads", () => {
  for (const invalid of [null, {}, { ...post, author: undefined }, { ...post, author: "../x" }, { ...post, postId: "1/2" }, { ...post, images: [] }, { ...post, images: Array(21).fill(post.images[0]) }, { ...post, images: ["https://evil.com/file.jpg"] }]) assert.throws(() => createDownloads(invalid));
});
