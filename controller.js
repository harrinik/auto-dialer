require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const { Queue } = require('bullmq');
const redis = require('./lib/redis');
const pino = require('pino')({ transport: { target: 'pino-pretty' } });

const dialQueue = new Queue('dialer-queue', { connection: redis });

const managerBot = new Telegraf(process.env.MANAGER_BOT_TOKEN);
const adminBot = new Telegraf(process.env.ADMIN_BOT_TOKEN);
const notifBot = new Telegraf(process.env.NOTIF_BOT_TOKEN);

const STATUS_CHANNEL = 'system:status';
const HEARTBEAT_KEY = 'worker:heartbeat';

// ─────────────────────────────────────────────
// STATS
// ─────────────────────────────────────────────
async function getStats() {
    const counts = await dialQueue.getJobCounts('waiting', 'active', 'completed', 'failed');

    return {
        counts,
        leads: parseInt(await redis.get('stat:leads') || '0'),
        answered: parseInt(await redis.get('stat:answered') || '0'),
        noAnswer: parseInt(await redis.get('stat:no_answer') || '0'),
        busy: parseInt(await redis.get('stat:busy') || '0'),
        failed: parseInt(await redis.get('stat:failed') || '0'),
        machine: parseInt(await redis.get('stat:machine') || '0'),
        historySize: await redis.scard('dialed_history'),
        dncSize: await redis.scard('dnc'),
        isPaused: await dialQueue.isPaused(),
        cps: await redis.get('config:cps') || process.env.CPS_LIMIT || '2',
        conc: await redis.get('config:concurrency') || process.env.CONCURRENCY || '25',
    };
}

// ─────────────────────────────────────────────
// WORKER HEALTH CHECK
// ─────────────────────────────────────────────
async function getWorkerStatus() {
    const last = await redis.get(HEARTBEAT_KEY);
    if (!last) return '❌ OFFLINE';

    const diff = Date.now() - parseInt(last);

    if (diff < 10000) return '🟢 HEALTHY';
    if (diff < 30000) return '🟡 SLOW';
    return '🔴 STUCK';
}

// ─────────────────────────────────────────────
// STATUS TEXT
// ─────────────────────────────────────────────
function statusText(s, workerStatus = 'N/A') {
    return (
        `📊 <b>System Status</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🟢 Worker:     <b>${workerStatus}</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🟡 Waiting:    <b>${s.counts.waiting}</b>\n` +
        `🔵 Active:     <b>${s.counts.active}</b>\n` +
        `✅ Completed:  <b>${s.counts.completed}</b>\n` +
        `❌ Failed:     <b>${s.counts.failed}</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📞 Answered:   <b>${s.answered}</b>\n` +
        `🔴 No Answer:  <b>${s.noAnswer}</b>\n` +
        `📵 Busy:       <b>${s.busy}</b>\n` +
        `🤖 Voicemail:  <b>${s.machine}</b>\n` +
        `🏆 Leads:      <b>${s.leads}</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📋 Dialed:     <b>${s.historySize}</b>\n` +
        `🚫 DNC:        <b>${s.dncSize}</b>\n` +
        `⚡ CPS:         <b>${s.cps}</b> | 🔀 Conc: <b>${s.conc}</b>\n` +
        `⏸ Queue:       <b>${s.isPaused ? 'PAUSED' : 'RUNNING'}</b>`
    );
}

// ─────────────────────────────────────────────
// SYSTEM BROADCAST LOOP
// ─────────────────────────────────────────────
async function broadcastSystemStatus() {
    try {
        const s = await getStats();
        const workerStatus = await getWorkerStatus();

        await redis.publish(
            STATUS_CHANNEL,
            JSON.stringify({
                workerStatus,
                queue: s.counts,
                cps: s.cps,
                conc: s.conc,
                leads: s.leads,
                answered: s.answered,
                busy: s.busy,
                failed: s.failed,
            })
        );
    } catch (e) {
        pino.error('Broadcast error:', e.message);
    }
}

// run every 5 seconds
setInterval(broadcastSystemStatus, 5000);

// ─────────────────────────────────────────────
// MANAGER BOT
// ─────────────────────────────────────────────
const mgrMenu = () => Markup.inlineKeyboard([
    [Markup.button.callback('📊 Status', 'mgr:status'), Markup.button.callback('📈 Report', 'mgr:report')],
    [Markup.button.callback('⏸ Pause', 'mgr:pause'), Markup.button.callback('▶️ Resume', 'mgr:resume')],
    [Markup.button.callback('🛑 Stop', 'mgr:stop')],
]);

managerBot.start(ctx =>
    ctx.replyWithHTML(
        `👋 <b>Dialer Manager</b>\nSend .txt or .wav files.`,
        mgrMenu()
    )
);

managerBot.command('status', async ctx => {
    const s = await getStats();
    const w = await getWorkerStatus();
    ctx.replyWithHTML(statusText(s, w), mgrMenu());
});

managerBot.command('pause', async ctx => {
    await dialQueue.pause();
    ctx.reply('⏸ Queue paused');
});

managerBot.command('resume', async ctx => {
    await dialQueue.resume();
    ctx.reply('▶️ Queue resumed');
});

managerBot.command('stop', async ctx => {
    await dialQueue.drain();
    ctx.reply('🛑 Queue cleared');
});

// ─────────────────────────────────────────────
// ADMIN BOT (MINIMAL SAFE VERSION)
// ─────────────────────────────────────────────
adminBot.start(ctx =>
    ctx.reply('🔐 Admin Panel Active')
);

// ─────────────────────────────────────────────
// NOTIFICATION BOT (REAL TIME EVENTS)
// ─────────────────────────────────────────────
const sub = redis.duplicate();

async function initSub() {
    await sub.connect();

    await sub.subscribe(STATUS_CHANNEL, (msg) => {
        try {
            const data = JSON.parse(msg);

            const text =
                `📡 <b>System Update</b>\n` +
                `━━━━━━━━━━━━━━\n` +
                `🟢 Worker: <b>${data.workerStatus || 'N/A'}</b>\n` +
                `📞 Active: <b>${data.queue?.active || 0}</b>\n` +
                `📊 Leads: <b>${data.leads || 0}</b>\n` +
                `📈 Answered: <b>${data.answered || 0}</b>`;

            notifBot.telegram.sendMessage(
                process.env.NOTIF_GROUP_ID,
                text,
                { parse_mode: 'HTML' }
            ).catch(() => { });
        } catch (e) { }
    });
}

initSub();

// ─────────────────────────────────────────────
// ERROR HANDLING
// ─────────────────────────────────────────────
const safeError = (err, ctx) => {
    pino.error(`Telegram error: ${err.message}`);
};

managerBot.catch(safeError);
adminBot.catch(safeError);
notifBot.catch(safeError);

// ─────────────────────────────────────────────
// START BOTS
// ─────────────────────────────────────────────
managerBot.launch().then(() => pino.info('🚀 Manager Bot running'));
adminBot.launch().then(() => pino.info('🚀 Admin Bot running'));
notifBot.launch().then(() => pino.info('🚀 Notification Bot running'));

// ─────────────────────────────────────────────
// SHUTDOWN HANDLERS
// ─────────────────────────────────────────────
process.once('SIGINT', () => {
    managerBot.stop();
    adminBot.stop();
    notifBot.stop();
});

process.once('SIGTERM', () => {
    managerBot.stop();
    adminBot.stop();
    notifBot.stop();
});