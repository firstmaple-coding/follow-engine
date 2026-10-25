const HOUR = 3600000;
export const DEFAULT_TIME_ZONE = 'America/New_York';

export function localDate(time, timeZone = DEFAULT_TIME_ZONE) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(time));
}

export function filterCurrentBlogs(blogs, now = Date.now()) {
  return (Array.isArray(blogs) ? blogs : []).filter(blog => {
    const published = Date.parse(blog?.publishedAt);
    if (!Number.isFinite(published) || published > now || now - published > 72 * HOUR) return false;
    if (typeof blog.content !== 'string' || !blog.content.trim()) return false;
    try { return ['https:', 'http:'].includes(new URL(blog.url).protocol); }
    catch { return false; }
  });
}

export function refreshReason(feed, { now = Date.now(), timeZone = DEFAULT_TIME_ZONE, force = false } = {}) {
  const today = localDate(now, timeZone); // Validate the timezone even for missing feeds.
  if (force) return 'forced';
  if (!feed) return 'missing-feed';
  const generated = Date.parse(feed.generatedAt);
  if (!Number.isFinite(generated) || generated > now) return 'invalid-timestamp';
  if (localDate(generated, timeZone) !== today) return 'previous-day';
  if (now - generated > 24 * HOUR) return 'older-than-24-hours';
  if (!filterCurrentBlogs(feed.blogs, now).length) return 'empty-feed';
  return null;
}
