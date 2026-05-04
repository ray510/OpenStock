# Stock Data 儲存方案分析：MongoDB vs Supabase

> 文件日期：2026-05-02  
> 適用專案：OpenStock（Next.js 15 + Mongoose + Better Auth + Inngest）

---

## 目錄

1. [現有架構概覽](#1-現有架構概覽)
2. [Stock Data 分類與需求](#2-stock-data-分類與需求)
3. [MongoDB 方案](#3-mongodb-方案)
4. [Supabase 方案](#4-supabase-方案)
5. [比較總覽](#5-比較總覽)
6. [建議決策](#6-建議決策)
7. [MongoDB 實作設計（推薦方案）](#7-mongodb-實作設計推薦方案)

---

## 1. 現有架構概覽

### 現時依賴

| 元件 | 技術 |
|------|------|
| 框架 | Next.js 15 (App Router) |
| ORM / DB Client | Mongoose 8 + MongoDB Driver 6 |
| 認證 | Better Auth（使用 `mongodbAdapter`） |
| Background Job | Inngest（cron 每 5 分鐘執行） |
| 數據來源 | Finnhub API |
| 郵件 | Nodemailer |

### 現有 MongoDB Collections

```
watchlists        — 用戶 watchlist（symbol + userId）
alerts            — 用戶股票提醒（targetPrice, condition, triggered）
user / session    — Better Auth 認證資料
```

### 現有 Stock Data Flow（未有 DB 持久化）

```
User request
     ↓
Finnhub API（quote / profile / news）
     ↓
Next.js cache（force-cache / no-store）
     ↓
前端顯示（不寫入 MongoDB）
```

---

## 2. Stock Data 分類與需求

| 類型 | 更新頻率 | 資料量 | 用途 |
|------|---------|--------|------|
| Company Profile（公司資料） | 每日 1 次 | 低 | 名稱、logo、交易所、幣別 |
| Latest Quote（最新報價） | 每 1–5 分鐘 | 中 | Watchlist 顯示、Alert 觸發 |
| Historical Snapshots（歷史快照） | 定時紀錄 | 高 | 走勢圖、分析 |
| News（新聞快取） | 每 5–30 分鐘 | 中 | 新聞頁面、每週 Email |

---

## 3. MongoDB 方案

### 優點

#### ✅ 現有架構完全相容
- `mongoose` 及 `mongodb` 已在 `package.json` 安裝
- `connectToDatabase()` 已封裝好，所有 Server Action 直接 `await connectToDatabase()` 即可
- Better Auth 已使用 `mongodbAdapter`，**唔可以輕易換走 MongoDB**（否則要重建認證層）
- Inngest `checkStockAlerts` 已直接讀寫 MongoDB，保持一致

#### ✅ Schema 靈活（適合 Stock Data）
Stock API 回傳嘅欄位不穩定（不同股票有不同欄位），MongoDB 無 schema 限制，可直接儲存：

```json
{
  "symbol": "AAPL",
  "price": 189.98,
  "extraFields": { "peRatio": 28.1, "52wHigh": 200 }
}
```

#### ✅ Upsert 操作原生支援
Quote cache 最適合用 upsert pattern：

```typescript
await StockQuote.findOneAndUpdate(
  { symbol },
  { price, change, updatedAt: new Date() },
  { upsert: true, new: true }
);
```

#### ✅ TTL Index 自動清理舊資料
Historical snapshots 可以設定自動過期：

```typescript
capturedAt: { type: Date, index: { expireAfterSeconds: 7776000 } } // 90 日
```

#### ✅ 部署成本低
現有 MongoDB Atlas 連線已設定，無需新增服務。

### 缺點

#### ⚠️ 無內建 Realtime Subscription
如要做 WebSocket 實時推送價格，需要自行用 Change Streams 或第三方方案。

#### ⚠️ 查詢 Time-Series 效能較弱
大量歷史快照（時間序列）查詢，性能不及 TimescaleDB 或 InfluxDB，但對 OpenStock 規模已足夠。

#### ⚠️ 無內建 Dashboard / Studio
需借助 MongoDB Atlas UI 或 Compass，不如 Supabase 的 Table Editor 直觀。

---

## 4. Supabase 方案

### 優點

#### ✅ 內建 Realtime
Supabase Realtime 可直接推送 stock price 更新至前端，適合 live quote display：

```typescript
supabase.channel('stock_quotes')
  .on('postgres_changes', { event: 'UPDATE', table: 'stock_quotes' }, callback)
  .subscribe();
```

#### ✅ 內建 Row Level Security（RLS）
Watchlist / Alert 等 user-scoped 資料可用 RLS policy 保護，減少 backend 驗證代碼。

#### ✅ SQL 查詢能力
歷史快照可用 SQL 做複雜聚合：

```sql
SELECT symbol, AVG(price) as avg_price, DATE_TRUNC('hour', captured_at) as hour
FROM stock_price_snapshots
WHERE symbol = 'AAPL'
GROUP BY symbol, hour
ORDER BY hour DESC;
```

#### ✅ 內建 Table Editor / Dashboard
開發期間可直接在 Supabase Studio 瀏覽、編輯資料。

#### ✅ TimescaleDB 擴展
Supabase PostgreSQL 可啟用 TimescaleDB extension，針對時間序列資料優化。

### 缺點

#### ❌ 需要重建整個 DB 層（成本極高）

要引入 Supabase，需要：

1. 移除 `mongoose` 和 `mongodb` 依賴
2. 重建所有 Mongoose models（`watchlist.model.ts`, `alert.model.ts`）為 SQL table + TypeScript types
3. 重建 `connectToDatabase()`
4. **替換 Better Auth adapter**：由 `mongodbAdapter` 換成 `postgresAdapter`，需要重新 migrate 用戶資料
5. 重建所有 Server Actions（`watchlist.actions.ts`, `alert.actions.ts`, `finnhub.actions.ts`）
6. Inngest functions 全部要改

**預計改動涉及整個 `database/`、`lib/` 目錄，風險極高。**

#### ❌ 多一個付費服務
Supabase 免費計劃有限制（500MB storage, 50MB DB），Production 需要 $25/月起。
現有 MongoDB Atlas 免費 512MB 已可使用。

#### ❌ Schema 較嚴格
Stock API 回傳嘅結構不固定，Supabase PostgreSQL 需要預先定義所有欄位，靈活性較低。

#### ❌ Better Auth mongodbAdapter 已深度整合
Better Auth 的 session、user、account collections 全部存在 MongoDB。
換 Supabase 需要整個 Auth 系統 migration，難度高。

---

## 5. 比較總覽

| 比較項目 | MongoDB（現有） | Supabase（新引入） |
|---------|--------------|----------------|
| 現有整合度 | ✅ 完全整合 | ❌ 需重建整個 DB 層 |
| Better Auth 相容性 | ✅ 原生 mongodbAdapter | ⚠️ 需換 adapter + migrate |
| Inngest 整合 | ✅ 直接用 | ⚠️ 需重建所有 step |
| Stock Data Schema 靈活性 | ✅ 靈活（無 schema 限制） | ⚠️ 需預定義欄位 |
| Upsert / Cache Pattern | ✅ 原生 upsert | ✅ ON CONFLICT DO UPDATE |
| TTL / 自動過期 | ✅ TTL Index | ⚠️ 需 pg_cron 或手動清除 |
| Realtime 推送 | ⚠️ 需 Change Streams | ✅ 內建 Realtime |
| 時間序列查詢 | ⚠️ 尚可（需合理 index） | ✅ 可用 TimescaleDB |
| SQL 複雜聚合 | ⚠️ Aggregation Pipeline | ✅ 原生 SQL |
| Dashboard / Studio | ⚠️ Atlas / Compass | ✅ Supabase Studio |
| 免費額度 | ✅ Atlas 512MB free | ⚠️ 500MB / 50MB DB |
| 引入成本 | ✅ 零改動 | ❌ 極高（重建整個 DB 層） |
| 部署複雜度 | ✅ 現有 MONGODB_URI | ⚠️ 新增多個 env vars |
| 適合階段 | ✅ 現在即可 | ⚠️ 適合重新設計時考慮 |

---

## 6. 建議決策

### 結論：**保留 MongoDB，延伸 Stock Data 儲存**

> 理由：Better Auth 已深度綁定 `mongodbAdapter`，整個認證層、session、watchlist、alert 全部在 MongoDB。
> 引入 Supabase 需要重建整個 DB 層及認證系統，成本遠超收益。
> **MongoDB 完全能夠支援 OpenStock 所需的 stock data 儲存需求。**

**Supabase 的主要優勢（Realtime + TimescaleDB）對 OpenStock 現階段非必需：**

- Realtime：Inngest cron 每 5 分鐘更新，前端 polling 或 Next.js revalidation 已足夠
- TimescaleDB：OpenStock 規模（數十到數百支股票）MongoDB TTL + index 完全應付

---

## 7. MongoDB 實作設計（推薦方案）

### 建議新增 Collections

#### 7.1 `stocks` — 公司 Profile Cache

```typescript
// database/models/stock.model.ts

interface IStock extends Document {
    symbol: string;          // 'AAPL'
    name: string;            // 'Apple Inc.'
    exchange: string;        // 'NASDAQ'
    currency: string;        // 'USD'
    logo?: string;           // 'https://...'
    marketCap?: number;      // 3000000000000
    lastFetchedAt: Date;     // 上次 Finnhub 取得時間
}
```

更新策略：

- 由 `getCompanyProfile()` 回傳時寫入
- Stale threshold：24 小時
- Upsert on `symbol`

---

#### 7.2 `stock_quotes` — 最新報價 Cache

```typescript
// database/models/stock-quote.model.ts

interface IStockQuote extends Document {
    symbol: string;          // 'AAPL'
    price: number;           // 189.98
    change: number;          // 1.25
    changePercent: number;   // 0.66
    currency: string;        // 'USD'
    source: string;          // 'finnhub'
    updatedAt: Date;         // 上次更新時間
}
```

更新策略：

- 由 `getWatchlistData()` 或 `checkStockAlerts` cron 寫入
- Stale threshold：1–5 分鐘
- Upsert on `symbol`（每個 symbol 只保留一筆最新資料）

---

#### 7.3 `stock_price_snapshots` — 歷史快照（可選）

```typescript
// database/models/stock-price-snapshot.model.ts

interface IStockPriceSnapshot extends Document {
    symbol: string;          // 'AAPL'
    price: number;           // 189.98
    change: number;          // 1.25
    changePercent: number;   // 0.66
    capturedAt: Date;        // 快照時間
    source: string;          // 'finnhub'
}
```

更新策略：

- 由 Inngest `checkStockAlerts` cron 每 5 分鐘 insert（不 upsert）
- 僅針對 active watchlist symbols
- TTL index：90 日後自動刪除
- Index：`{ symbol: 1, capturedAt: -1 }`

---

### 建議 Cache-First Pattern（Watchlist Page）

```typescript
// lib/actions/stock.actions.ts

export async function getLatestQuote(symbol: string) {
    await connectToDatabase();

    // 1. 先讀 MongoDB cache
    const cached = await StockQuote.findOne({ symbol });

    if (cached) {
        const ageMs = Date.now() - cached.updatedAt.getTime();
        if (ageMs < 5 * 60 * 1000) {
            return cached; // cache 未過期，直接回傳
        }
    }

    // 2. Stale or missing：call Finnhub
    const quote = await getQuote(symbol);
    if (!quote) return cached ?? null;

    // 3. Update MongoDB cache
    return StockQuote.findOneAndUpdate(
        { symbol },
        { ...quote, symbol, updatedAt: new Date(), source: 'finnhub' },
        { upsert: true, new: true }
    );
}
```

---

### 建議 Inngest 整合（Alert Cron）

現有 `checkStockAlerts` 每 5 分鐘執行，可於同一 step 順帶 upsert quote：

```typescript
// 在 fetch-prices step 後加入

await step.run('update-quote-cache', async () => {
    const { StockQuote } = await import('@/database/models/stock-quote.model');
    await connectToDatabase();

    await Promise.all(
        Object.entries(prices).map(([symbol, price]) =>
            StockQuote.findOneAndUpdate(
                { symbol },
                { symbol, price, updatedAt: new Date(), source: 'finnhub' },
                { upsert: true, new: true }
            )
        )
    );
});
```

---

### 建議新增 `.env` 無需改動

MongoDB 方案完全使用現有 `MONGODB_URI`，無需新增任何環境變數。

---

### 預計受影響文件

| 文件 | 操作 |
|------|------|
| `database/models/stock.model.ts` | 新增 |
| `database/models/stock-quote.model.ts` | 新增 |
| `database/models/stock-price-snapshot.model.ts` | 新增（可選） |
| `lib/actions/stock.actions.ts` | 新增 |
| `lib/actions/finnhub.actions.ts` | 修改（加入 upsert 邏輯） |
| `lib/inngest/functions.ts` | 修改（加入 update-quote-cache step） |
| `lib/actions/watchlist.actions.ts` | 修改（改用 cache-first） |

---

*文件由 GitHub Copilot 根據 OpenStock codebase 分析生成。*
