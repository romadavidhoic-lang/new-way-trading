/**
 * Antigravity v4 — Futures Webhook Bot
 *
 * Receives TradingView strategy alerts and executes on Bitget Futures.
 * Handles 7 symbols: BTC, ETH, XRP, SUI, SOL, FARTCOIN, PEPE
 *
 * Run locally : node antigravity-webhook.js
 * Railway     : always-on web service (not cron) — receives live webhooks
 *
 * ─── Required env vars ───────────────────────────────────────────────────────
 * PORT                 Railway injects this automatically
 * WEBHOOK_SECRET       Must match Pine Script "Webhook Secret" input
 * PAPER_TRADING        true (default) | false for live execution
 * PORTFOLIO_VALUE_USD  Starting equity (default: 200)
 * BITGET_API_KEY       Bitget API key (only needed for live trading)
 * BITGET_SECRET_KEY    Bitget secret key
 * BITGET_PASSPHRASE    Bitget passphrase
 *
 * ─── Optional env vars ───────────────────────────────────────────────────────
 * MAX_RISK_PCT         Risk per trade % (default: 1)
 * MAX_LEVERAGE         Max leverage (default: 5)
 * MAX_DAILY_LOSS_PCT   Daily loss kill % (default: 3)
 * MAX_DD_PCT           Max drawdown kill % (default: 15)
 * MAX_TRADES_PER_DAY   Daily trade cap across all symbols (default: 5)
 * COOLDOWN_SECONDS     Per-symbol cooldown after signal (default: 1800 = 30min)
 */

import express from 'express'
import crypto  from 'crypto'
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs'

// ─── Telegram ────────────────────────────────────────────────────────────────

const TG_TOKEN   = process.env.TELEGRAM_TOKEN   || ''
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || ''

async function tg(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML' }),
      signal  : AbortSignal.timeout(8000),
    })
  } catch { /* never crash the bot over a notification */ }
}

async function tgTrade({ sym, action, entry, sl, tp, sizeUSD, leverage, rr, score, mode, orderId }) {
  const dir   = action === 'open_long' ? '📈 LONG' : '📉 SHORT'
  const emoji = mode === 'PAPER' ? '📋' : mode === 'LIVE' ? '🔴' : '❌'
  return tg(
`${emoji} <b>AGv4 Webhook — ${mode}</b>
📌 <b>${sym}</b> ${dir}
💰 Entry:  <b>$${(+entry).toFixed(4)}</b>
🛑 SL:     $${(+sl).toFixed(4)}
🎯 TP:     $${(+tp).toFixed(4)}  (${(+rr).toFixed(2)}R)
💵 Size:   $${(+sizeUSD).toFixed(2)} @ ${leverage}x${score != null ? `\n⭐ Score:  ${score}/8` : ''}
🆔 ${orderId || '—'}`
  )
}

async function tgError(msg) {
  return tg(`❌ <b>AGv4 Webhook — ERROR</b>\n${msg}`)
}

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000')
const CONFIG = {
  webhookSecret   : process.env.WEBHOOK_SECRET   || '',
  paperTrading    : process.env.PAPER_TRADING     !== 'false',
  portfolioUSD    : parseFloat(process.env.PORTFOLIO_VALUE_USD || '200'),
  maxRiskPct      : parseFloat(process.env.MAX_RISK_PCT        || '1'),
  maxLeverage     : parseInt(  process.env.MAX_LEVERAGE        || '5'),
  maxDailyLossPct : parseFloat(process.env.MAX_DAILY_LOSS_PCT  || '3'),
  maxDdPct        : parseFloat(process.env.MAX_DD_PCT          || '15'),
  maxTradesPerDay : parseInt(  process.env.MAX_TRADES_PER_DAY  || '5'),
  cooldownSec     : parseInt(  process.env.COOLDOWN_SECONDS    || '1800'),
  bitget: {
    apiKey    : process.env.BITGET_API_KEY    || '',
    secretKey : process.env.BITGET_SECRET_KEY || '',
    passphrase: process.env.BITGET_PASSPHRASE || '',
    baseUrl   : process.env.BITGET_BASE_URL   || 'https://api.bitget.com',
  },
}

