'use server';

import yahooFinance from 'yahoo-finance2';
import { validateArticle, formatArticle } from '@/lib/utils';
import { POPULAR_STOCK_SYMBOLS } from '@/lib/constants';
import { cache } from 'react';

// Suppress the one-time survey notice from yahoo-finance2
yahooFinance.suppressNotices(['yahooSurvey']);

// Shared validate option: prevents hard throws on minor schema differences
const YF_OPTS = { validateResult: false } as const;

// Converts a Yahoo Finance news UUID string into a numeric id for RawNewsArticle
function uuidToNumericId(uuid: string): number {
    let hash = 0;
    for (let i = 0; i < uuid.length; i++) {
        hash = (Math.imul(31, hash) + uuid.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
}

type YahooNewsItem = {
    uuid: string;
    title: string;
    publisher: string;
    link: string;
    providerPublishTime: Date;
    thumbnail?: { resolutions: Array<{ url: string }> };
    relatedTickers?: string[];
};

function yahooNewsToRawArticle(news: YahooNewsItem, symbol?: string): RawNewsArticle {
    return {
        id: uuidToNumericId(news.uuid),
        headline: news.title,
        // Yahoo Finance does not provide article summaries; use the title as fallback
        summary: news.title,
        source: news.publisher,
        url: news.link,
        datetime: Math.floor(news.providerPublishTime.getTime() / 1000),
        image: news.thumbnail?.resolutions?.[0]?.url,
        category: symbol ? 'company' : 'general',
        related: symbol || '',
    };
}

export async function getQuote(symbol: string) {
    try {
        const q = await yahooFinance.quote(symbol, {}, YF_OPTS);
        if (!q) return null;
        return {
            c: q.regularMarketPrice,
            d: q.regularMarketChange,
            dp: q.regularMarketChangePercent,
        };
    } catch (e) {
        console.error('Error fetching quote for', symbol, e);
        return null;
    }
}

export async function getCompanyProfile(symbol: string) {
    try {
        const q = await yahooFinance.quote(symbol, {}, YF_OPTS);
        if (!q) return null;
        return {
            currency: q.currency,
            exchange: q.fullExchangeName,
            logo: undefined as string | undefined,
            // Yahoo returns actual USD; divide by 1 000 000 to keep the same
            // "millions" unit that formatNumber() in utils.ts expects
            marketCapitalization: q.marketCap != null ? q.marketCap / 1_000_000 : undefined,
            name: q.longName || q.shortName,
            ticker: q.symbol,
        };
    } catch (e) {
        console.error('Error fetching profile for', symbol, e);
        return null;
    }
}

export async function getWatchlistData(symbols: string[]) {
    if (!symbols || symbols.length === 0) return [];

    // Yahoo Finance supports batch quote requests, saving N individual HTTP calls
    const raw = await yahooFinance.quote(symbols, {}, YF_OPTS);
    const quoteArray = Array.isArray(raw) ? raw : [raw];

    // Build a map for O(1) lookup (order is not guaranteed in batch responses)
    const quoteMap = new Map(quoteArray.map(q => [q.symbol?.toUpperCase() ?? '', q]));

    return symbols.map(sym => {
        const q = quoteMap.get(sym.toUpperCase());
        return {
            symbol: sym,
            price: q?.regularMarketPrice || 0,
            change: q?.regularMarketChange || 0,
            changePercent: q?.regularMarketChangePercent || 0,
            currency: q?.currency || 'USD',
            name: q?.longName || q?.shortName || sym,
            logo: undefined,
            marketCap: q?.marketCap != null ? q.marketCap / 1_000_000 : undefined,
            peRatio: q?.trailingPE || 0,
        };
    });
}

export async function getNews(symbols?: string[]): Promise<MarketNewsArticle[]> {
    try {
        const cleanSymbols = (symbols || [])
            .map(s => s?.trim().toUpperCase())
            .filter((s): s is string => Boolean(s));

        const maxArticles = 6;

        // Per-symbol news: use Yahoo search which returns recent news for each ticker
        if (cleanSymbols.length > 0) {
            const perSymbolArticles: Record<string, RawNewsArticle[]> = {};

            await Promise.all(
                cleanSymbols.map(async sym => {
                    try {
                        const result = await yahooFinance.search(
                            sym,
                            { newsCount: 5, quotesCount: 0 },
                            YF_OPTS,
                        );
                        perSymbolArticles[sym] = (result.news as YahooNewsItem[] || [])
                            .map(n => yahooNewsToRawArticle(n, sym))
                            .filter(validateArticle);
                    } catch (e) {
                        console.error('Error fetching news for', sym, e);
                        perSymbolArticles[sym] = [];
                    }
                }),
            );

            const collected: MarketNewsArticle[] = [];
            // Round-robin up to maxArticles picks across all symbols
            for (let round = 0; round < maxArticles; round++) {
                for (let i = 0; i < cleanSymbols.length; i++) {
                    const sym = cleanSymbols[i];
                    const list = perSymbolArticles[sym] || [];
                    if (list.length === 0) continue;
                    const article = list.shift();
                    if (!article || !validateArticle(article)) continue;
                    collected.push(formatArticle(article, true, sym, round));
                    if (collected.length >= maxArticles) break;
                }
                if (collected.length >= maxArticles) break;
            }

            if (collected.length > 0) {
                collected.sort((a, b) => (b.datetime || 0) - (a.datetime || 0));
                return collected.slice(0, maxArticles);
            }
            // Fall through to general news if no company news was collected
        }

        // General market news fallback
        const general = await yahooFinance.search(
            'stock market finance',
            { newsCount: 20, quotesCount: 0 },
            YF_OPTS,
        );

        const seen = new Set<string>();
        const unique: RawNewsArticle[] = [];
        for (const n of general.news as YahooNewsItem[] || []) {
            const article = yahooNewsToRawArticle(n);
            if (!validateArticle(article)) continue;
            if (seen.has(article.url!)) continue;
            seen.add(article.url!);
            unique.push(article);
            if (unique.length >= 20) break;
        }

        return unique.slice(0, maxArticles).map((a, idx) => formatArticle(a, false, undefined, idx));
    } catch (err) {
        console.error('getNews error:', err);
        throw new Error('Failed to fetch news');
    }
}

export const searchStocks = cache(async (query?: string): Promise<StockWithWatchlistStatus[]> => {
    try {
        const trimmed = typeof query === 'string' ? query.trim() : '';

        if (!trimmed) {
            // Batch-quote the top popular symbols — one request instead of N profile calls
            const top = POPULAR_STOCK_SYMBOLS.slice(0, 10);
            const raw = await yahooFinance.quote(top, {}, YF_OPTS);
            const quotes = Array.isArray(raw) ? raw : [raw];
            return quotes
                .filter(q => q.symbol && (q.longName || q.shortName))
                .map(q => ({
                    symbol: q.symbol!.toUpperCase(),
                    name: q.longName || q.shortName || q.symbol!,
                    exchange: q.fullExchangeName || 'US',
                    type: q.typeDisp || q.quoteType || 'Stock',
                    isInWatchlist: false,
                }))
                .slice(0, 15);
        }

        const result = await yahooFinance.search(
            trimmed,
            { quotesCount: 15, newsCount: 0 },
            YF_OPTS,
        );

        return (result.quotes as any[])
            .filter((r: any) => Boolean(r.symbol))
            .map((r: any) => ({
                symbol: (r.symbol as string).toUpperCase(),
                name: r.longname || r.shortname || r.symbol,
                exchange: r.exchDisp || '',
                type: r.typeDisp || r.quoteType || 'Stock',
                isInWatchlist: false,
            }))
            .slice(0, 15);
    } catch (err) {
        console.error('Error in stock search:', err);
        return [];
    }
});
