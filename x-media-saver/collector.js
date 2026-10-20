(() => {
  "use strict";
  const { parsePostUrl, originalImage, originalVideo } = globalThis.XImageSaverCore;

  function belongsToPost(node, article) {
    if (node.closest('article[data-testid="tweet"]') !== article) return false;
    // X renders quoted posts as a separate clickable region, usually without a nested article.
    for (let parent = node.parentElement; parent && parent !== article; parent = parent.parentElement) {
      if (parent.matches('[data-testid="quoteTweet"], [data-testid="card.wrapper"], div[role="link"]')) return false;
    }
    return true;
  }

  function collectPost(article, videoData = new Map()) {
    const time = [...article.querySelectorAll('a[href*="/status/"] time')].find(node => belongsToPost(node, article));
    const identity = time && parsePostUrl(time.closest("a").href);
    if (!identity) return null;

    const images = new Map();
    for (const image of article.querySelectorAll('[data-testid="tweetPhoto"] img')) {
      if (!belongsToPost(image, article) || image.closest('[data-testid="videoPlayer"], [data-testid="videoComponent"]')) continue;
      const photo = image.closest('[data-testid="tweetPhoto"]');
      if (photo.querySelector("video")) continue;
      const link = image.closest('a[href*="/status/"]');
      if (link) {
        const linkedPost = parsePostUrl(link.href);
        if (!linkedPost || linkedPost.postId !== identity.postId) continue;
      }
      try {
        const parsed = originalImage(image.currentSrc || image.src);
        images.set(parsed.key, parsed.url);
      } catch { /* Avatars, emoji, cards and video thumbnails are not post images. */ }
    }
    const videos = new Map();
    const ownVideo = [...article.querySelectorAll('[data-testid="videoPlayer"], [data-testid="videoComponent"], video')].some(node => belongsToPost(node, article));
    if (ownVideo) {
      for (const value of videoData.get(identity.postId) || []) {
        try { const parsed = originalVideo(value); videos.set(parsed.key, parsed.url); } catch { /* Reject non-X or non-MP4 sources. */ }
      }
      if (!videos.size) {
        for (const node of article.querySelectorAll('video[src], video source[src]')) {
          if (!belongsToPost(node, article)) continue;
          try { const parsed = originalVideo(node.src); videos.set(parsed.key, parsed.url); } catch { /* Blob/HLS players need their GraphQL metadata. */ }
        }
      }
    }
    return images.size || videos.size ? { ...identity, images: [...images.values()], videos: [...videos.values()] } : null;
  }

  function actionBar(article) {
    const reply = [...article.querySelectorAll('[data-testid="reply"]')].find(node => belongsToPost(node, article));
    return reply?.closest('[role="group"]') || null;
  }

  globalThis.XImageSaverCollector = Object.freeze({ collectPost, actionBar });
})();
