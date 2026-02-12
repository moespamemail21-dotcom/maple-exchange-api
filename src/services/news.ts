import axios from 'axios';
import { load } from 'cheerio';
import { redis } from './redis.js';

interface NewsArticle {
  title: string;
  source: string;
  url: string;
  publishedAt: string;
}

const COIN_SEARCH_TERMS: Record<string, string> = {
  BTC: 'Bitcoin',
  ETH: 'Ethereum',
  LTC: 'Litecoin',
  XRP: 'XRP cryptocurrency',
  SOL: 'Solana crypto',
  LINK: 'Chainlink crypto',
};

const CACHE_PREFIX = 'news:';
const CACHE_TTL = 3600; // 1 hour
const MAX_ARTICLES = 20;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// In-memory cache for when Redis is unavailable
const memoryCache = new Map<string, NewsArticle[]>();

async function fetchNewsForCoin(symbol: string): Promise<NewsArticle[]> {
  const searchTerm = COIN_SEARCH_TERMS[symbol];
  if (!searchTerm) return [];

  try {
    const query = encodeURIComponent(searchTerm);
    const url = `https://news.google.com/rss/search?q=${query}&hl=en-CA&gl=CA&ceid=CA:en`;

    const { data } = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MapleExchange/1.0)',
      },
    });

    const $ = load(data, { xml: true });
    const articles: NewsArticle[] = [];
    const cutoff = Date.now() - THIRTY_DAYS_MS;

    $('item').each((_i: number, el: any) => {
      if (articles.length >= MAX_ARTICLES) return false;

      const rawTitle = $(el).find('title').text().trim();
      const link = $(el).find('link').text().trim();
      const pubDate = $(el).find('pubDate').text().trim();
      const sourceEl = $(el).find('source');
      const source = sourceEl.text().trim() || 'Unknown';

      if (!rawTitle || !link) return;

      // Parse publish date, skip articles older than 30 days
      const publishDate = new Date(pubDate);
      if (isNaN(publishDate.getTime()) || publishDate.getTime() < cutoff) return;

      // Google News appends " - Source" to titles; strip it if source is known
      let title = rawTitle;
      if (source && source !== 'Unknown') {
        const suffix = ` - ${source}`;
        if (title.endsWith(suffix)) {
          title = title.slice(0, -suffix.length);
        }
      }

      articles.push({
        title,
        source,
        url: link,
        publishedAt: publishDate.toISOString(),
      });
    });

    // Sort by most recent first
    articles.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

    return articles;
  } catch (err) {
    console.error(`News fetch failed for ${symbol}:`, err instanceof Error ? err.message : err);
    return memoryCache.get(symbol) ?? [];
  }
}

export async function getNewsForCoin(symbol: string): Promise<NewsArticle[]> {
  const cacheKey = `${CACHE_PREFIX}${symbol}`;

  // Try Redis cache
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  // Try memory cache
  const memCached = memoryCache.get(symbol);
  if (memCached) return memCached;

  // Fetch fresh
  const articles = await fetchNewsForCoin(symbol);
  if (articles.length > 0) {
    memoryCache.set(symbol, articles);
    await redis.set(cacheKey, JSON.stringify(articles), 'EX', CACHE_TTL);
  }
  return articles;
}

export async function refreshAllNews(): Promise<void> {
  const symbols = Object.keys(COIN_SEARCH_TERMS);

  // Fetch sequentially with small delay to avoid rate limits
  for (const symbol of symbols) {
    try {
      const articles = await fetchNewsForCoin(symbol);
      if (articles.length > 0) {
        memoryCache.set(symbol, articles);
        await redis.set(`${CACHE_PREFIX}${symbol}`, JSON.stringify(articles), 'EX', CACHE_TTL);
      }
    } catch {
      // Individual coin failure doesn't block others
    }
    // 2-second delay between requests to avoid rate limiting
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export function startNewsFeed(intervalMs = 3600_000): NodeJS.Timeout {
  refreshAllNews();
  return setInterval(refreshAllNews, intervalMs);
}
