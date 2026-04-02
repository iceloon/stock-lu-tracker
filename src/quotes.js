function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toTencentCode(apiSymbol) {
  const symbol = String(apiSymbol || "").toUpperCase();

  if (symbol.endsWith(".SS")) {
    return `sh${symbol.replace(".SS", "")}`;
  }

  if (symbol.endsWith(".SZ")) {
    return `sz${symbol.replace(".SZ", "")}`;
  }

  if (symbol.endsWith(".HK")) {
    const raw = symbol.replace(".HK", "");
    return `hk${raw.padStart(5, "0")}`;
  }

  const usCode = symbol.replace(/-/g, ".");
  return `us${usCode}`;
}

function guessCurrency(apiSymbol, fields) {
  const explicitCurrency = fields.find((item) => /^[A-Z]{3}$/.test(item));
  if (explicitCurrency) {
    return explicitCurrency;
  }

  const symbol = String(apiSymbol || "").toUpperCase();
  if (symbol.endsWith(".HK")) {
    return "HKD";
  }
  if (symbol.endsWith(".SS") || symbol.endsWith(".SZ")) {
    return "CNY";
  }
  return "USD";
}

function parseTencentPayload(rawText) {
  const matched = rawText.match(/=\"([^\"]*)\"/);
  if (!matched) {
    throw new Error("行情返回格式异常");
  }

  return matched[1].split("~");
}

async function fetchOneQuote(apiSymbol) {
  const tencentCode = toTencentCode(apiSymbol);
  const url = `https://qt.gtimg.cn/q=${encodeURIComponent(tencentCode)}&_=${Date.now()}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`行情请求失败 (${response.status})`);
  }

  const rawText = await response.text();
  const fields = parseTencentPayload(rawText);

  const lastPrice = toNumber(fields[3]);
  const previousClose = toNumber(fields[4]);

  if (lastPrice === null) {
    throw new Error("行情源未返回最新价");
  }

  return {
    apiSymbol,
    lastPrice,
    previousClose: previousClose ?? lastPrice,
    currency: guessCurrency(apiSymbol, fields),
    exchange: "",
    shortName: fields[1] || "",
    asOf: new Date().toISOString()
  };
}

async function mapLimit(items, limit, mapper) {
  const queue = [...items];
  const results = [];

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (typeof item === "undefined") {
        continue;
      }
      const output = await mapper(item);
      results.push(output);
    }
  });

  await Promise.all(workers);
  return results;
}

async function refreshQuotes(apiSymbols) {
  const uniqueSymbols = [...new Set(apiSymbols.filter(Boolean))];

  const results = await mapLimit(uniqueSymbols, 4, async (apiSymbol) => {
    try {
      const payload = await fetchOneQuote(apiSymbol);
      return { ok: true, apiSymbol, payload };
    } catch (error) {
      return { ok: false, apiSymbol, error: error.message };
    }
  });

  const quotesBySymbol = {};
  const updated = [];
  const failed = [];

  for (const item of results) {
    if (item.ok) {
      quotesBySymbol[item.apiSymbol] = item.payload;
      updated.push(item.apiSymbol);
    } else {
      failed.push({
        apiSymbol: item.apiSymbol,
        reason: item.error
      });
    }
  }

  return {
    quotesBySymbol,
    updated,
    failed
  };
}

module.exports = {
  refreshQuotes
};
