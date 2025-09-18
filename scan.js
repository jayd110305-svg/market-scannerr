// scan.js
// Node >=18. Expects FINNHUB_API_KEY and DISCORD_WEBHOOK as env vars.
// Tunable via GitHub repository secrets: THRESHOLD, MAX_SYMBOLS, BATCH_DELAY_MS, DAYS, COOLDOWN_HOURS.

const fs = require('fs');
const path = require('path');

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const THRESHOLD = parseFloat(process.env.THRESHOLD || '2.5');
const MAX_SYMBOLS = parseInt(process.env.MAX_SYMBOLS || '500'); // tune this
const BATCH_DELAY_MS = parseInt(process.env.BATCH_DELAY_MS || '1200'); // delay between API calls
const DAYS = parseInt(process.env.DAYS || '120'); // history days for indicators
const ALERTS_FILE = path.join(process.cwd(), 'alerts_history.json');

if (!FINNHUB_API_KEY) {
  console.error("Missing FINNHUB_API_KEY env var. Signup at finnhub.io and set repo secret.");
  process.exit(1);
}
if (!DISCORD_WEBHOOK) {
  console.error("Missing DISCORD_WEBHOOK env var. Create a Discord webhook and set secret.");
  process.exit(1);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

async function getSymbols() {
  const url = `https://finnhub.io/api/v1/stock/symbol?exchange=US&token=${FINNHUB_API_KEY}`;
  const data = await fetchJson(url);
  const symbols = data
    .filter(x => x && x.symbol && !x.symbol.includes("."))
    .map(x => x.symbol);
  console.log(`Fetched ${symbols.length} symbols from Finnhub; truncating to ${MAX_SYMBOLS}`);
  return symbols.slice(0, MAX_SYMBOLS);
}

function unixSeconds(d) { return Math.floor(d.getTime()/1000); }

async function fetchCandles(symbol) {
  const to = unixSeconds(new Date());
  const from = unixSeconds(new Date(Date.now() - DAYS * 24*3600*1000));
  const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${from}&to=${to}&token=${FINNHUB_API_KEY}`;
  try {
    const resp = await fetch(url);
    const data = await resp.json();
    if (!data || data.s !== 'ok' || !Array.isArray(data.c)) return null;
    return data.c;
  } catch (e) {
    console.warn("Candle fetch error", symbol, e && e.message);
    return null;
  }
}

function sma(values, n) {
  if (!values || values.length < n) return null;
  const slice = values.slice(values.length - n);
  const s = slice.reduce((a,b)=>a+b, 0);
  return s / n;
}

function emaLast(values, n) {
  if (!values || values.length < n) return null;
  const k = 2/(n+1);
  let prev = values.slice(0, n).reduce((a,b)=>a+b, 0) / n;
  for (let i = n; i < values.length; i++) {
    prev = (values[i] - prev) * k + prev;
  }
  return prev;
}

function rsiLast(values, period=14) {
  if (!values || values.length < period+1) return null;
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const change = values[i] - values[i-1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

async function sendDiscord(embedTitle, embedDesc) {
  const payload = {
    embeds: [
      {
        title: embedTitle,
        description: embedDesc,
        color: 15158332,
        timestamp: new Date().toISOString()
      }
    ]
  };
  const r = await fetch(DISCORD_WEBHOOK, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload)
  });
  if (!r.ok) {
    const text = await r.text();
    console.warn("Discord webhook failed:", r.status, text);
    return false;
  }
  return true;
}

function readAlertsFile() {
  try {
    if (!fs.existsSync(ALERTS_FILE)) {
      fs.writeFileSync(ALERTS_FILE, JSON.stringify({},null,2));
    }
    const raw = fs.readFileSync(ALERTS_FILE, 'utf8');
    return JSON.parse(raw || "{}");
  } catch (e) {
    console.warn("Could not read alerts file, creating new:", e && e.message);
    fs.writeFileSync(ALERTS_FILE, JSON.stringify({},null,2));
    return {};
  }
}

function writeAlertsFile(obj) {
  fs.writeFileSync(ALERTS_FILE, JSON.stringify(obj, null, 2));
}

function computeScore(lastClose, sma10, sma50, rsi14, macdVal, mom5) {
  let score = 0;
  if (sma50 !== null && lastClose > sma50) score += 1.0;
  if (sma10 !== null && sma10 > sma50) score += 1.0;
  if (rsi14 !== null && rsi14 < 70) score += 0.5;
  if (macdVal !== null && macdVal > 0) score += 0.7;
  if (mom5 !== null && mom5 > 0) score += 0.5;
  return Math.round((score) * 1000)/1000;
}

async function main() {
  console.log("Scanner starting", new Date().toISOString());
  const symbols = await getSymbols();
  const alertsHistory = readAlertsFile();
  const alertsSentNow = [];

  for (let i=0;i<symbols.length;i++) {
    const sym = symbols[i];
    try {
      const closes = await fetchCandles(sym);
      if (!closes || closes.length < 30) {
        // skip
      } else {
        const lastClose = closes[closes.length-1];
        const sma10 = sma(closes, 10);
        const sma50 = sma(closes, 50);
        const rsi14 = rsiLast(closes, 14);
        const ema12 = emaLast(closes, 12);
        const ema26 = emaLast(closes, 26);
        const macd = (ema12 !== null && ema26 !== null) ? (ema12 - ema26) : null;
        const mom5 = (closes[closes.length-1] - closes[Math.max(0, closes.length-1-5)]) / closes[Math.max(0, closes.length-1-5)];

        const signalScore = computeScore(lastClose, sma10, sma50, rsi14, macd, mom5);
        const newsSentiment = 0.0; // placeholder - you can add NewsAPI later
        const combined = Math.round((signalScore + newsSentiment)*1000)/1000;

        const cooldownHours = parseFloat(process.env.COOLDOWN_HOURS || '24');
        let canAlert = true;
        if (alertsHistory[sym]) {
          const lastIso = alertsHistory[sym];
          const hrs = (Date.now() - new Date(lastIso).getTime()) / (1000*3600);
          if (hrs < cooldownHours) canAlert = false;
        }

        if (combined >= THRESHOLD && canAlert) {
          const title = `🚨 ${sym} alert — combined ${combined}`;
          const desc = `Close: $${lastClose}\nSignal: ${signalScore}\nRSI: ${rsi14}\nSMA10:${sma10} SMA50:${sma50}\nMACD:${macd}\nMOM5:${Math.round(mom5*10000)/10000}`;
          const ok = await sendDiscord(title, desc);
          if (ok) {
            alertsHistory[sym] = new Date().toISOString();
            alertsSentNow.push(sym);
            console.log("Alerted", sym, combined);
          } else {
            console.warn("Failed to alert", sym);
          }
        }
      }
    } catch (e) {
      console.warn("Error on", sym, e && e.message);
    }

    await sleep(BATCH_DELAY_MS);
  }

  writeAlertsFile(alertsHistory);
  console.log("Done. Alerts sent:", alertsSentNow.length);
}

main().catch(e => {
  console.error("Fatal error", e && e.message);
  process.exit(1);
});