// TradingView ticker → Bitget USDT-FUTURES symbol
const SYMBOL_MAP = {
  'BTCUSDT'      : 'BTCUSDT',
  'ETHUSDT'      : 'ETHUSDT',
  'XRPUSDT'      : 'XRPUSDT',
  'SUIUSDT'      : 'SUIUSDT',
  'SOLUSDT'      : 'SOLUSDT',
  'FARTCOINUSDT' : 'FARTCOINUSDT',
  'PEPEUSDT'     : '1000PEPEUSDT',
  '1000PEPEUSDT' : '1000PEPEUSDT',
}

// ─── In-memory State (resets on restart — fine for paper trading) ─────────────

const state = {
  equity      : CONFIG.portfolioUSD,
  startEquity : CONFIG.portfolioUSD,
  dailyLoss   : 0,
  dailyDate   : todayStr(),
  tradesToday : 0,
  totalTrades : 0,
  cooldowns   : {},    // { symbol: expiresAtMs }
  positions   : {},    // { symbol: { action, entry, sl, tp, sizeUSD } }
}

// ─── File Paths ───────────────────────────────────────────────────────────────

const LOG_JSON = 'ag-webhook-trades.json'
const LOG_CSV  = 'ag-webhook-trades.csv'
const CSV_HDR  = 'Date,Time UTC,Symbol,Action,Entry,SL,TP,SizeUSD,Leverage,Score,RR,Mode,OrderId,Notes'

// ─── Utilities ────────────────────────────────────────────────────────────────

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

function ts() {
  return new Date().toISOString()
}

function resetDailyIfNeeded() {
  const today = todayStr()
  if (state.dailyDate !== today) {
    state.dailyDate   = today
    state.dailyLoss   = 0
    state.tradesToday = 0
    console.log(`[${today}] Daily counters reset`)
  }
}

function resolveSymbol(raw) {
  const clean = raw
    .replace(/^[^:]+:/, '')   // strip exchange prefix (BYBIT:, BINANCE:, etc.)
    .replace(/\.P$/,    '')   // strip .P suffix
    .toUpperCase()
  return SYMBOL_MAP[clean] || (clean.endsWith('USDT') ? clean : clean + 'USDT')
}

function calcRR(entry, sl, tp) {
  const risk   = Math.abs(entry - sl)
  const reward = Math.abs(tp - entry)
  return risk === 0 ? 0 : reward / risk
}

// ─── Logging ─────────────────────────────────────────────────────────────────

function initFiles() {
  if (!existsSync(LOG_CSV)) writeFileSync(LOG_CSV, CSV_HDR + '\n')
}

function logTrade(t) {
  const d   = new Date(t.timestamp)
  const rr  = calcRR(t.entry, t.sl, t.tp).toFixed(2)
  const row = [
    d.toISOString().slice(0, 10),
    d.toISOString().slice(11, 19),
    t.symbol,
    t.action,
    t.entry,
    t.sl,
    t.tp,
    (t.sizeUSD  || 0).toFixed(2),
    t.leverage  || '—',
    t.score     || '—',
    rr,
    t.mode,
    t.orderId   || '—',
    `"${t.notes || ''}"`,
  ].join(',')

  appendFileSync(LOG_CSV, row + '\n')

  let log = []
  if (existsSync(LOG_JSON)) {
    try { log = JSON.parse(readFileSync(LOG_JSON, 'utf8')) } catch {}
  }
  log.push(t)
  writeFileSync(LOG_JSON, JSON.stringify(log.slice(-500), null, 2))
}

// ─── Circuit Breakers ────────────────────────────────────────────────────────

