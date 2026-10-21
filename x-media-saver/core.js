(() => {
  "use strict";

  const AUTHOR = /^[A-Za-z0-9_]{1,15}$/;
  const POST_ID = /^\d{1,30}$/;
  const FORMATS = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif"]);

  function parsePostUrl(value) {
    try {
      const url = new URL(value, "https://x.com");
      if (url.protocol !== "https:" || !["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname)) return null;
      const match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,30})(?:\/|$)/);
      return match ? { author: match[1], postId: match[2] } : null;
    } catch {
      return null;
    }
  }

  function originalImage(value) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "pbs.twimg.com" || url.port || url.username || url.password) {
      throw new Error("只允许下载 X 的图片。");
    }
    const match = url.pathname.match(/^\/media\/([A-Za-z0-9_-]+)(?:\.(jpg|jpeg|png|webp|gif|avif))?$/i);
    if (!match) throw new Error("不是帖子图片。");
    const format = (url.searchParams.get("format") || match[2] || "jpg").toLowerCase();
    if (!FORMATS.has(format)) throw new Error("不支持的图片格式。");
    const original = new URL(`https://pbs.twimg.com/media/${match[1]}`);
    original.searchParams.set("format", format);
    original.searchParams.set("name", "orig");
    return { url: original.href, key: match[1], extension: format === "jpeg" ? "jpg" : format };
  }

  function normalizeFolder(value = "") {
    if (typeof value !== "string") throw new Error("保存目录必须是文字。");
    const folder = value.trim().replace(/\\/g, "/");
    if (!folder) return "";
    const segments = folder.split("/");
    if (folder.length > 120 || segments.some(part => !part || part === "." || part === ".." || /[<>:"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
      throw new Error("请使用下载目录内的相对路径，例如 X收藏；不能包含 .. 或特殊字符。");
    }
    return folder;
  }

  function originalVideo(value) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "video.twimg.com" || url.port || url.username || url.password || !/^\/(ext_tw_video|amplify_video|tweet_video)\/[A-Za-z0-9_/.%-]+\.mp4$/.test(url.pathname)) {
      throw new Error("只支持 X 的 MP4 视频。");
    }
    url.hash = "";
    return { url: url.href, key: url.pathname, extension: "mp4" };
  }

  function postTimePrefix(postId) {
    const id = BigInt(postId);
    // Early, pre-Snowflake IDs have no timestamp. Exclude the ambiguous
    // transition period and IDs outside X's signed 64-bit range.
    if (id < 1_000_000_000_000n || id > 9_223_372_036_854_775_807n) return "";
    // Decode before converting to Number: full post IDs exceed safe integers.
    // Use a fixed UTC+08:00 offset so filenames stay stable across computers.
    const publishedAt = Number((id >> 22n) + 1_288_834_974_657n);
    const stamp = new Date(publishedAt + 8 * 60 * 60 * 1000).toISOString();
    return `${stamp.slice(0, 19).replace("T", "_").replaceAll(":", "-")}_`;
  }

  function createDownloads(post, folder = "") {
    if (!post || typeof post.author !== "string" || typeof post.postId !== "string" || !AUTHOR.test(post.author) || !POST_ID.test(post.postId) || !Array.isArray(post.images) || post.images.length > 20 || (post.videos !== undefined && !Array.isArray(post.videos))) {
      throw new Error("帖子信息无效，请刷新页面后重试。");
    }
    const videos = post.videos || [];
    if (videos.length > 20 || !post.images.length && !videos.length) throw new Error("帖子没有可保存的图片或视频。");
    const root = normalizeFolder(folder);
    const prefix = postTimePrefix(post.postId);
    return [[post.images, originalImage, "图片"], [videos, originalVideo, "视频"]].flatMap(([sources, parse, kind]) => {
      const unique = new Map();
      for (const source of sources) {
        const parsed = parse(source);
        if (!unique.has(parsed.key)) unique.set(parsed.key, parsed);
      }
      return [...unique.values()].map((media, index) => ({
        url: media.url,
        filename: [root, post.author, kind, `${prefix}${post.postId}_${index + 1}.${media.extension}`].filter(Boolean).join("/"),
        conflictAction: "uniquify",
        saveAs: false
      }));
    });
  }

  globalThis.XImageSaverCore = Object.freeze({ parsePostUrl, originalImage, originalVideo, normalizeFolder, createDownloads });
})();
