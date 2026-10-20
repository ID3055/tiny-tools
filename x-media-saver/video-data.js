(() => {
  "use strict";
  function extractVideos(root) {
    const posts = new Map();
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;
      const legacy = node.legacy || node;
      const id = node.rest_id || legacy.id_str;
      const media = legacy.extended_entities?.media || legacy.entities?.media;
      if (/^\d{1,30}$/.test(id) && Array.isArray(media)) {
        const videos = [];
        for (const item of media) {
          if (!["video", "animated_gif"].includes(item.type)) continue;
          const variants = (item.video_info?.variants || []).filter(variant => {
            try {
              const url = new URL(variant.url);
              return variant.content_type === "video/mp4" && url.protocol === "https:" && url.hostname === "video.twimg.com" && !url.username && !url.password && !url.port && /^\/(ext_tw_video|amplify_video|tweet_video)\/[A-Za-z0-9_/.%-]+\.mp4$/.test(url.pathname);
            } catch { return false; }
          }).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
          if (variants[0]) videos.push(variants[0].url);
        }
        if (videos.length) posts.set(String(id), [...new Set(videos)]);
      }
      stack.push(...Object.values(node).filter(value => value && typeof value === "object"));
    }
    return [...posts].map(([postId, videos]) => ({ postId, videos }));
  }
  globalThis.XImageSaverVideoData = Object.freeze({ extractVideos });
})();
