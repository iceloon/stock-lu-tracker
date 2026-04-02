const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const { createWorker } = require("tesseract.js");

const XUEQIU_UID = "8790885129";
const WEIBO_UID = "3962719063";

const DEFAULT_PINNED_POST_URLS = ["https://xueqiu.com/8790885129/381996320"];
const DEFAULT_XUEQIU_TITLE_REGEX = "游戏仓\\s*20\\d{2}\\s*年\\s*\\d{1,2}\\s*月\\s*PS图";

const ACTION_KEYWORDS = [
  "加仓",
  "减仓",
  "新进仓",
  "新进",
  "新开仓",
  "清仓",
  "持仓不变",
  "增持",
  "减持",
  "买入",
  "卖出",
  "不变"
];

const SYMBOL_PATTERN = "(\\d{6}\\.(?:SH|SZ)|\\d{4,5}\\.HK|\\d{6}|\\d{4,5}|[A-Z]{1,6}(?:\\.[A-Z]{2})?)";

const DEFAULT_AUTO_TRACKING = {
  enabled: true,
  intervalMinutes: 180,
  xueqiuCookie: "",
  weiboCookie: "",
  maxPostsPerSource: 6,
  ocrEnabled: true,
  ocrMaxImagesPerPost: 2,
  pinnedPostUrls: [...DEFAULT_PINNED_POST_URLS],
  xueqiuTitleRegex: DEFAULT_XUEQIU_TITLE_REGEX,
  backfillMaxPages: 36,
  backfillPageSize: 20,
  keywords: ["最新持仓", "调仓", "新开仓", "已清仓", "持仓", "组合"]
};

let ocrWorkerPromise;
const execFileAsync = promisify(execFile);
const OCR_CACHE_MAX_ITEMS = clampNumber(process.env.OCR_CACHE_MAX_ITEMS, 1200, 100, 10000);
const OCR_CACHE_TTL_MINUTES = clampNumber(process.env.OCR_CACHE_TTL_MINUTES, 24 * 60, 10, 14 * 24 * 60);
const OCR_CACHE_TTL_MS = OCR_CACHE_TTL_MINUTES * 60 * 1000;
const ocrTextCache = new Map();