function checkCircuitBreakers(symbol) {
  resetDailyIfNeeded()

  const maxDailyLossUSD = CONFIG.portfolioUSD * (CONFIG.maxDailyLossPct / 100)
  const maxDdUSD        = CONFIG.portfolioUSD * (CONFIG.maxDdPct        / 100)

  if (state.dailyLoss >= maxDailyLossUSD) {
    return { ok: false, reason: `Daily loss limit: $${state.dailyLoss.toFixed(2)} / $${maxDailyLossUSD.toFixed(2)} (${CONFIG.maxDailyLossPct}%)` }
  }

  const currentDD = state.startEquity - state.equity
  if (currentDD >= maxDdUSD) {
    return { ok: false, reason: `Max drawdown: ${(currentDD / state.startEquity * 100).toFixed(1)}% / ${CONFIG.maxDdPct}%` }
  }

  if (state.tradesToday >= CONFIG.maxTradesPerDay) {
    return { ok: false, reason: `Daily trade cap: ${state.tradesToday}/${CONFIG.maxTradesPerDay}` }
  }

  const now          = Date.now()
  const cooldownEnds = state.cooldowns[symbol] || 0
  if (now < cooldownEnds) {
    const secsLeft = Math.ceil((cooldownEnds - now) / 1000)
    return { ok: false, reason: `${symbol} cooldown: ${secsLeft}s remaining` }
  }

  if (state.positions[symbol]) {
    return { ok: false, reason: `${symbol}: position already open` }
  }

  return { ok: true }
}

// ─── Position Sizing ─────────────────────────────────────────────────────────
// Risk 1% of portfolio per trade.
// SL distance % determines how large a notional position to hold.

function calcPositionSize(entry, sl) {
  const riskAmount = CONFIG.portfolioUSD * (CONFIG.maxRiskPct / 100)
  const slPct      = Math.abs(entry - sl) / entry
  if (slPct < 0.0001) return 0
  const notional   = riskAmount / slPct
  const maxSize    = CONFIG.portfolioUSD * CONFIG.maxLeverage
  return Math.min(notional, maxSize)
}

// ─── Bitget USDT-Futures API ─────────────────────────────────────────────────

function signBitget(t, method, path, body) {
  return crypto.createHmac('sha256', CONFIG.bitget.secretKey)
    .update(`${t}${method}${path}${body}`).digest('base64')
}

async function bitgetReq(method, path, bodyObj = null) {
  const t       = Date.now().toString()
  const bodyStr = bodyObj ? JSON.stringify(bodyObj) : ''
  const sig     = signBitget(t, method, path, bodyStr)

  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type'      : 'application/json',
      'ACCESS-KEY'        : CONFIG.bitget.apiKey,
      'ACCESS-SIGN'       : sig,
      'ACCESS-TIMESTAMP'  : t,
      'ACCESS-PASSPHRASE' : CONFIG.bitget.passphrase,
    },
    ...(bodyStr ? { body: bodyStr } : {}),
    signal: AbortSignal.timeout(10000),
  })
  const data = await res.json()
  if (data.code !== '00000') throw new Error(`Bitget ${data.code}: ${data.msg}`)
  return data.data
}

async function setLeverage(symbol, leverage) {
  await bitgetReq('POST', '/api/v2/mix/account/set-leverage', {
    symbol,
    productType : 'USDT-FUTURES',
    marginCoin  : 'USDT',
    leverage    : String(leverage),
    holdSide    : 'long_short',
  })
}

async function placeBitgetOrder(symbol, action, sizeUSD, entry, sl, tp, leverage) {
  const isLong = action === 'open_long'
  const qty    = (sizeUSD * leverage / entry).toFixed(6)

  await setLeverage(symbol, leverage)

  return await bitgetReq('POST', '/api/v2/mix/order/placeOrder', {
    symbol,
    productType            : 'USDT-FUTURES',
    marginMode             : 'isolated',
    marginCoin             : 'USDT',
    side                   : isLong ? 'open_long'  : 'open_short',
    orderType              : 'market',
    size                   : qty,
    tradeSide              : isLong ? 'long' : 'short',
    presetStopLossPrice    : sl.toFixed(10).replace(/\.?0+$/, ''),
    presetStopSurplusPrice : tp.toFixed(10).replace(/\.?0+$/, ''),
  })
}

// ─── Express App ─────────────────────────────────────────────────────────────

const app = express()
app.use(express.json({ limit: '10kb' }))

