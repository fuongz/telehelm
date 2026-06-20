import { Markup, type Context, type Telegraf } from 'telegraf';
import * as d from './docker';
import log from './logger';

// Verbs that mutate state require a second tap to confirm.
type Verb = 'start' | 'stop' | 'restart';
const ACTIONS: Record<Verb, (id: string) => Promise<void>> = {
  start: d.start,
  stop: d.stop,
  restart: d.restart,
};
const isVerb = (s: string): s is Verb => s in ACTIONS;

const STATE_EMOJI: Record<string, string> = {
  running: '🟢',
  exited: '🔴',
  paused: '🟡',
  created: '⚪',
  dead: '⚫',
};

type Keyboard = ReturnType<typeof Markup.inlineKeyboard>;

function fmtBytes(n: number | undefined): string {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / Math.pow(1024, i)).toFixed(1)} ${u[i]}`;
}

// Safely edit the message a callback came from; fall back to a fresh reply.
async function render(ctx: Context, text: string, keyboard?: Keyboard): Promise<void> {
  const extra = { parse_mode: 'Markdown' as const, ...(keyboard || {}) };
  try {
    if (ctx.updateType === 'callback_query') {
      await ctx.editMessageText(text, extra);
    } else {
      await ctx.reply(text, extra);
    }
  } catch (e) {
    // "message is not modified" and similar are non-fatal.
    const msg = e instanceof Error ? e.message : String(e);
    if (!/not modified/i.test(msg)) {
      await ctx.reply(text, extra).catch(() => {});
    }
  }
}

// ---- Views ----------------------------------------------------------------

async function listView(ctx: Context): Promise<void> {
  const containers = await d.listContainers();
  if (containers.length === 0) {
    return render(ctx, 'No containers found.');
  }
  containers.sort((a, b) => a.name.localeCompare(b.name));
  const rows = containers.map((c) => [
    Markup.button.callback(`${STATE_EMOJI[c.state] || '⚪'} ${c.name}`, `c:${c.id}`),
  ]);
  rows.push([Markup.button.callback('🔄 Refresh', 'ps')]);
  return render(ctx, '*Containers* — tap one to manage:', Markup.inlineKeyboard(rows));
}

async function menuView(ctx: Context, id: string): Promise<void> {
  const c = await d.inspect(id);
  const running = c.state === 'running';
  const kb = [
    [Markup.button.callback('📄 Logs', `a:logs:${id}`), Markup.button.callback('📊 Stats', `a:stats:${id}`)],
    running
      ? [Markup.button.callback('⏹️ Stop', `a:stop:${id}`), Markup.button.callback('🔄 Restart', `a:restart:${id}`)]
      : [Markup.button.callback('▶️ Start', `a:start:${id}`)],
    [Markup.button.callback('⬅️ Back', 'ps')],
  ];
  const text = `*${c.name}*\nState: ${STATE_EMOJI[c.state] || ''} ${c.state}\nImage: \`${c.image}\``;
  return render(ctx, text, Markup.inlineKeyboard(kb));
}

async function confirmView(ctx: Context, verb: Verb, id: string): Promise<void> {
  const c = await d.inspect(id);
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback(`✅ Yes, ${verb}`, `do:${verb}:${id}`), Markup.button.callback('❌ Cancel', `c:${id}`)],
  ]);
  return render(ctx, `Confirm *${verb}* on *${c.name}*?`, kb);
}

async function logsView(ctx: Context, id: string): Promise<void> {
  const { name, text } = await d.logs(id, 100);
  const trimmed = (text || '(no output)').slice(-3500);
  const body = `*Logs — ${name}* (last 100 lines)\n\`\`\`\n${trimmed}\n\`\`\``;
  const kb = Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', `c:${id}`)]]);
  return render(ctx, body, kb);
}

async function statsView(ctx: Context, id: string): Promise<void> {
  const s = await d.stats(id);
  const kb = Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', `c:${id}`)]]);
  if (!s.running) {
    return render(ctx, `*${s.name}* is not running — no stats.`, kb);
  }
  const text =
    `*Stats — ${s.name}*\n` +
    `CPU: ${s.cpuPct!.toFixed(1)}%\n` +
    `Mem: ${fmtBytes(s.memUsed)} / ${fmtBytes(s.memLimit)} (${s.memPct!.toFixed(1)}%)`;
  return render(ctx, text, kb);
}

async function execute(ctx: Context, verb: Verb, id: string): Promise<void> {
  const from = ctx.from;
  const who = { userId: from ? String(from.id) : 'unknown', username: from?.username };
  let name = id;
  try {
    const info = await d.inspect(id);
    name = info.name;
    await ACTIONS[verb](id);
    log.audit({ ...who, action: verb, target: name, result: 'ok' });
    await ctx.answerCbQuery(`${verb} ✓`).catch(() => {});
    // Brief pause so Docker settles, then show refreshed menu.
    await new Promise((r) => setTimeout(r, 600));
    return menuView(ctx, id);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    log.audit({ ...who, action: verb, target: name, result: 'error', detail });
    await ctx.answerCbQuery('Failed').catch(() => {});
    const kb = Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', `c:${id}`)]]);
    return render(ctx, `⚠️ *${verb}* on *${name}* failed:\n\`${detail}\``, kb);
  }
}

// ---- Registration ---------------------------------------------------------

export function register(bot: Telegraf<Context>): void {
  bot.start((ctx) =>
    ctx.reply('Docker control bot ready. Use /ps to list and manage containers, /help for commands.')
  );

  bot.help((ctx) =>
    ctx.reply(
      [
        '*Commands*',
        '/ps — list containers, then tap to manage',
        '',
        'From a container you can view Logs, Stats, and Start/Stop/Restart.',
        'Lifecycle actions ask for confirmation first.',
      ].join('\n'),
      { parse_mode: 'Markdown' }
    )
  );

  bot.command('ps', listView);

  // Single callback router for all inline-button taps.
  bot.on('callback_query', async (ctx) => {
    const data = 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : '';
    try {
      if (data === 'ps') {
        await ctx.answerCbQuery().catch(() => {});
        return listView(ctx);
      }
      const [kind, a, b] = data.split(':');

      if (kind === 'c' && a) {
        await ctx.answerCbQuery().catch(() => {});
        return menuView(ctx, a);
      }
      if (kind === 'a' && a && b) {
        const verb = a;
        const id = b;
        if (verb === 'logs') {
          await ctx.answerCbQuery('Fetching…').catch(() => {});
          return logsView(ctx, id);
        }
        if (verb === 'stats') {
          await ctx.answerCbQuery('Sampling…').catch(() => {});
          return statsView(ctx, id);
        }
        if (isVerb(verb)) {
          await ctx.answerCbQuery().catch(() => {});
          return confirmView(ctx, verb, id);
        }
      }
      if (kind === 'do' && a && b && isVerb(a)) {
        return execute(ctx, a, b);
      }
      await ctx.answerCbQuery().catch(() => {});
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error('callback_error', { data, error: msg });
      await ctx.answerCbQuery('Error').catch(() => {});
      await ctx.reply(`⚠️ Error: ${msg}`).catch(() => {});
    }
  });
}
