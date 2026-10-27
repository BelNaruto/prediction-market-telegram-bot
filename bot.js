// Telegram bot for live prediction-market odds. Zero dependencies (Node 18+).
// Powered by the Prediction Markets API: https://rapidapi.com/belchiorarkad-FqvHs2EDOtP/api/prediction-markets
// Support / faster replies: Telegram @pintoflow
const { TELEGRAM_TOKEN, RAPIDAPI_KEY, RAPIDAPI_HOST } = process.env;
const MIN_EDGE = Number(process.env.MIN_EDGE || 0.02);
if (!TELEGRAM_TOKEN || !RAPIDAPI_KEY || !RAPIDAPI_HOST) {
  console.error('Set TELEGRAM_TOKEN, RAPIDAPI_KEY and RAPIDAPI_HOST (see .env.example)');
  process.exit(1);
}

const tg = (method, body) =>
  fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

async function api(path, params = {}) {
  const url = new URL(`https://${RAPIDAPI_HOST}${path}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': RAPIDAPI_HOST } });
  const body = await res.json();
  if (body.error) throw new Error(body.message);
  return body.data;
}

const pct = (p) => `${(p * 100).toFixed(1)}%`;

const commands = {
  async odds(q) {
    const d = await api('/api/markets', { q, limit: 3 });
    if (!d.markets.length) return 'No markets found.';
    return d.markets
      .map((m) => `*${m.title}*\n_${m.venue}_ · ` + m.outcomes.map((o) => `${o.name} ${pct(o.odds.probability)}`).join(' · '))
      .join('\n\n');
  },
  async consensus(q) {
    const d = await api('/api/consensus', { q });
    const lines = d.venues.map((v) => `• ${v.venue}: ${pct(v.probability)} (sim ${v.similarity})`);
    return `*Fair value: ${pct(d.consensus.probability)}*\nVenues disagree by ${d.agreement.spreadPct}%\n${lines.join('\n')}`;
  },
  async arb(q) {
    const d = await api('/api/arbitrage', { q, minEdge: MIN_EDGE, feeAware: 'true', limit: 5 });
    if (!d.opportunities.length) return `No arbitrage above ${pct(MIN_EDGE)}.`;
    return d.opportunities
      .map((o) => `*${o.edgePct}% edge* · ${o.markets[0].title}\n` + o.buy.map((b) => `${b.side} @ ${b.venue} ${b.price}`).join(' + '))
      .join('\n\n');
  },
  async kelly(args) {
    const [p, price, bankroll = '100'] = args.split(/\s+/);
    const d = await api('/api/kelly', { probability: p, price, bankroll, fraction: 0.5 });
    return d.hasEdge
      ? `Half-Kelly stake: *${d.recommendedStake}* of ${bankroll} (EV ${(d.evPerDollarStaked * 100).toFixed(1)}% per $)`
      : 'No edge at this price - do not bet.';
  },
};

const HELP =
  '*Prediction Markets bot*\n/odds <topic>\n/consensus <topic>\n/arb [topic]\n/kelly <your prob> <price> [bankroll]\n/watch [topic] - alert me on arbitrage\n/stop\n\nSupport: @pintoflow';
const watchers = new Map(); // chatId -> { q, seen:Set }

async function handle(msg) {
  const chat = msg.chat.id;
  const [cmd, ...rest] = (msg.text || '').trim().split(/\s+/);
  const arg = rest.join(' ');
  const name = cmd.replace(/^\//, '').split('@')[0];
  try {
    if (name === 'start' || name === 'help') return tg('sendMessage', { chat_id: chat, text: HELP, parse_mode: 'Markdown' });
    if (name === 'watch') { watchers.set(chat, { q: arg || undefined, seen: new Set() }); return tg('sendMessage', { chat_id: chat, text: `Watching for >=${pct(MIN_EDGE)} arbitrage. /stop to cancel.` }); }
    if (name === 'stop') { watchers.delete(chat); return tg('sendMessage', { chat_id: chat, text: 'Stopped.' }); }
    if (commands[name]) {
      const text = await commands[name](arg);
      return tg('sendMessage', { chat_id: chat, text, parse_mode: 'Markdown', disable_web_page_preview: true });
    }
  } catch (e) {
    return tg('sendMessage', { chat_id: chat, text: `Error: ${e.message}` });
  }
}

async function poll() {
  let offset = 0;
  for (;;) {
    const r = await tg('getUpdates', { offset, timeout: 30 }).catch(() => ({ result: [] }));
    for (const u of r.result || []) { offset = u.update_id + 1; if (u.message) handle(u.message); }
  }
}

setInterval(async () => {
  for (const [chat, w] of watchers) {
    try {
      const d = await api('/api/arbitrage', { q: w.q, minEdge: MIN_EDGE, feeAware: 'true', limit: 5 });
      for (const o of d.opportunities) {
        const key = o.markets.map((m) => m.venue + m.title).join('|');
        if (w.seen.has(key)) continue;
        w.seen.add(key);
        await tg('sendMessage', { chat_id: chat, text: `Arbitrage ${o.edgePct}%\n${o.markets[0].title}\n` + o.buy.map((b) => `${b.side} @ ${b.venue} ${b.price}`).join(' + ') });
      }
    } catch (e) { console.error('watch error', e.message); }
  }
}, 90_000);

poll();