// ── POST /webhook ─────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const now  = ts()
  const body = req.body || {}
  console.log(`\n[${now}] /webhook ← ${JSON.stringify(body)}`)

  try {
    // 1 ─ Validate secret
    if (CONFIG.webhookSecret && body.secret !== CONFIG.webhookSecret) {
      console.log('  ✗ Invalid secret')
      return res.status(401).json({ error: 'Invalid webhook secret' })
    }

    // 2 ─ Parse required fields
    const { action, symbol: rawSymbol, score, entry, sl, tp } = body
    if (!action || !rawSymbol || entry == null || sl == null || tp == null) {
      return res.status(400).json({ error: 'Required: action, symbol, entry, sl, tp' })
    }

    const symbol = resolveSymbol(rawSymbol)
    const entryN = parseFloat(entry)
    const slN    = parseFloat(sl)
    const tpN    = parseFloat(tp)
    const rr     = calcRR(entryN, slN, tpN)

    // 3 ─ Circuit breakers
    const cb = checkCircuitBreakers(symbol)
    if (!cb.ok) {
      console.log(`  ✗ BLOCKED: ${cb.reason}`)
      logTrade({ timestamp: now, symbol, action, entry: entryN, sl: slN, tp: tpN,
                 sizeUSD: 0, score, mode: 'BLOCKED', notes: cb.reason })
      return res.json({ status: 'blocked', reason: cb.reason })
    }

    // 4 ─ Position sizing
    const sizeUSD  = calcPositionSize(entryN, slN)
    const leverage = CONFIG.maxLeverage

    console.log(`  ✓ ${action.toUpperCase()} ${symbol} @ ${entryN}`)
    console.log(`  ✓ Score: ${score}/8 | Size: $${sizeUSD.toFixed(2)} | Lev: ${leverage}x | R:R: ${rr.toFixed(2)}`)
    console.log(`  ✓ SL: ${slN} | TP: ${tpN}`)

    // 5 ─ Execute
    let orderId = null
    let mode    = 'PAPER'
    let notes   = `Score ${score}/8 | R:R ${rr.toFixed(2)}`

    if (CONFIG.paperTrading) {
      orderId = `PAPER-${Date.now()}`
      console.log(`  📋 PAPER TRADE — ${orderId}`)
      await tgTrade({ sym: symbol, action, entry: entryN, sl: slN, tp: tpN,
                      sizeUSD, leverage, rr, score, mode: 'PAPER', orderId })
    } else {
      try {
        const order = await placeBitgetOrder(symbol, action, sizeUSD, entryN, slN, tpN, leverage)
        orderId = order?.orderId || `LIVE-${Date.now()}`
        mode    = 'LIVE'
        console.log(`  ✅ LIVE ORDER: ${orderId}`)
        await tgTrade({ sym: symbol, action, entry: entryN, sl: slN, tp: tpN,
                        sizeUSD, leverage, rr, score, mode: 'LIVE', orderId })
      } catch (err) {
        mode  = 'ERROR'
        notes = `Order failed: ${err.message}`
        console.error(`  ✗ ${err.message}`)
        await tgError(`${symbol} order failed: ${err.message}`)
      }
    }

    // 6 ─ Update state
    state.tradesToday++
    state.totalTrades++
    state.cooldowns[symbol] = Date.now() + CONFIG.cooldownSec * 1000
    state.positions[symbol] = { action, entry: entryN, sl: slN, tp: tpN, sizeUSD, orderId }

    // 7 ─ Log
    logTrade({ timestamp: now, symbol, action, entry: entryN, sl: slN, tp: tpN,
               sizeUSD, leverage, score, mode, orderId, notes })

    return res.json({ status: 'ok', mode, symbol, action,
                      entry: entryN, sl: slN, tp: tpN,
                      sizeUSD: sizeUSD.toFixed(2), rr: rr.toFixed(2), orderId })

  } catch (err) {
    console.error(`  ✗ Unhandled: ${err.message}`)
    return res.status(500).json({ error: err.message })
  }
})

// ── POST /close — clear position from state (manual override) ─────────────────
app.post('/close', async (req, res) => {
  const { symbol: rawSymbol, secret } = req.body || {}
  if (CONFIG.webhookSecret && secret !== CONFIG.webhookSecret) {
    return res.status(401).json({ error: 'Invalid secret' })
  }
  const symbol = resolveSymbol(rawSymbol || '')
  if (state.positions[symbol]) {
    delete state.positions[symbol]
    delete state.cooldowns[symbol]
    console.log(`[${ts()}] Position cleared: ${symbol}`)
    return res.json({ status: 'ok', symbol, msg: 'Position cleared' })
  }
  return res.json({ status: 'no-op', symbol, msg: 'No open position' })
})

