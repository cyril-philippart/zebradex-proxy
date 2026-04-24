const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const REFRESH_TOKEN = process.env.ZEBRADEX_REFRESH_TOKEN;

app.get("/", (req, res) => {
  res.json({ ok: true, service: "zebradex-proxy" });
});

app.get("/zebradex/value", async (req, res) => {
  try {
    const contextId = req.query.context_id;
    const days = req.query.days || 7;

    if (!contextId) {
      return res.status(400).json({ ok: false, error: "context_id manquant" });
    }

    const tokens = await refreshZebradexToken();
    const cookie = await createZebradexSession(tokens);

    const statsUrl =
      `https://zebradex.fr/stats?type=all` +
      `&perf=${days}d` +
      `&context_id=${encodeURIComponent(contextId)}` +
      `&view=overview` +
      `&sort_mode=default` +
      `&ajax=value_chart` +
      `&days=${days}`;

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
        error: "ZebraDex a renvoyé du HTML au lieu du JSON",
      });
    }

    const json = JSON.parse(text);
    const values = json.data.value;
    const costs = json.data.cost;

    const currentValue = values[values.length - 1];
    const currentCost = costs[costs.length - 1];

    res.json({
      ok: true,
      current_value: currentValue,
      current_cost: currentCost,
      profit: currentValue - currentCost,
      profit_pct: (currentValue - currentCost) / currentCost,
      change: currentValue - values[0],
      change_pct: (currentValue - values[0]) / values[0],
      raw: json.data,
    });

  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

async function refreshZebradexToken() {
  if (!REFRESH_TOKEN) {
    throw new Error("ZEBRADEX_REFRESH_TOKEN manquant");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: "frontend",
    refresh_token: REFRESH_TOKEN,
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

  if (!response.ok || !json.access_token) {
    throw new Error("Refresh token invalide: " + JSON.stringify(json));
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