function toDateIso(value) {
  if (!value && value !== 0) {
    return null;
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric) && Math.abs(numeric) > 0) {
    const millis = Math.abs(numeric) < 1e12 ? numeric * 1000 : numeric;
    const fromNumber = new Date(millis);
    if (!Number.isNaN(fromNumber.getTime())) {
      return fromNumber.toISOString();
    }
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function parseNumeric(value) {
  if (!value && value !== 0) {
    return null;
  }

  let cleaned = String(value)
    .replace(/[，,]/g, "")
    .replace(/[−—]/g, "-")
    .replace(/\s+/g, "")
    .replace(/[^0-9+\-.]/g, "")
    .trim();

  if (!cleaned) {
    return null;
  }

  cleaned = cleaned.replace(/\.{2,}$/g, "");
  if (!cleaned) {
    return null;
  }

  const dotCount = (cleaned.match(/\./g) || []).length;
  if (dotCount > 1) {
    const lastDot = cleaned.lastIndexOf(".");
    cleaned = `${cleaned.slice(0, lastDot).replace(/\./g, "")}${cleaned.slice(lastDot)}`;
  }

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function isSampleCookie(cookie) {
  const text = String(cookie || "").trim();
  if (!text) {
    return false;
  }

  const samples = ["abc123", "xyz987", "_2A25Labcde", "Hm_lvt_test"];
  return samples.some((item) => text.includes(item));
}

function getCookieState(cookie) {
  const text = String(cookie || "").trim();
  if (!text) {
    return "missing";
  }
  if (isSampleCookie(text)) {
    return "sample";
  }
  return "ok";
}

function hasUsableCookie(cookie) {
  return getCookieState(cookie) === "ok";
}

function cookieWarnText(sourceLabel, state) {
  if (state === "sample") {
    return `${sourceLabel} Cookie 是示例值，请替换成浏览器里复制的真实登录态`;
  }
  return `${sourceLabel} Cookie 未配置`;
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  const picked = Number.isFinite(number) ? number : fallback;
  return Math.max(min, Math.min(max, picked));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePinnedPostUrls(value) {
  const rawList = Array.isArray(value)
    ? value
    : String(value || "")
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean);

  const urls = [];
  const seen = new Set();

  for (const raw of rawList) {
    const text = String(raw || "").trim();
    if (!text) {
      continue;
    }

    let parsed;
    try {
      parsed = new URL(text);
    } catch {
      continue;
    }

    const normalized = parsed.toString();
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    urls.push(normalized);
  }

  if (urls.length === 0) {
    return [...DEFAULT_PINNED_POST_URLS];
  }

  return urls.slice(0, 30);
}

function normalizeRegexInput(value, fallback) {
  const raw = String(value || "").trim();
  if (!raw) {
    return fallback;
  }

  try {
    void new RegExp(raw, "i");
    return raw;
  } catch {
    return fallback;
  }
}

function mergeAutoTrackingConfig(config) {
  const merged = {
    ...DEFAULT_AUTO_TRACKING,
    ...(config || {})
  };

  merged.intervalMinutes = clampNumber(merged.intervalMinutes, 180, 15, 24 * 60);
  merged.maxPostsPerSource = clampNumber(merged.maxPostsPerSource, 6, 1, 50);
  merged.ocrMaxImagesPerPost = clampNumber(merged.ocrMaxImagesPerPost, 2, 1, 6);
  merged.backfillMaxPages = clampNumber(merged.backfillMaxPages, 36, 1, 120);
  merged.backfillPageSize = clampNumber(merged.backfillPageSize, 20, 5, 50);
  merged.pinnedPostUrls = normalizePinnedPostUrls(merged.pinnedPostUrls);
  merged.xueqiuTitleRegex = normalizeRegexInput(merged.xueqiuTitleRegex, DEFAULT_XUEQIU_TITLE_REGEX);
  merged.keywords = Array.isArray(merged.keywords)
    ? merged.keywords.map((item) => String(item || "").trim()).filter(Boolean)
    : [...DEFAULT_AUTO_TRACKING.keywords];

  return merged;
}

function ensureAutoTrackingState(store) {
  const current = store.autoTracking || {};

  store.autoTracking = {
    config: mergeAutoTrackingConfig(current.config),
    runtime: {
      lastRunAt: current.runtime?.lastRunAt || null,
      lastSuccessAt: current.runtime?.lastSuccessAt || null,
      lastError: current.runtime?.lastError || null,
      nextRunAt: current.runtime?.nextRunAt || null,
      totalImportedSnapshots: Number(current.runtime?.totalImportedSnapshots) || 0,
      totalImportedTrades: Number(current.runtime?.totalImportedTrades) || 0
    },
    processedPostIds: Array.isArray(current.processedPostIds) ? current.processedPostIds : [],
    importedTradeKeys: Array.isArray(current.importedTradeKeys) ? current.importedTradeKeys : [],
    logs: Array.isArray(current.logs) ? current.logs : [],
    latestSnapshot: current.latestSnapshot || null
  };

  return store.autoTracking;
}

function stripHtml(html) {
  const raw = String(html || "");
  return raw
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[|｜]/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function safeJsonParse(text) {
  if (typeof text !== "string" || !text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function shortText(value, max = 160) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

function isLikelySymbol(token) {
  const value = String(token || "").toUpperCase().trim();
  if (!value) {
    return false;
  }

  if (/^\d{6}\.(SH|SZ)$/.test(value)) {
    return true;
  }

  if (/^\d{4,5}\.HK$/.test(value)) {
    return true;
  }

  if (/^[A-Z]{1,6}(\.[A-Z]{2})?$/.test(value)) {
    return true;
  }

  if (/^\d{6}$/.test(value) || /^\d{4,5}$/.test(value)) {
    return true;
  }

  return false;
}

function normalizeAction(actionRaw, changeQty) {
  const action = String(actionRaw || "").trim();

  if (action.includes("加") || action.includes("新进") || action.includes("新开") || action.includes("增")) {
    return "BUY";
  }

  if (action.includes("减") || action.includes("清仓") || action.includes("卖")) {
    return "SELL";
  }

  if (action.includes("持仓不变") || action.includes("不变")) {
    return "HOLD";
  }

  if (Number.isFinite(changeQty)) {
    if (changeQty > 0) {
      return "BUY";
    }
    if (changeQty < 0) {
      return "SELL";
    }
  }

  return "UNKNOWN";
}

function sanitizeName(value) {
  return String(value || "")
    .replace(/[\s|｜]+/g, " ")
    .replace(/^[-–—]+|[-–—]+$/g, "")
    .trim();
}

function buildRowCandidate(input) {
  const symbol = String(input.symbol || "").toUpperCase().trim();
  const name = sanitizeName(input.name || "");
  const actionLabel = String(input.actionLabel || "").trim();
  const changeQty = parseNumeric(input.changeQty);
  const latestCost = parseNumeric(input.latestCost);

  if (!isLikelySymbol(symbol) || symbol.includes("CASH")) {
    return null;
  }

  if (!Number.isFinite(latestCost) || latestCost <= 0) {
    return null;
  }

  const action = normalizeAction(actionLabel, changeQty);
  if (!Number.isFinite(changeQty) && action !== "HOLD") {
    return null;
  }

  if (
    name.includes("代码") ||
    name.includes("股票名称") ||
    name.includes("操作记录") ||
    name.includes("变动股数") ||
    name.includes("最新成本")
  ) {
    return null;
  }

  return {
    symbol,
    name,
    actionLabel,
    action,
    changeQty: Number.isFinite(changeQty) ? changeQty : 0,
    latestCost: Math.abs(latestCost)
  };
}

function dedupeRows(rows) {
  const deduped = [];
  const seen = new Set();

  for (const row of rows) {
    const key = `${row.symbol}|${row.action}|${row.changeQty}|${row.latestCost}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(row);
  }

  return deduped;
}

function normalizeOcrLine(line) {
  return String(line || "")
    .replace(/[|｜]/g, " ")
    .replace(/[，,]/g, " ")
    .replace(/[。；;]/g, " ")
    .replace(/(\d)\s*\.\s*(\d)/g, "$1.$2")
    .replace(/([+\-−])\s+(\d)/g, "$1$2")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function normalizeCodeToken(rawToken) {
  const compact = String(rawToken || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  if (!compact) {
    return null;
  }

  const mapped = compact
    .replace(/[OQDU]/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/Z/g, "2")
    .replace(/S/g, "5")
    .replace(/G/g, "6")
    .replace(/T/g, "7")
    .replace(/B/g, "8");

  if (/^\d{6}$/.test(mapped) || /^\d{4,5}$/.test(mapped)) {
    return mapped;
  }

  return null;
}

function extractRowsFromText(inputText) {
  const rows = [];
  const text = stripHtml(inputText);
  const symbolRegex = new RegExp(SYMBOL_PATTERN, "i");
  const actionRegex = new RegExp(`(${ACTION_KEYWORDS.join("|")})`);
  const lines = text
    .split(/\n+/)
    .map((line) => line.replace(/\s{2,}/g, " ").trim())
    .filter(Boolean);
  const normalizedLines = lines.map((line) => normalizeOcrLine(line)).filter(Boolean);

  const holdingsLineRegex =
    /^(.+?)\s+(\d{4,5}(?:\.HK)?)\s+(-?\d[\d,]*)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)$/i;
  const aShareLineRegex =
    /^(\d{6})\s+(.+?)\s+(-?\d[\d,]*)\s+(-?\d[\d,]*)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*(.*)$/i;

  for (const line of normalizedLines) {
    if (
      line.includes("证券名称") ||
      line.includes("证券代码") ||
      line.includes("可用股份") ||
      line.includes("参考成本价") ||
      line.includes("参考持仓成本") ||
      line.includes("最新市值") ||
      line.includes("盈亏比例")
    ) {
      continue;
    }

    const matched = line.match(holdingsLineRegex);
    if (!matched) {
      continue;
    }

    const name = sanitizeName(matched[1]);
    const symbol = String(matched[2] || "").toUpperCase();
    const holdingQty = parseNumeric(matched[3]);
    const referenceCost = parseNumeric(matched[4]);
    const referenceHoldingCost = parseNumeric(matched[5]);
    const marketValue = parseNumeric(matched[6]);
    const pnlPct = parseNumeric(matched[7]);

    if (
      !isLikelySymbol(symbol) ||
      !Number.isFinite(holdingQty) ||
      !Number.isFinite(referenceCost) ||
      !Number.isFinite(referenceHoldingCost) ||
      !Number.isFinite(marketValue)
    ) {
      continue;
    }

    rows.push({
      symbol,
      name,
      actionLabel: "持仓快照",
      action: "HOLD",
      changeQty: holdingQty,
      latestCost: referenceCost,
      holdingQty,
      referenceCost,
      referenceHoldingCost,
      marketValue,
      pnlPct: Number.isFinite(pnlPct) ? pnlPct : null
    });
  }

  for (const line of normalizedLines) {
    if (
      line.includes("证券代码") ||
      line.includes("证券名称") ||
      line.includes("股票余额") ||
      line.includes("可用余额") ||
      line.includes("成本价") ||
      line.includes("市价") ||
      line.includes("市值") ||
      line.includes("浮动盈亏") ||
      line.includes("盈亏比例") ||
      line.includes("交易市场")
    ) {
      continue;
    }

    const matched = line.match(aShareLineRegex);
    if (!matched) {
      continue;
    }

    const symbol = String(matched[1] || "").toUpperCase();
    const name = sanitizeName(matched[2]);
    const balanceQty = parseNumeric(matched[3]);
    const availableQty = parseNumeric(matched[4]);
    const referenceCost = parseNumeric(matched[5]);
    const latestPrice = parseNumeric(matched[6]);
    const marketValue = parseNumeric(matched[7]);
    const floatingPnl = parseNumeric(matched[8]);
    const pnlPct = parseNumeric(matched[9]);
    const marketName = sanitizeName(matched[10] || "");

    if (
      !isLikelySymbol(symbol) ||
      !Number.isFinite(balanceQty) ||
      !Number.isFinite(referenceCost) ||
      !Number.isFinite(latestPrice) ||
      !Number.isFinite(marketValue)
    ) {
      continue;
    }

    const holdingQty = Number.isFinite(availableQty) ? availableQty : balanceQty;
    const referenceHoldingCost = Number.isFinite(referenceCost) ? referenceCost * holdingQty : null;

    rows.push({
      symbol,
      name,
      actionLabel: "持仓快照",
      action: "HOLD",
      changeQty: holdingQty,
      latestCost: referenceCost,
      holdingQty,
      availableQty,
      balanceQty,
      referenceCost,
      latestPrice,
      referenceHoldingCost,
      marketValue,
      floatingPnl: Number.isFinite(floatingPnl) ? floatingPnl : null,
      pnlPct: Number.isFinite(pnlPct) ? pnlPct : null,
      marketName
    });
  }

  for (const line of normalizedLines) {
    const symbolMatch = line.match(symbolRegex);
    if (!symbolMatch) {
      continue;
    }

    const symbol = symbolMatch[1].toUpperCase();
    const symbolIndex = line.indexOf(symbolMatch[0]);
    const tail = line.slice(symbolIndex + symbolMatch[0].length).trim();

    const actionMatch = tail.match(actionRegex);
    if (!actionMatch) {
      continue;
    }
    const actionLabel = actionMatch[1];

    const numericMatches = [...tail.matchAll(/[+\-−]?\s*\d[\d,，]*(?:\.\d+)?/g)];
    if (numericMatches.length === 0) {
      continue;
    }

    const latestCost = parseNumeric(numericMatches[numericMatches.length - 1][0]);
    let changeQty = parseNumeric(numericMatches[0][0]);

    if (numericMatches.length >= 2) {
      const firstNum = parseNumeric(numericMatches[0][0]);
      const lastNum = parseNumeric(numericMatches[numericMatches.length - 1][0]);
      if (Number.isFinite(firstNum) && Number.isFinite(lastNum) && Math.abs(firstNum) < 1000 && Math.abs(lastNum) > 1000) {
        changeQty = firstNum;
      }
    }

    const nameEnd = actionMatch ? tail.indexOf(actionMatch[1]) : tail.search(/[+\-−]?\s*\d[\d,，]*/);
    const name = nameEnd > 0 ? tail.slice(0, nameEnd) : "";
    const row = buildRowCandidate({
      symbol,
      name,
      actionLabel,
      changeQty,
      latestCost
    });

    if (row) {
      rows.push(row);
    }
  }

  const compact = text.replace(/\s+/g, " ").trim();
  const pattern = new RegExp(
    `${SYMBOL_PATTERN}\\s*([\\u4e00-\\u9fa5A-Za-z0-9*()（）\\-]{0,24})\\s*(${ACTION_KEYWORDS.join("|")})\\s*([+\\-−]?\\s*\\d[\\d,，]*)\\s*([+\\-−]?\\d+(?:\\.\\d+)?)`,
    "gi"
  );

  for (const match of compact.matchAll(pattern)) {
    const row = buildRowCandidate({
      symbol: match[1],
      name: match[2],
      actionLabel: match[3],
      changeQty: match[4],
      latestCost: match[5]
    });

    if (row) {
      rows.push(row);
    }
  }

  for (const line of normalizedLines) {
    if (
      line.includes("证券代码") ||
      line.includes("证券名称") ||
      line.includes("股票余额") ||
      line.includes("可用余额") ||
      line.includes("成本价") ||
      line.includes("市价") ||
      line.includes("市值") ||
      line.includes("浮动盈亏") ||
      line.includes("盈亏比例") ||
      line.includes("交易市场")
    ) {
      continue;
    }

    const tokens = line.split(/\s+/).filter(Boolean);
    if (tokens.length < 7) {
      continue;
    }

    let codeIndex = -1;
    let normalizedCode = null;
    for (let i = 0; i < tokens.length; i += 1) {
      const normalized = normalizeCodeToken(tokens[i]);
      if (normalized && /^\d{6}$/.test(normalized)) {
        codeIndex = i;
        normalizedCode = normalized;
        break;
      }
    }

    if (codeIndex < 0 || !normalizedCode) {
      continue;
    }

    const tailTokens = tokens.slice(codeIndex + 1);
    const firstNumericIndex = tailTokens.findIndex((token) => Number.isFinite(parseNumeric(token)));
    if (firstNumericIndex < 0) {
      continue;
    }

    const name = sanitizeName(tailTokens.slice(0, firstNumericIndex).join(""));
    const numberTokens = tailTokens.slice(firstNumericIndex);
    const numbers = numberTokens.map((item) => parseNumeric(item)).filter((item) => Number.isFinite(item));

    if (!name || numbers.length < 5) {
      continue;
    }

    const balanceQty = numbers[0];
    const availableQty = numbers[1];
    const referenceCost = numbers[2];
    const latestPrice = numbers[3];
    const marketValue = numbers[4];
    const floatingPnl = numbers.length >= 6 ? numbers[5] : null;
    const pnlPct = numbers.length >= 7 ? numbers[6] : null;

    if (
      !Number.isFinite(balanceQty) ||
      !Number.isFinite(referenceCost) ||
      !Number.isFinite(latestPrice) ||
      !Number.isFinite(marketValue)
    ) {
      continue;
    }

    const holdingQty = Number.isFinite(availableQty) ? availableQty : balanceQty;

    rows.push({
      symbol: normalizedCode,
      name,
      actionLabel: "持仓快照",
      action: "HOLD",
      changeQty: holdingQty,
      latestCost: referenceCost,
      holdingQty,
      availableQty,
      balanceQty,
      referenceCost,
      latestPrice,
      referenceHoldingCost: Number.isFinite(referenceCost) ? referenceCost * holdingQty : null,
      marketValue,
      floatingPnl: Number.isFinite(floatingPnl) ? floatingPnl : null,
      pnlPct: Number.isFinite(pnlPct) ? pnlPct : null,
      marketName: ""
    });
  }

  return dedupeRows(rows);
}

function extractImageUrlsFromObject(input) {
  const urls = [];
  const seen = new Set();

  function pushUrl(url) {
    const text = String(url || "").trim();
    if (!/^https?:\/\//i.test(text)) {
      return;
    }
    if (seen.has(text)) {
      return;
    }
    seen.add(text);
    urls.push(text);
  }

  function walk(value) {
    if (!value) {
      return;
    }

    if (typeof value === "string") {
      for (const match of value.matchAll(/https?:\/\/[^\s'"<>]+\.(?:png|jpg|jpeg|webp)/gi)) {
        pushUrl(match[0]);
      }
      for (const match of value.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
        pushUrl(match[1]);
      }
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item);
      }
      return;
    }

    if (typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        const lowerKey = key.toLowerCase();
        if (lowerKey.includes("url") && typeof item === "string") {
          pushUrl(item);
        } else {
          walk(item);
        }
      }
    }
  }

  walk(input);

  return urls;
}

function normalizeImageUrlList(rawList) {
  const urls = [];
  const seen = new Set();

  const push = (value) => {
    const text = String(value || "").trim();
    if (!/^https?:\/\//i.test(text)) {
      return;
    }
    if (!/\.(png|jpg|jpeg|webp)(\?|$)/i.test(text)) {
      return;
    }
    if (seen.has(text)) {
      return;
    }
    seen.add(text);
    urls.push(text);
  };

  if (Array.isArray(rawList)) {
    for (const item of rawList) {
      push(item);
    }
  }

  return urls;
}

function extractXueqiuImageUrls(raw) {
  const directUrls = [];

  if (typeof raw?.firstImg === "string") {
    directUrls.push(raw.firstImg);
  }

  if (typeof raw?.pic === "string") {
    directUrls.push(
      ...raw.pic
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    );
  }

  if (Array.isArray(raw?.image_info_list)) {
    for (const item of raw.image_info_list) {
      if (typeof item === "string") {
        directUrls.push(item);
      } else if (item && typeof item === "object") {
        directUrls.push(
          item.origin_url,
          item.large_url,
          item.url,
          item.pic_url
        );
      }
    }
  }

  if (typeof raw?.cover_pic === "string") {
    directUrls.push(raw.cover_pic);
  }

  const normalizedDirect = normalizeImageUrlList(directUrls);
  if (normalizedDirect.length > 0) {
    return normalizedDirect;
  }

  return extractImageUrlsFromObject(raw);
}

function extractWeiboImageUrls(raw) {
  const directUrls = [];

  if (Array.isArray(raw?.pics)) {
    for (const item of raw.pics) {
      if (typeof item === "string") {
        directUrls.push(item);
      } else if (item && typeof item === "object") {
        directUrls.push(item.large?.url, item.url, item.pic_big?.url, item.bmiddle?.url, item.thumbnail?.url);
      }
    }
  }

  if (raw?.pic_infos && typeof raw.pic_infos === "object") {
    for (const value of Object.values(raw.pic_infos)) {
      if (value && typeof value === "object") {
        directUrls.push(value.largest?.url, value.large?.url, value.bmiddle?.url, value.thumbnail?.url);
      }
    }
  }

  const normalizedDirect = normalizeImageUrlList(directUrls);
  if (normalizedDirect.length > 0) {
    return normalizedDirect;
  }

  return extractImageUrlsFromObject(raw);
}

function buildXueqiuHeaders(cookie, referer) {
  return {
    "User-Agent": "Mozilla/5.0",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Referer: referer || `https://xueqiu.com/u/${XUEQIU_UID}`,
    Origin: "https://xueqiu.com",
    "X-Requested-With": "XMLHttpRequest",
    Cookie: cookie
  };
}

function buildWeiboHeaders(cookie, referer) {
  return {
    "User-Agent": "Mozilla/5.0",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Referer: referer || `https://weibo.com/u/${WEIBO_UID}`,
    Origin: "https://weibo.com",
    "X-Requested-With": "XMLHttpRequest",
    Cookie: cookie
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson(url, options = {}, sourceLabel = "请求") {
  const response = await fetchWithTimeout(url, options);
  const text = await response.text();
  const data = safeJsonParse(text);

  if (!response.ok) {
    const detail = data?.error_description || data?.error || shortText(text) || "未知错误";
    throw new Error(`${sourceLabel}失败 (${response.status}): ${detail}`);
  }

  if (!data) {
    throw new Error(`${sourceLabel}返回非 JSON（可能被风控拦截）`);
  }

  if (data?.error_code) {
    throw new Error(`${sourceLabel}返回错误: ${data.error_description || data.error_code}`);
  }

  return data;
}

function buildXueqiuTitleRegex(config) {
  const text = String(config?.xueqiuTitleRegex || DEFAULT_XUEQIU_TITLE_REGEX).trim();
  try {
    return new RegExp(text, "i");
  } catch {
    return new RegExp(DEFAULT_XUEQIU_TITLE_REGEX, "i");
  }
}

function pickXueqiuStatusPayload(data) {
  if (data?.status && typeof data.status === "object") {
    return data.status;
  }
  if (data?.data?.status && typeof data.data.status === "object") {
    return data.data.status;
  }
  if (data?.id || data?.status_id || data?.description || data?.text) {
    return data;
  }
  return null;
}

function normalizeXueqiuPost(raw, options = {}) {
  const id = String(options.postId || raw?.id || raw?.status_id || raw?.created_at || raw?.title || Math.random());
  const created = raw?.created_at || raw?.time_before || raw?.updated_at;
  const postedAt = toDateIso(created) || new Date().toISOString();
  const title = String(raw?.title || raw?.description_title || "").trim();
  const text = raw?.description || raw?.text || raw?.title || raw?.description_text || "";
  const images = extractXueqiuImageUrls(raw);

  return {
    source: "xueqiu",
    postId: `xq:${id}`,
    title,
    text,
    postedAt,
    images,
    link: options.link || `https://xueqiu.com/${XUEQIU_UID}/${id}`,
    fromPinned: Boolean(options.fromPinned),
    raw
  };
}

function normalizeWeiboPost(raw, options = {}) {
  const id = String(options.postId || raw?.idstr || raw?.id || raw?.mid || raw?.mblogid || Math.random());
  const postedAt = toDateIso(raw?.created_at) || new Date().toISOString();
  const title = String(raw?.title || "").trim();
  const text = raw?.text_raw || raw?.text || "";
  const images = extractWeiboImageUrls(raw);

  return {
    source: "weibo",
    postId: `wb:${id}`,
    title,
    text,
    postedAt,
    images,
    link: options.link || `https://weibo.com/u/${WEIBO_UID}`,
    fromPinned: Boolean(options.fromPinned),
    raw
  };
}

function isLikelyHoldingPost(post, keywords) {
  const text = `${String(post.title || "")}\n${String(post.text || "")}`;
  return keywords.some((kw) => text.includes(kw));
}

function isXueqiuTargetTitlePost(post, titleRegex) {
  if (!post || post.source !== "xueqiu") {
    return false;
  }
  const title = String(post.title || post.raw?.title || "");
  const text = String(post.text || "");
  return titleRegex.test(title) || titleRegex.test(text);
}

function extractXueqiuPostIdFromUrl(rawUrl) {
  if (!rawUrl) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  const queryId = parsed.searchParams.get("id") || parsed.searchParams.get("status_id");
  if (queryId && /^\d{6,}$/.test(queryId)) {
    return queryId;
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const token = parts[i];
    if (/^\d{6,}$/.test(token)) {
      return token;
    }
  }

  return null;
}

function extractWeiboPostIdFromUrl(rawUrl) {
  if (!rawUrl) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  const queryId = parsed.searchParams.get("id") || parsed.searchParams.get("mid");
  if (queryId) {
    return queryId;
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length === 0) {
    return null;
  }

  if (parts[0].toLowerCase() === "u") {
    return null;
  }

  const last = parts[parts.length - 1];
  if (/^[A-Za-z0-9]{6,}$/.test(last)) {
    return last;
  }

  return null;
}

function detectSourceByUrl(rawUrl) {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    if (hostname.includes("xueqiu.com")) {
      return "xueqiu";
    }
    if (hostname.includes("weibo.com") || hostname.includes("weibo.cn")) {
      return "weibo";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

async function fetchXueqiuPostById(postId, config, postUrl) {
  const headers = buildXueqiuHeaders(config.xueqiuCookie, postUrl || `https://xueqiu.com/u/${XUEQIU_UID}`);
  const endpoints = [
    `https://xueqiu.com/statuses/original/show.json?id=${encodeURIComponent(postId)}`,
    `https://xueqiu.com/statuses/show.json?id=${encodeURIComponent(postId)}`
  ];

  const errors = [];
  for (const endpoint of endpoints) {
    try {
      const data = await requestJson(endpoint, { headers }, "雪球帖子详情");
      const payload = pickXueqiuStatusPayload(data);
      if (!payload) {
        throw new Error("返回数据里没有帖子详情");
      }
      return normalizeXueqiuPost(payload, {
        postId,
        link: postUrl,
        fromPinned: true
      });
    } catch (error) {
      errors.push(error.message);
    }
  }

  try {
    const maxPages = 8;
    const pageSize = Math.max(10, Math.min(50, Number(config.backfillPageSize) || 20));
    for (let page = 1; page <= maxPages; page += 1) {
      const list = await fetchXueqiuTimelinePage(config, page, pageSize);
      const matched = list.find((item) => String(item?.id || item?.status_id || "") === String(postId));
      if (matched) {
        return normalizeXueqiuPost(matched, {
          postId,
          link: postUrl,
          fromPinned: true
        });
      }
      if (!Array.isArray(list) || list.length < pageSize) {
        break;
      }
      await sleep(220);
    }
    errors.push("雪球详情接口被风控，且在时间线中未找到指定帖子");
  } catch (error) {
    errors.push(`时间线回退失败: ${error.message}`);
  }

  throw new Error(errors.join(" | "));
}

async function fetchWeiboPostById(postId, config, postUrl) {
  const headers = buildWeiboHeaders(config.weiboCookie, postUrl || `https://weibo.com/u/${WEIBO_UID}`);
  const endpoint = `https://weibo.com/ajax/statuses/show?id=${encodeURIComponent(postId)}`;
  const data = await requestJson(endpoint, { headers }, "微博帖子详情");
  const payload = data?.data && typeof data.data === "object" ? data.data : data;
  return normalizeWeiboPost(payload, {
    postId,
    link: postUrl,
    fromPinned: true
  });
}

async function fetchPinnedPosts(config, addLog) {
  const posts = [];
  const urls = Array.isArray(config.pinnedPostUrls) ? config.pinnedPostUrls : [];

  for (const rawUrl of urls) {
    const url = String(rawUrl || "").trim();
    if (!url) {
      continue;
    }

    const source = detectSourceByUrl(url);
    if (source === "xueqiu") {
      const xqCookieState = getCookieState(config.xueqiuCookie);
      if (xqCookieState !== "ok") {
        addLog("warn", `置顶链接跳过（${cookieWarnText("雪球", xqCookieState)}）: ${url}`);
        continue;
      }

      const postId = extractXueqiuPostIdFromUrl(url);
      if (!postId) {
        addLog("warn", `置顶链接跳过（无法识别雪球帖子ID）: ${url}`);
        continue;
      }

      try {
        const post = await fetchXueqiuPostById(postId, config, url);
        posts.push(post);
        addLog("info", `置顶链接抓取成功（雪球）: ${postId}`);
      } catch (error) {
        addLog("error", `置顶链接抓取失败（雪球）: ${postId} | ${error.message}`);
      }
      continue;
    }

    if (source === "weibo") {
      const wbCookieState = getCookieState(config.weiboCookie);
      if (wbCookieState !== "ok") {
        addLog("warn", `置顶链接跳过（${cookieWarnText("微博", wbCookieState)}）: ${url}`);
        continue;
      }

      const postId = extractWeiboPostIdFromUrl(url);
      if (!postId) {
        addLog("warn", `置顶链接跳过（无法识别微博帖子ID）: ${url}`);
        continue;
      }

      try {
        const post = await fetchWeiboPostById(postId, config, url);
        posts.push(post);
        addLog("info", `置顶链接抓取成功（微博）: ${postId}`);
      } catch (error) {
        addLog("error", `置顶链接抓取失败（微博）: ${postId} | ${error.message}`);
      }
      continue;
    }

    addLog("warn", `置顶链接跳过（暂不支持的站点）: ${url}`);
  }

  return posts;
}

function extractXueqiuTimelineList(data) {
  if (Array.isArray(data?.list)) {
    return data.list;
  }
  if (Array.isArray(data?.statuses)) {
    return data.statuses;
  }
  if (Array.isArray(data?.data?.list)) {
    return data.data.list;
  }
  return [];
}

async function fetchXueqiuTimelinePage(config, page = 1, pageSize = 20) {
  if (!hasUsableCookie(config.xueqiuCookie)) {
    return [];
  }

  const headers = buildXueqiuHeaders(config.xueqiuCookie, `https://xueqiu.com/u/${XUEQIU_UID}`);
  const endpoints = [
    `https://xueqiu.com/statuses/user_timeline.json?user_id=${XUEQIU_UID}&page=${page}&count=${pageSize}`,
    `https://xueqiu.com/statuses/original/user_timeline.json?user_id=${XUEQIU_UID}&page=${page}&count=${pageSize}`
  ];

  const errors = [];
  for (const endpoint of endpoints) {
    try {
      const data = await requestJson(endpoint, { headers }, "雪球时间线");
      return extractXueqiuTimelineList(data);
    } catch (error) {
      errors.push(error.message);
    }
  }

  throw new Error(errors.join(" | "));
}

async function fetchXueqiuPosts(config, options = {}) {
  const pageFrom = clampNumber(options.pageFrom, 1, 1, 999);
  const pageTo = clampNumber(options.pageTo, pageFrom, pageFrom, 999);
  const pageSize = clampNumber(options.pageSize, config.maxPostsPerSource, 1, 50);
  const maxTotal = Number.isFinite(Number(options.maxTotal))
    ? clampNumber(options.maxTotal, pageSize, 1, 5000)
    : null;

  const results = [];
  for (let page = pageFrom; page <= pageTo; page += 1) {
    const list = await fetchXueqiuTimelinePage(config, page, pageSize);
    if (!Array.isArray(list) || list.length === 0) {
      break;
    }

    results.push(...list.map((item) => normalizeXueqiuPost(item)));

    if (maxTotal && results.length >= maxTotal) {
      break;
    }

    if (page < pageTo) {
      await sleep(240);
    }
  }

  return maxTotal ? results.slice(0, maxTotal) : results;
}

async function fetchWeiboPosts(config) {
  if (!hasUsableCookie(config.weiboCookie)) {
    return [];
  }

  const endpoint = `https://weibo.com/ajax/statuses/mymblog?uid=${WEIBO_UID}&page=1&feature=0`;
  const headers = buildWeiboHeaders(config.weiboCookie, `https://weibo.com/u/${WEIBO_UID}`);
  const data = await requestJson(endpoint, { headers }, "微博时间线");

  const list = Array.isArray(data?.data?.list)
    ? data.data.list
    : Array.isArray(data?.list)
      ? data.list
      : [];

  return list.slice(0, config.maxPostsPerSource).map((item) => normalizeWeiboPost(item));
}

function dedupePostsById(posts) {
  const deduped = [];
  const seen = new Set();

  for (const post of posts) {
    if (!post?.postId) {
      continue;
    }

    if (seen.has(post.postId)) {
      continue;
    }

    seen.add(post.postId);
    deduped.push(post);
  }

  return deduped;
}

function buildOcrCacheKey(imageUrl, post) {
  const source = String(post?.source || "unknown").trim().toLowerCase();
  const url = String(imageUrl || "").trim();
  return `${source}|${url}`;
}

function pruneOcrTextCache(now = Date.now()) {
  for (const [key, entry] of ocrTextCache.entries()) {
    const createdAt = Number(entry?.createdAt) || 0;
    if (!createdAt || now - createdAt > OCR_CACHE_TTL_MS) {
      ocrTextCache.delete(key);
    }
  }

  if (ocrTextCache.size <= OCR_CACHE_MAX_ITEMS) {
    return;
  }

  const sorted = [...ocrTextCache.entries()].sort((a, b) => {
    const aUsed = Number(a[1]?.usedAt) || 0;
    const bUsed = Number(b[1]?.usedAt) || 0;
    return aUsed - bUsed;
  });

  const removeCount = ocrTextCache.size - OCR_CACHE_MAX_ITEMS;
  for (let i = 0; i < removeCount; i += 1) {
    const key = sorted[i]?.[0];
    if (key) {
      ocrTextCache.delete(key);
    }
  }
}

function getCachedOcrText(cacheKey) {
  if (!cacheKey) {
    return null;
  }

  const entry = ocrTextCache.get(cacheKey);
  if (!entry) {
    return null;
  }

  const now = Date.now();
  const createdAt = Number(entry.createdAt) || 0;
  if (!createdAt || now - createdAt > OCR_CACHE_TTL_MS) {
    ocrTextCache.delete(cacheKey);
    return null;
  }

  entry.usedAt = now;
  return String(entry.text || "");
}

function setCachedOcrText(cacheKey, text) {
  const normalizedText = String(text || "");
  if (!cacheKey || !normalizedText.trim()) {
    return;
  }

  const now = Date.now();
  ocrTextCache.set(cacheKey, {
    text: normalizedText,
    createdAt: now,
    usedAt: now
  });
  pruneOcrTextCache(now);
}

async function mapWithConcurrency(list, concurrency, worker) {
  const items = Array.isArray(list) ? list : [];
  const maxConcurrency = clampNumber(concurrency, 1, 1, 12);
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const index = nextIndex;
      if (index >= items.length) {
        return;
      }
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(maxConcurrency, items.length) }, () => runWorker())
  );

  return results;
}

async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = createWorker("chi_sim+eng", 1, {
      logger: () => {},
      errorHandler: () => {}
    })
      .then(async (worker) => {
        await worker.setParameters({
          tessedit_pageseg_mode: "6",
          preserve_interword_spaces: "1"
        });
        return worker;
      })
      .catch((error) => {
        ocrWorkerPromise = null;
        throw error;
      });
  }

  return ocrWorkerPromise;
}

function getImageHeadersForPost(post, config) {
  const headers = {
    "User-Agent": "Mozilla/5.0",
    Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
  };

  if (post.source === "xueqiu") {
    headers.Referer = post.link || `https://xueqiu.com/u/${XUEQIU_UID}`;
    if (hasUsableCookie(config.xueqiuCookie)) {
      headers.Cookie = config.xueqiuCookie;
    }
  } else if (post.source === "weibo") {
    headers.Referer = post.link || `https://weibo.com/u/${WEIBO_UID}`;
    if (hasUsableCookie(config.weiboCookie)) {
      headers.Cookie = config.weiboCookie;
    }
  }

  return headers;
}

function getImageFileExt(contentType, imageUrl) {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("png")) {
    return "png";
  }
  if (type.includes("webp")) {
    return "webp";
  }
  if (type.includes("jpeg") || type.includes("jpg")) {
    return "jpg";
  }

  const lowerUrl = String(imageUrl || "").toLowerCase();
  if (lowerUrl.includes(".png")) {
    return "png";
  }
  if (lowerUrl.includes(".webp")) {
    return "webp";
  }
  return "jpg";
}

async function downloadImageToTempFile(imageUrl, post, config) {
  const headers = getImageHeadersForPost(post, config);
  const response = await fetchWithTimeout(
    imageUrl,
    {
      headers
    },
    30000
  );

  if (!response.ok) {
    throw new Error(`图片下载失败 (${response.status})`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const bytes = Buffer.from(arrayBuffer);
  if (bytes.length < 200) {
    throw new Error("图片内容异常（字节过小）");
  }

  const contentType = response.headers.get("content-type");
  const ext = getImageFileExt(contentType, imageUrl);
  const filePath = path.join(
    os.tmpdir(),
    `stock-lu-ocr-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`
  );

  await fs.writeFile(filePath, bytes);
  return filePath;
}

async function extractTextWithOcr(imageUrl, post, config) {
  const cacheKey = buildOcrCacheKey(imageUrl, post);
  const cached = getCachedOcrText(cacheKey);
  if (cached) {
    return cached;
  }

  const localPath = await downloadImageToTempFile(imageUrl, post, config);
  const scaledPath = path.join(
    os.tmpdir(),
    `stock-lu-ocr-upscaled-${Date.now()}-${Math.random().toString(16).slice(2)}.png`
  );

  try {
    const worker = await getOcrWorker();
    const texts = [];

    const baseResult = await worker.recognize(localPath);
    const baseText = String(baseResult?.data?.text || "");
    texts.push(baseText);
    const baseRows = extractRowsFromText(baseText);

    if (baseRows.length === 0) {
      try {
        await execFileAsync("sips", ["-Z", "1600", localPath, "--out", scaledPath]);
        const scaledResult = await worker.recognize(scaledPath);
        texts.push(String(scaledResult?.data?.text || ""));
      } catch {
        // Ignore platform/image preprocessing failures and keep base OCR output.
      }
    }

    const mergedText = texts.filter(Boolean).join("\n");
    setCachedOcrText(cacheKey, mergedText);
    return mergedText;
  } finally {
    await fs.unlink(scaledPath).catch(() => {});
    await fs.unlink(localPath).catch(() => {});
  }
}

async function parseSnapshotFromPost(post, config) {
  const textRows = extractRowsFromText(post.text);
  let parsedRows = textRows;
  let ocrText = "";

  if (parsedRows.length === 0 && config.ocrEnabled && Array.isArray(post.images) && post.images.length > 0) {
    const maxImages = Math.min(config.ocrMaxImagesPerPost, post.images.length);

    for (let i = 0; i < maxImages; i += 1) {
      const imageUrl = post.images[i];
      try {
        const text = await extractTextWithOcr(imageUrl, post, config);
        if (!text || !text.trim()) {
          continue;
        }
        ocrText += `\n${text}`;
        parsedRows = extractRowsFromText(ocrText);
        if (parsedRows.length > 0) {
          break;
        }
      } catch {
        continue;
      }
    }
  }

  if (parsedRows.length === 0) {
    return null;
  }

  return {
    source: post.source,
    postId: post.postId,
    postedAt: post.postedAt,
    link: post.link,
    title: post.title || "",
    rows: parsedRows,
    rawText: stripHtml(post.text),
    ocrText: ocrText.trim(),
    images: Array.isArray(post.images) ? post.images : []
  };
}

async function collectBackfillCandidates(config, addLog, options = {}) {
  const candidates = [];
  const xqCookieState = getCookieState(config.xueqiuCookie);
  if (xqCookieState !== "ok") {
    addLog("warn", `${cookieWarnText("雪球", xqCookieState)}，无法执行历史回溯`);
    return candidates;
  }

  const backfillPages = clampNumber(
    options.backfillPages,
    config.backfillMaxPages,
    1,
    120
  );
  const pageSize = clampNumber(
    options.backfillPageSize,
    config.backfillPageSize,
    5,
    50
  );

  try {
    const posts = await fetchXueqiuPosts(config, {
      pageFrom: 1,
      pageTo: backfillPages,
      pageSize
    });

    addLog("info", `历史回溯拉取完成：共 ${posts.length} 条雪球帖子（${backfillPages} 页内）`);

    const titleRegex = buildXueqiuTitleRegex(config);
    const targetPosts = posts.filter((post) => isXueqiuTargetTitlePost(post, titleRegex));
    addLog("info", `标题匹配「${config.xueqiuTitleRegex}」命中: ${targetPosts.length} 条`);

    candidates.push(...targetPosts);
  } catch (error) {
    addLog("error", `历史回溯拉取失败: ${error.message}`);
  }

  return candidates;
}

async function collectNormalCandidates(config, addLog) {
  const candidates = [];

  if (config.pinnedPostUrls.length > 0) {
    const pinnedPosts = await fetchPinnedPosts(config, addLog);
    if (pinnedPosts.length > 0) {
      addLog("info", `置顶链接拉取成功: ${pinnedPosts.length} 条`);
      candidates.push(...pinnedPosts);
    } else {
      addLog("warn", "置顶链接未抓取到有效帖子");
    }
  } else {
    addLog("warn", "未配置置顶链接，已回退时间线抓取");
  }

  const xqCookieState = getCookieState(config.xueqiuCookie);
  if (xqCookieState !== "ok") {
    addLog("warn", `${cookieWarnText("雪球", xqCookieState)}，已跳过时间线抓取`);
  } else {
    try {
      const posts = await fetchXueqiuPosts(config, {
        pageFrom: 1,
        pageTo: 1,
        pageSize: config.maxPostsPerSource,
        maxTotal: config.maxPostsPerSource
      });
      addLog("info", `雪球时间线拉取成功: ${posts.length} 条`);
      candidates.push(...posts);
    } catch (error) {
      addLog("error", `雪球时间线拉取失败: ${error.message}`);
    }
  }

  const wbCookieState = getCookieState(config.weiboCookie);
  if (wbCookieState !== "ok") {
    addLog("warn", `${cookieWarnText("微博", wbCookieState)}，已跳过时间线抓取`);
  } else {
    try {
      const posts = await fetchWeiboPosts(config);
      addLog("info", `微博时间线拉取成功: ${posts.length} 条`);
      candidates.push(...posts);
    } catch (error) {
      addLog("error", `微博时间线拉取失败: ${error.message}`);
    }
  }

  return candidates;
}

async function collectTargetCandidates(config, targetPostIds, addLog) {
  const candidates = [];
  const allIds = Array.isArray(targetPostIds) ? targetPostIds : [...targetPostIds];
  const xueqiuIds = [];
  const weiboIds = [];

  for (const rawId of allIds) {
    const postId = String(rawId || "").trim();
    if (/^xq:\d{6,}$/i.test(postId)) {
      xueqiuIds.push(postId.slice(3));
      continue;
    }
    if (/^wb:[A-Za-z0-9]{6,}$/i.test(postId)) {
      weiboIds.push(postId.slice(3));
    }
  }

  if (xueqiuIds.length > 0) {
    const xqCookieState = getCookieState(config.xueqiuCookie);
    if (xqCookieState !== "ok") {
      addLog("warn", `${cookieWarnText("雪球", xqCookieState)}，已跳过指定雪球帖子抓取`);
    } else {
      const posts = await mapWithConcurrency(xueqiuIds, 4, async (postId) => {
        try {
          const post = await fetchXueqiuPostById(postId, config, null);
          addLog("info", `指定帖子抓取成功（雪球）: ${postId}`);
          return post;
        } catch (error) {
          addLog("error", `指定帖子抓取失败（雪球）: ${postId} | ${error.message}`);
          return null;
        }
      });
      candidates.push(...posts.filter(Boolean));
    }
  }

  if (weiboIds.length > 0) {
    const wbCookieState = getCookieState(config.weiboCookie);
    if (wbCookieState !== "ok") {
      addLog("warn", `${cookieWarnText("微博", wbCookieState)}，已跳过指定微博帖子抓取`);
    } else {
      const posts = await mapWithConcurrency(weiboIds, 3, async (postId) => {
        try {
          const post = await fetchWeiboPostById(postId, config, null);
          addLog("info", `指定帖子抓取成功（微博）: ${postId}`);
          return post;
        } catch (error) {
          addLog("error", `指定帖子抓取失败（微博）: ${postId} | ${error.message}`);
          return null;
        }
      });
      candidates.push(...posts.filter(Boolean));
    }
  }

  addLog("info", `按选择帖子抓取完成：请求 ${allIds.length} 条，成功 ${candidates.length} 条`);
  return candidates;
}

async function collectSuperLudinggongSnapshots(inputConfig, processedPostIds = [], options = {}) {
  const config = mergeAutoTrackingConfig(inputConfig);
  const processedSet = new Set(processedPostIds);
  const targetPostIds = new Set(
    Array.isArray(options.targetPostIds)
      ? options.targetPostIds.map((item) => String(item || "").trim()).filter(Boolean)
      : []
  );
  const hasTargetPostIds = targetPostIds.size > 0;
  const mode = options.mode === "backfill" ? "backfill" : "normal";

  const logs = [];
  const addLog = (level, message, meta = null) => {
    logs.push({
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      level,
      message,
      meta
    });
  };

  const rawCandidates =
    mode === "backfill"
      ? hasTargetPostIds
        ? await collectTargetCandidates(config, [...targetPostIds], addLog)
        : await collectBackfillCandidates(config, addLog, options)
      : await collectNormalCandidates(config, addLog);

  const titleRegex = buildXueqiuTitleRegex(config);
  const sorted = dedupePostsById(rawCandidates).sort((a, b) => {
    const aTime = new Date(a.postedAt).getTime();
    const bTime = new Date(b.postedAt).getTime();
    return bTime - aTime;
  });

  const snapshots = [];
  let filteredByTitle = 0;

  for (const post of sorted) {
    if (hasTargetPostIds && !targetPostIds.has(post.postId)) {
      continue;
    }

    if (processedSet.has(post.postId)) {
      continue;
    }

    const titleMatched = isXueqiuTargetTitlePost(post, titleRegex);
    if (mode === "backfill" && !hasTargetPostIds && post.source === "xueqiu" && !titleMatched) {
      filteredByTitle += 1;
      continue;
    }

    const shouldTryParse =
      post.source === "xueqiu"
        ? post.fromPinned || titleMatched || hasTargetPostIds
        : post.fromPinned || isLikelyHoldingPost(post, config.keywords) || (Array.isArray(post.images) && post.images.length > 0);

    if (!shouldTryParse) {
      continue;
    }

    const snapshot = await parseSnapshotFromPost(post, config);
    if (!snapshot) {
      continue;
    }

    snapshots.push(snapshot);
  }

  if (hasTargetPostIds && snapshots.length === 0) {
    addLog("warn", `选择导入的帖子未识别到可用持仓：${targetPostIds.size} 条`);
  }

  if (mode === "backfill" && filteredByTitle > 0) {
    addLog("info", `回溯过滤：因标题不匹配跳过 ${filteredByTitle} 条`);
  }

  addLog("info", `识别到可导入快照: ${snapshots.length} 条`);

  return {
    snapshots,
    logs,
    config
  };
}

async function collectSuperLudinggongPostCatalog(inputConfig, options = {}) {
  const config = mergeAutoTrackingConfig(inputConfig);
  const logs = [];
  const addLog = (level, message, meta = null) => {
    logs.push({
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      level,
      message,
      meta
    });
  };

  const rawCandidates = await collectBackfillCandidates(config, addLog, options);
  const titleRegex = buildXueqiuTitleRegex(config);

  const posts = dedupePostsById(rawCandidates)
    .filter((post) => isXueqiuTargetTitlePost(post, titleRegex))
    .sort((a, b) => {
      const aTime = new Date(a.postedAt).getTime();
      const bTime = new Date(b.postedAt).getTime();
      return bTime - aTime;
    })
    .map((post) => ({
      postId: post.postId,
      source: post.source,
      title: post.title || "",
      postedAt: post.postedAt,
      link: post.link,
      imageCount: Array.isArray(post.images) ? post.images.length : 0,
      fromPinned: Boolean(post.fromPinned)
    }));

  addLog("info", `目录可选帖子: ${posts.length} 条`);

  return {
    posts,
    logs,
    config
  };
}

module.exports = {
  DEFAULT_AUTO_TRACKING,
  ensureAutoTrackingState,
  mergeAutoTrackingConfig,
  collectSuperLudinggongSnapshots,
  collectSuperLudinggongPostCatalog
};
