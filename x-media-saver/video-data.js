(() => {
  "use strict";
  function extractVideos(root, withAuthor = false) {
    const posts = new Map();
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;
      const legacy = node.legacy || node;
      const id = node.rest_id || legacy.id_str;
      const media = legacy.extended_entities?.media || legacy.entities?.media;
      const user = node.core?.user_results?.result || node.user;
      const author = user?.core?.screen_name || user?.legacy?.screen_name || user?.screen_name;
      if (/^\d{1,30}$/.test(id) && Array.isArray(media) && (!withAuthor || typeof author === "string" && /^[A-Za-z0-9_]{1,15}$/.test(author))) {
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
        if (videos.length) {
          const unique = [...new Set(videos)];
          posts.set(String(id), withAuthor ? { author, postId: String(id), videos: unique } : unique);
        }
      }
      stack.push(...Object.values(node).filter(value => value && typeof value === "object"));
    }
    return withAuthor ? [...posts.values()] : [...posts].map(([postId, videos]) => ({ postId, videos }));
  }
  function extractPhotoPosts(root) {
    const posts = new Map();
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;
      const legacy = node.legacy || node;
      const id = node.rest_id || legacy.id_str;
      const user = node.core?.user_results?.result || node.user;
      const author = user?.core?.screen_name || user?.legacy?.screen_name || user?.screen_name;
      const media = legacy.extended_entities?.media || legacy.entities?.media;
      if (/^\d{1,30}$/.test(id) && typeof author === "string" && /^[A-Za-z0-9_]{1,15}$/.test(author) && Array.isArray(media)) {
        const images = media.filter(item => item.type === "photo").map(item => item.media_url_https).filter(value => {
          try {
            const url = new URL(value);
            return url.protocol === "https:" && url.hostname === "pbs.twimg.com" && !url.username && !url.password && !url.port && /^\/media\/[A-Za-z0-9_-]+(?:\.(?:jpg|jpeg|png|webp|gif|avif))?$/.test(url.pathname);
          } catch { return false; }
        });
        if (images.length && images.length <= 20) posts.set(String(id), { author, postId: String(id), images: [...new Set(images)] });
      }
      stack.push(...Object.values(node).filter(value => value && typeof value === "object"));
    }
    return [...posts.values()];
  }
  const extractVideoPosts = root => extractVideos(root, true);
  globalThis.XImageSaverVideoData = Object.freeze({ extractVideos, extractPhotoPosts, extractVideoPosts });
})();