// ── GET /health — status dashboard ───────────────────────────────────────────
app.get('/health', (req, res) => {
  resetDailyIfNeeded()
  const ddPct = ((state.startEquity - state.equity) / state.startEquity * 100).toFixed(2)
  const activeCooldowns = Object.entries(state.cooldowns).reduce((acc, [sym, exp]) => {
    const left = Math.max(0, Math.ceil((exp - Date.now()) / 1000))
    if (left > 0) acc[sym] = `${left}s`
    return acc
  }, {})

  res.json({
    status          : 'ok',
    mode            : CONFIG.paperTrading ? 'PAPER' : 'LIVE',
    portfolio       : CONFIG.portfolioUSD,
    equity          : state.equity.toFixed(2),
    drawdown        : ddPct + '%',
    dailyLoss       : state.dailyLoss.toFixed(2),
    tradesToday     : `${state.tradesToday}/${CONFIG.maxTradesPerDay}`,
    totalTrades     : state.totalTrades,
    openPositions   : Object.keys(state.positions),
    cooldowns       : activeCooldowns,
    uptime          : process.uptime().toFixed(0) + 's',
    riskPerTrade    : CONFIG.maxRiskPct + '%',
    maxLeverage     : CONFIG.maxLeverage + 'x',
    killSwitchAt    : CONFIG.maxDdPct + '%',
    dailyLossLimit  : CONFIG.maxDailyLossPct + '%',
  })
})

app.get('/', (req, res) => {
  res.json({ name: 'Antigravity v4 — Futures Webhook Bot', status: 'running',
             mode: CONFIG.paperTrading ? 'PAPER' : 'LIVE' })
})

// ─── Process-level error guards (prevent Railway container crash) ─────────────

process.on('uncaughtException', (err) => {
  console.error(`[${ts()}] UNCAUGHT EXCEPTION — ${err.message}\n${err.stack}`)
  // Do NOT exit — keep the server running
})

process.on('unhandledRejection', (reason) => {
  console.error(`[${ts()}] UNHANDLED REJECTION — ${reason}`)
  // Do NOT exit — keep the server running
})

// ─── Boot ─────────────────────────────────────────────────────────────────────

initFiles()

app.listen(PORT, () => {
  const sep = '═'.repeat(57)
  console.log(sep)
  console.log('  Antigravity v4 — Futures Webhook Bot')
  console.log(sep)
  console.log(`  Port          : ${PORT}`)
  console.log(`  Mode          : ${CONFIG.paperTrading ? '📋 PAPER TRADING' : '🔴 LIVE TRADING'}`)
  console.log(`  Portfolio     : $${CONFIG.portfolioUSD}`)
  console.log(`  Risk/trade    : ${CONFIG.maxRiskPct}%  ($${(CONFIG.portfolioUSD * CONFIG.maxRiskPct / 100).toFixed(2)})`)
  console.log(`  Max leverage  : ${CONFIG.maxLeverage}x`)
  console.log(`  Max DD kill   : ${CONFIG.maxDdPct}%  ($${(CONFIG.portfolioUSD * CONFIG.maxDdPct / 100).toFixed(2)})`)
  console.log(`  Daily loss    : ${CONFIG.maxDailyLossPct}%  ($${(CONFIG.portfolioUSD * CONFIG.maxDailyLossPct / 100).toFixed(2)})`)
  console.log(`  Max trades/day: ${CONFIG.maxTradesPerDay}`)
  console.log(`  Cooldown      : ${CONFIG.cooldownSec}s per symbol`)
  console.log(sep)
  if (!CONFIG.webhookSecret) console.warn('  ⚠️  WEBHOOK_SECRET not set — all requests accepted!')
  if (!CONFIG.paperTrading && !CONFIG.bitget.apiKey) console.error('  ✗ LIVE mode but BITGET_API_KEY missing!')
  console.log(sep)
})
