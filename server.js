const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

// Cache mémoire par clé : contextId + days
const cache = new Map();
const CACHE_TTL_MS = 60 * 1000; // 60 secondes

app.get("/", (req, res) => {
  res.json({ ok: true, service: "zebradex-proxy" });
});

app.get("/zebradex/value", async (req, res) => {
  try {
    const contextId = req.query.context_id;
    const days = Number(req.query.days || 7);

    if (!contextId) {
      return res.status(400).json({
        ok: false,
        error: "context_id manquant",
      });
    }

    if (!days || days < 1) {
      return res.status(400).json({
        ok: false,
        error: "days invalide",
      });
    }

    const cacheKey = `${contextId}_${days}`;
    const cached = cache.get(cacheKey);
    const now = Date.now();

    if (cached && now - cached.timestamp < CACHE_TTL_MS) {
      return res.json({
        ...cached.data,
        cached: true,
      });
    }

    const tokens = await loginZebradex();
    const cookie = await createZebradexSession(tokens);

    const statsUrl =
      "https://zebradex.fr/stats?type=all" +
      "&perf=" + encodeURIComponent(days + "d") +
      "&context_id=" + encodeURIComponent(contextId) +
      "&view=overview" +
      "&sort_mode=default" +
      "&ajax=value_chart" +
      "&days=" + encodeURIComponent(days);

    const statsRes = await fetch(statsUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json",
        "Cookie": cookie,
      },
    });

    const text = await statsRes.text();

    if (text.startsWith("<")) {
      return res.status(401).json({
        ok: false,
        error: "ZEBRADEX_HTML_RESPONSE",
      });
    }

    const json = JSON.parse(text);

    if (!json.ok || !json.data || !json.data.value || !json.data.cost) {
      return res.status(500).json({
        ok: false,
        error: "ZEBRADEX_DATA_INVALID",
        raw: json,
      });
    }

    const values = json.data.value;
    const costs = json.data.cost;

    const currentValue = values[values.length - 1];
    const currentCost = costs[costs.length - 1];

    const previousValue = values[values.length - 2];
    const startValue = values[0];

    const profit = currentValue - currentCost;
    const profitPct = currentCost ? profit / currentCost : null;

    const change1D = previousValue ? currentValue - previousValue : null;
    const change1DPct = previousValue ? change1D / previousValue : null;

    const changePeriod = currentValue - startValue;
    const changePeriodPct = startValue ? changePeriod / startValue : null;

    const result = {
      ok: true,
      cached: false,
      days,

      current_value: currentValue,
      current_cost: currentCost,

      profit,
      profit_pct: profitPct,

      change_1d: change1D,
      change_1d_pct: change1DPct,

      change_period: changePeriod,
      change_period_pct: changePeriodPct,

      raw: json.data,
    };

    cache.set(cacheKey, {
      timestamp: now,
      data: result,
    });

    return res.json(result);

  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

async function loginZebradex() {
  const username = process.env.ZEBRADEX_USERNAME;
  const password = process.env.ZEBRADEX_PASSWORD;

  if (!username || !password) {
    throw new Error("ZEBRADEX_USERNAME ou ZEBRADEX_PASSWORD manquant");
  }

  const body = new URLSearchParams({
    grant_type: "password",
    client_id: "frontend",
    username,
    password,
    scope: "openid email profile",
  });

  const response = await fetch(
    "https://auth.zebradex.fr/realms/zebradex/protocol/openid-connect/token",
    {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    }
  );

  const json = await response.json();

  if (!response.ok || !json.access_token || !json.id_token) {
    throw new Error("LOGIN_ZEBRADEX_FAILED: " + JSON.stringify(json));
  }

  return json;
}

async function createZebradexSession(tokens) {
  const response = await fetch("https://zebradex.fr/store_token.php", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0",
    },
    body: JSON.stringify({
      token: tokens.access_token,
      id_token: tokens.id_token,
    }),
  });

  const setCookie = response.headers.get("set-cookie");

  if (!setCookie) {
    throw new Error("Aucun cookie reçu de ZebraDex");
  }

  const match = setCookie.match(/PHPSESSID=[^;]+/);

  if (!match) {
    throw new Error("PHPSESSID introuvable");
  }

  return match[0];
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});