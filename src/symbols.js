function cleanRawSymbol(raw) {
  return String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/^SH/, "")
    .replace(/^SZ/, "")
    .replace(/^HK/, "");
}

function inferMarket(rawSymbol) {
  const symbol = cleanRawSymbol(rawSymbol);

  if (/^\d{6}$/.test(symbol)) {
    return "CN";
  }

  if (/^\d{4,5}$/.test(symbol)) {
    return "HK";
  }

  return "US";
}

function toApiSymbol(rawSymbol, marketInput) {
  if (!rawSymbol) {
    return "";
  }

  const original = String(rawSymbol).trim().toUpperCase();

  if (/\.(SS|SZ|HK)$/.test(original)) {
    return original;
  }

  const market = (marketInput || inferMarket(original)).toUpperCase();
  const symbol = cleanRawSymbol(original);

  if (market === "CN") {
    if (!/^\d{6}$/.test(symbol)) {
      return original;
    }
    const suffix = symbol.startsWith("6") || symbol.startsWith("9") ? "SS" : "SZ";
    return `${symbol}.${suffix}`;
  }

  if (market === "HK") {
    if (!/^\d{4,5}$/.test(symbol)) {
      return original;
    }
    return `${symbol.padStart(4, "0")}.HK`;
  }

  return original.replace(".", "-");
}

function normalizeMarket(rawSymbol, marketInput) {
  if (marketInput) {
    return String(marketInput).toUpperCase();
  }
  return inferMarket(rawSymbol);
}

module.exports = {
  inferMarket,
  toApiSymbol,
  normalizeMarket,
  cleanRawSymbol
};
