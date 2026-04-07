require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { Queue } = require('bullmq');
const redis = require('./lib/redis');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const pino = require('pino')({ transport: { target: 'pino-pretty' } });


const dialQueue = new Queue('dialer-queue', { connection: redis });
const managerBot = new Telegraf(process.env.MANAGER_BOT_TOKEN);
const adminBot   = new Telegraf(process.env.ADMIN_BOT_TOKEN);
const notifBot   = new Telegraf(process.env.NOTIF_BOT_TOKEN);

// ─── Shared Helpers ────────────────────────────────────────────────────────────
async function getStats() {
    const counts    = await dialQueue.getJobCounts('waiting', 'active', 'completed', 'failed');
    const leads     = parseInt(await redis.get('stat:leads')     || '0');
    const answered  = parseInt(await redis.get('stat:answered')  || '0');
    const noAnswer  = parseInt(await redis.get('stat:no_answer') || '0');
    const busy      = parseInt(await redis.get('stat:busy')      || '0');
    const failed    = parseInt(await redis.get('stat:failed')    || '0');
    const machine   = parseInt(await redis.get('stat:machine')   || '0');
    const historySize = await redis.scard('dialed_history');
    const dncSize   = await redis.scard('dnc');
    const isPaused  = await dialQueue.isPaused();
    const cps       = await redis.get('config:cps')         || process.env.CPS_LIMIT || '2';
    const conc      = await redis.get('config:concurrency') || process.env.CONCURRENCY || '25';
    return { counts, leads, answered, noAnswer, busy, failed, machine, historySize, dncSize, isPaused, cps, conc };
}

function statusText(s) {
    return (
        `📊 <b>System Status</b>\n` +
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
        `📋 Total Dialed: <b>${s.historySize}</b>\n` +
        `🚫 DNC List:     <b>${s.dncSize}</b>\n` +
        `⚡ CPS:          <b>${s.cps}</b>  🔀 Conc: <b>${s.conc}</b>\n` +
        `⏸ Queue:        <b>${s.isPaused ? '⛔ PAUSED' : '🟢 RUNNING'}</b>`
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MANAGER BOT
// ═══════════════════════════════════════════════════════════════════════════════
const mgrMenu = () => Markup.inlineKeyboard([
    [Markup.button.callback('📊 Status',        'mgr:status'),  Markup.button.callback('📈 Report',   'mgr:report')],
    [Markup.button.callback('⏸ Pause',          'mgr:pause'),   Markup.button.callback('▶️ Resume',  'mgr:resume')],
    [Markup.button.callback('🛑 Stop & Clear',  'mgr:stop')],
    [Markup.button.callback('🚫 DNC List',      'mgr:dnc'),     Markup.button.callback('🏆 Leads',   'mgr:leads')],
    [Markup.button.callback('🎙 IVR Status',    'mgr:ivr'),     Markup.button.callback('🗑 History', 'mgr:clrhist')],
    [Markup.button.callback('❓ Help',           'mgr:help')],
]);

managerBot.start(ctx => ctx.replyWithHTML(
    `👋 <b>Dialer Manager Bot</b>\n\n` +
    `📁 Send a <code>.txt</code> file → queue phone numbers\n` +
    `🎙 Send a <code>.wav</code> / voice note → update IVR audio\n\n` +
    `Use the panel below to control campaigns.`,
    mgrMenu()
));

managerBot.command('menu',   ctx => ctx.replyWithHTML('📟 <b>Manager Control Panel</b>', mgrMenu()));
managerBot.command('help',   mgrHelp);
managerBot.help(mgrHelp);

async function mgrHelp(ctx) {
    await ctx.replyWithHTML(
        `📖 <b>Manager Bot — Commands</b>\n\n` +
        `<b>📁 Uploads</b>\n` +
        `  <code>.txt</code> file → queue numbers\n` +
        `  <code>.wav</code> / voice → update IVR\n\n` +
        `<b>📞 Dialing</b>\n` +
        `  /dial <code>&lt;number&gt;</code> — Queue single number\n` +
        `  /stop — Clear queue\n` +
        `  /pause — Pause dispatching\n` +
        `  /resume — Resume dispatching\n\n` +
        `<b>🚫 DNC</b>\n` +
        `  /blacklist <code>&lt;number&gt;</code> — Add to DNC\n` +
        `  /unblacklist <code>&lt;number&gt;</code> — Remove from DNC\n` +
        `  /dnc — View DNC list\n\n` +
        `<b>📊 Stats</b>\n` +
        `  /status /report /leads /ivrstatus\n\n` +
        `  /menu — Open button panel`,
        Markup.inlineKeyboard([[Markup.button.callback('⬅️ Menu', 'mgr:menu')]])
    );
}

// Commands
managerBot.command('dial', async ctx => {
    const num = ctx.message.text.split(' ')[1];
    if (!num) return ctx.reply('❌ Usage: /dial <number>');
    if (await redis.sismember('dnc', num)) return ctx.reply(`🚫 ${num} is on the DNC list.`);
    const exists = await redis.sismember('dialed_history', num);
    if (exists) return ctx.replyWithHTML(
        `⚠️ <b>${num}</b> was already dialed. Redial?`,
        Markup.inlineKeyboard([[Markup.button.callback('✅ Redial', `redial:${num}`), Markup.button.callback('❌ Cancel', 'cancel')]])
    );
    await dialQueue.add('dial', { phoneNumber: num });
    await redis.sadd('dialed_history', num);
    pino.info(`Queue: Added single dial - ${num}`);
    ctx.reply(`✅ Queued: <code>${num}</code>`, { parse_mode: 'HTML' });
});

managerBot.action(/^redial:(.+)$/, async ctx => {
    await dialQueue.add('dial', { phoneNumber: ctx.match[1] });
    await ctx.editMessageText(`✅ Requeued: <code>${ctx.match[1]}</code>`, { parse_mode: 'HTML' });
    ctx.answerCbQuery();
});

managerBot.command('stop', ctx => ctx.replyWithHTML(
    `⚠️ <b>Clear ALL pending calls?</b>`,
    Markup.inlineKeyboard([[Markup.button.callback('🛑 Yes, Clear', 'confirm:stop'), Markup.button.callback('❌ No', 'cancel')]])
));

managerBot.command('pause',  async ctx => { await dialQueue.pause();  ctx.reply('⏸ Queue paused.'); });
managerBot.command('resume', async ctx => { await dialQueue.resume(); ctx.reply('▶️ Queue resumed.'); });

managerBot.command('status', async ctx => {
    const s = await getStats();
    ctx.replyWithHTML(statusText(s), Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Refresh', 'mgr:status'), Markup.button.callback('⬅️ Menu', 'mgr:menu')]
    ]));
});

managerBot.command('report', async ctx => {
    const s = await getStats();
    const rate = s.answered > 0 ? ((s.leads / s.answered) * 100).toFixed(1) : '0';
    ctx.replyWithHTML(
        `📈 <b>Campaign Report</b>\n━━━━━━━━━━━━━━━━━━━━\n` +
        `📋 Total Dialed: <b>${s.historySize}</b>\n` +
        `📞 Answered:     <b>${s.answered}</b>\n` +
        `🤖 Voicemail:    <b>${s.machine}</b>\n` +
        `🔴 No Answer:    <b>${s.noAnswer}</b>\n` +
        `📵 Busy:         <b>${s.busy}</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🏆 Leads: <b>${s.leads}</b>  📈 Rate: <b>${rate}%</b>`,
        Markup.inlineKeyboard([[Markup.button.callback('🔄 Refresh', 'mgr:report'), Markup.button.callback('⬅️ Menu', 'mgr:menu')]])
    );
});

managerBot.command('leads',  async ctx => ctx.reply(`🏆 Leads: ${await redis.get('stat:leads') || 0}`));
managerBot.command('ivrstatus', ctx => ctx.reply(
    fs.existsSync('/var/lib/asterisk/sounds/custom/current_ivr.wav')
        ? '✅ IVR file loaded and ready.' : '❌ No IVR file. Upload a .wav or voice note.'
));

managerBot.command('blacklist', async ctx => {
    const num = ctx.message.text.split(' ')[1];
    if (!num) return ctx.reply('❌ Usage: /blacklist <number>');
    await redis.sadd('dnc', num);
    ctx.reply(`🚫 ${num} added to DNC.`);
});

managerBot.command('unblacklist', async ctx => {
    const num = ctx.message.text.split(' ')[1];
    if (!num) return ctx.reply('❌ Usage: /unblacklist <number>');
    await redis.srem('dnc', num);
    ctx.reply(`✅ ${num} removed from DNC.`);
});

managerBot.command('dnc', async ctx => {
    const list = await redis.smembers('dnc');
    ctx.replyWithHTML(list.length
        ? `🚫 <b>DNC (${list.length})</b>\n` + list.map(n => `• <code>${n}</code>`).join('\n')
        : '✅ DNC list is empty.'
    );
});

managerBot.command('clearhistory', ctx => ctx.replyWithHTML(
    '⚠️ <b>Clear all dialed history?</b>',
    Markup.inlineKeyboard([[Markup.button.callback('🗑 Yes', 'confirm:clrhist'), Markup.button.callback('❌ No', 'cancel')]])
));

// Inline button actions
managerBot.action('mgr:status', async ctx => {
    const s = await getStats();
    await ctx.editMessageText(statusText(s), { parse_mode: 'HTML', ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Refresh', 'mgr:status'), Markup.button.callback('⬅️ Menu', 'mgr:menu')]
    ])});
    ctx.answerCbQuery('Refreshed ✅');
});

managerBot.action('mgr:report', async ctx => {
    const s = await getStats();
    const rate = s.answered > 0 ? ((s.leads / s.answered) * 100).toFixed(1) : '0';
    await ctx.editMessageText(
        `📈 Campaign Report\n\nDialed: ${s.historySize} | Answered: ${s.answered}\nNo Answer: ${s.noAnswer} | Busy: ${s.busy}\nVoicemail: ${s.machine} | Leads: ${s.leads}\nConversion: ${rate}%`,
        Markup.inlineKeyboard([[Markup.button.callback('🔄 Refresh', 'mgr:report'), Markup.button.callback('⬅️ Menu', 'mgr:menu')]])
    );
    ctx.answerCbQuery();
});

managerBot.action('mgr:pause', async ctx => {
    await dialQueue.pause();
    await ctx.editMessageText('⏸ Queue paused.', Markup.inlineKeyboard([[Markup.button.callback('▶️ Resume', 'mgr:resume'), Markup.button.callback('⬅️ Menu', 'mgr:menu')]]));
    ctx.answerCbQuery('Paused ⏸');
});

managerBot.action('mgr:resume', async ctx => {
    await dialQueue.resume();
    await ctx.editMessageText('▶️ Queue resumed.', Markup.inlineKeyboard([[Markup.button.callback('⏸ Pause', 'mgr:pause'), Markup.button.callback('⬅️ Menu', 'mgr:menu')]]));
    ctx.answerCbQuery('Resumed ▶️');
});

managerBot.action('mgr:stop', ctx => {
    ctx.editMessageText('⚠️ Stop and clear ALL pending calls?', Markup.inlineKeyboard([
        [Markup.button.callback('🛑 Yes, Clear', 'confirm:stop'), Markup.button.callback('❌ Cancel', 'mgr:menu')]
    ]));
    ctx.answerCbQuery();
});

managerBot.action('mgr:leads', async ctx => {
    const leads = await redis.get('stat:leads') || 0;
    await ctx.editMessageText(`🏆 Total Leads: ${leads}`, Markup.inlineKeyboard([[Markup.button.callback('🔄 Refresh', 'mgr:leads'), Markup.button.callback('⬅️ Menu', 'mgr:menu')]]));
    ctx.answerCbQuery();
});

managerBot.action('mgr:dnc', async ctx => {
    const list = await redis.smembers('dnc');
    await ctx.editMessageText(
        list.length ? `🚫 DNC (${list.length}):\n` + list.map(n => `• ${n}`).join('\n') : '✅ DNC list is empty.',
        Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'mgr:menu')]])
    );
    ctx.answerCbQuery();
});

managerBot.action('mgr:ivr', ctx => {
    ctx.editMessageText(
        fs.existsSync('/var/lib/asterisk/sounds/custom/current_ivr.wav')
            ? '✅ IVR ready.' : '❌ No IVR file. Upload a .wav or voice note.',
        Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'mgr:menu')]])
    );
    ctx.answerCbQuery();
});

managerBot.action('mgr:clrhist', ctx => {
    ctx.editMessageText('⚠️ Clear all dialed history?', Markup.inlineKeyboard([
        [Markup.button.callback('🗑 Yes', 'confirm:clrhist'), Markup.button.callback('❌ No', 'mgr:menu')]
    ]));
    ctx.answerCbQuery();
});

managerBot.action('mgr:help', async ctx => {
    await ctx.editMessageText(
        `📖 Commands:\n/dial <n> /stop /pause /resume\n/blacklist /unblacklist /dnc\n/status /report /leads /ivrstatus\nUpload .txt = queue | .wav = IVR`,
        Markup.inlineKeyboard([[Markup.button.callback('⬅️ Menu', 'mgr:menu')]])
    );
    ctx.answerCbQuery();
});

managerBot.action('mgr:menu', async ctx => { await ctx.editMessageText('📟 Manager Control Panel', mgrMenu()); ctx.answerCbQuery(); });

managerBot.action('confirm:stop', async ctx => {
    await dialQueue.drain();
    await ctx.editMessageText('🛑 Queue cleared.', Markup.inlineKeyboard([[Markup.button.callback('⬅️ Menu', 'mgr:menu')]]));
    ctx.answerCbQuery('Cleared!');
});

managerBot.action('confirm:clrhist', async ctx => {
    await redis.del('dialed_history');
    await ctx.editMessageText('🗑 Dialed history cleared.', Markup.inlineKeyboard([[Markup.button.callback('⬅️ Menu', 'mgr:menu')]]));
    ctx.answerCbQuery('Done!');
});

managerBot.action('cancel', async ctx => {
    await ctx.editMessageText('❌ Cancelled.', mgrMenu());
    ctx.answerCbQuery();
});

// File upload handler
managerBot.on(['document', 'voice'], async ctx => {
    const file = ctx.message.document || ctx.message.voice;

    if (file.file_name?.endsWith('.txt')) {
        pino.info(`Bot: Received .txt file from user`);
        const msg = await ctx.reply('⏳ Processing contact list...');
        const link = await ctx.telegram.getFileLink(file.file_id);
        const res  = await fetch(link.href);
        const numbers = (await res.text()).split(/\r?\n/).filter(n => n.trim());
        let added = 0, skippedDup = 0, skippedDNC = 0;
        for (const n of numbers) {
            const num = n.trim();
            if (!num) continue;
            if (await redis.sismember('dnc', num))            { skippedDNC++; continue; }
            if (await redis.sismember('dialed_history', num)) { skippedDup++; continue; }
            await dialQueue.add('dial', { phoneNumber: num });
            await redis.sadd('dialed_history', num);
            added++;
        }
        pino.info(`Queue: Added ${added} new numbers from list (${skippedDup} duplicates skipped, ${skippedDNC} DNC skipped)`);
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
            `✅ <b>List Processed</b>\n\n📥 Total: <b>${numbers.length}</b>\n✅ Queued: <b>${added}</b>\n⏭ Duplicates: <b>${skippedDup}</b>\n🚫 DNC: <b>${skippedDNC}</b>`,
            { parse_mode: 'HTML' }
        );
        return;
    }

    if (file.file_name?.endsWith('.wav') || ctx.message.voice) {
        pino.info(`Bot: Received IVR audio file from user. Converting...`);
        const msg  = await ctx.reply('⏳ Converting IVR audio...');
        const link = await ctx.telegram.getFileLink(file.file_id);
        const ivrPath = '/var/lib/asterisk/sounds/custom/current_ivr.wav';
        ffmpeg(link.href).toFormat('wav').audioChannels(1).audioFrequency(8000)
            .save(ivrPath)
            .on('end',   () => {
                pino.info(`Audio converted and saved to ${ivrPath}`);
                ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `✅ <b>IVR Updated!</b>\n\n8kHz mono WAV uploaded and stored successfully at:\n<code>${ivrPath}</code>`, { parse_mode: 'HTML' });
            })
            .on('error', e => {
                pino.error(`Audio conversion failed: ${e.message}`);
                ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `❌ Conversion failed: ${e.message}`);
            });
        return;
    }

    ctx.reply('⚠️ Send a <code>.txt</code> (numbers) or <code>.wav</code>/voice (IVR).', { parse_mode: 'HTML' });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN BOT
// ═══════════════════════════════════════════════════════════════════════════════
const admMenu = () => Markup.inlineKeyboard([
    [Markup.button.callback('📊 Full Status',     'adm:status'),    Markup.button.callback('📈 Report',      'adm:report')],
    [Markup.button.callback('⚙️ Config',          'adm:config'),    Markup.button.callback('🏆 Leads',       'adm:leads')],
    [Markup.button.callback('⏸ Pause Queue',     'adm:pause'),     Markup.button.callback('▶️ Resume',      'adm:resume')],
    [Markup.button.callback('🛑 Stop & Clear',    'adm:stop')],
    [Markup.button.callback('🗑 Clear History',   'adm:clrhist'),   Markup.button.callback('🧹 Reset Stats', 'adm:resetstats')],
    [Markup.button.callback('🚫 DNC List',        'adm:dnc'),       Markup.button.callback('🧹 Clear DNC',  'adm:cleardnc')],
    [Markup.button.callback('❓ Help',             'adm:help')],
]);

adminBot.start(ctx => ctx.replyWithHTML('🔐 <b>Admin Control Panel</b>', admMenu()));
adminBot.command('menu',  ctx => ctx.replyWithHTML('🔐 <b>Admin Control Panel</b>', admMenu()));
adminBot.command('help',  admHelp);
adminBot.help(admHelp);

async function admHelp(ctx) {
    await ctx.replyWithHTML(
        `📖 <b>Admin Commands</b>\n\n` +
        `/status /report /leads\n` +
        `/setcps <code>&lt;n&gt;</code> — Calls per second\n` +
        `/setconcurrency <code>&lt;n&gt;</code> — Max concurrent\n` +
        `/pause /resume /stop\n` +
        `/clearhistory /resetstats /cleardnc\n` +
        `/menu — Button panel`,
        Markup.inlineKeyboard([[Markup.button.callback('⬅️ Menu', 'adm:menu')]])
    );
}

adminBot.command('status', async ctx => {
    const s = await getStats();
    ctx.replyWithHTML(statusText(s), Markup.inlineKeyboard([[Markup.button.callback('🔄 Refresh', 'adm:status'), Markup.button.callback('⬅️ Menu', 'adm:menu')]]));
});

adminBot.command('report', async ctx => {
    const s = await getStats();
    const rate = s.answered > 0 ? ((s.leads / s.answered) * 100).toFixed(1) : '0';
    ctx.replyWithHTML(
        `📈 <b>Full Campaign Report</b>\n━━━━━━━━━━━━━━━━━━━━\n` +
        `📋 Dialed: <b>${s.historySize}</b> | 📞 Answered: <b>${s.answered}</b>\n` +
        `🔴 No Ans: <b>${s.noAnswer}</b>  | 📵 Busy: <b>${s.busy}</b>\n` +
        `🤖 Voicemail: <b>${s.machine}</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🏆 Leads: <b>${s.leads}</b>  📈 Rate: <b>${rate}%</b>\n` +
        `🟡 Waiting: <b>${s.counts.waiting}</b> | 🚫 DNC: <b>${s.dncSize}</b>`
    );
});

adminBot.command('leads',           async ctx => ctx.reply(`🏆 Leads: ${await redis.get('stat:leads') || 0}`));
adminBot.command('setcps',          async ctx => { const v = ctx.message.text.split(' ')[1]; if (!v || isNaN(v)) return ctx.reply('❌ /setcps <n>'); await redis.set('config:cps', v); ctx.reply(`✅ CPS set to ${v}`); });
adminBot.command('setconcurrency',  async ctx => { const v = ctx.message.text.split(' ')[1]; if (!v || isNaN(v)) return ctx.reply('❌ /setconcurrency <n>'); await redis.set('config:concurrency', v); ctx.reply(`✅ Concurrency set to ${v} (restart worker to apply)`); });
adminBot.command('pause',           async ctx => { await dialQueue.pause();  ctx.reply('⏸ Queue paused.'); });
adminBot.command('resume',          async ctx => { await dialQueue.resume(); ctx.reply('▶️ Queue resumed.'); });
adminBot.command('stop',            ctx => ctx.replyWithHTML('⚠️ <b>Clear ALL pending calls?</b>', Markup.inlineKeyboard([[Markup.button.callback('🛑 Yes', 'adm:confirm:stop'), Markup.button.callback('❌ No', 'adm:menu')]])));
adminBot.command('clearhistory',    ctx => ctx.replyWithHTML('⚠️ <b>Clear ALL dialed history?</b>', Markup.inlineKeyboard([[Markup.button.callback('🗑 Yes', 'adm:confirm:clrhist'), Markup.button.callback('❌ No', 'adm:menu')]])));
adminBot.command('resetstats',      ctx => ctx.replyWithHTML('⚠️ <b>Reset ALL call statistics?</b>', Markup.inlineKeyboard([[Markup.button.callback('🧹 Yes', 'adm:confirm:resetstats'), Markup.button.callback('❌ No', 'adm:menu')]])));
adminBot.command('cleardnc',        async ctx => { await redis.del('dnc'); ctx.reply('✅ DNC list cleared.'); });

// Admin button actions
adminBot.action('adm:status', async ctx => {
    const s = await getStats();
    await ctx.editMessageText(statusText(s), { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔄 Refresh', 'adm:status'), Markup.button.callback('⬅️ Menu', 'adm:menu')]]) });
    ctx.answerCbQuery('Refreshed ✅');
});

adminBot.action('adm:report', async ctx => {
    const s = await getStats();
    const rate = s.answered > 0 ? ((s.leads / s.answered) * 100).toFixed(1) : '0';
    await ctx.editMessageText(
        `📈 Report\nDialed:${s.historySize} Answered:${s.answered}\nVoicemail:${s.machine} No Ans:${s.noAnswer} Busy:${s.busy}\nLeads:${s.leads} Rate:${rate}% DNC:${s.dncSize}`,
        Markup.inlineKeyboard([[Markup.button.callback('🔄', 'adm:report'), Markup.button.callback('⬅️ Menu', 'adm:menu')]])
    );
    ctx.answerCbQuery();
});

adminBot.action('adm:leads', async ctx => {
    const leads = await redis.get('stat:leads') || 0;
    await ctx.editMessageText(`🏆 Total Leads: ${leads}`, Markup.inlineKeyboard([[Markup.button.callback('🔄', 'adm:leads'), Markup.button.callback('⬅️ Menu', 'adm:menu')]]));
    ctx.answerCbQuery();
});

adminBot.action('adm:config', async ctx => {
    const cps  = await redis.get('config:cps')         || process.env.CPS_LIMIT;
    const conc = await redis.get('config:concurrency') || process.env.CONCURRENCY;
    await ctx.editMessageText(
        `⚙️ <b>Live Config</b>\n\n⚡ CPS: <b>${cps}</b>\n🔀 Concurrency: <b>${conc}</b>\n\nChange with:\n/setcps &lt;n&gt;\n/setconcurrency &lt;n&gt;`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔄', 'adm:config'), Markup.button.callback('⬅️ Menu', 'adm:menu')]]) }
    );
    ctx.answerCbQuery();
});

adminBot.action('adm:pause',  async ctx => { await dialQueue.pause();  await ctx.editMessageText('⏸ Queue paused.',   Markup.inlineKeyboard([[Markup.button.callback('▶️ Resume', 'adm:resume'), Markup.button.callback('⬅️ Menu', 'adm:menu')]])); ctx.answerCbQuery(); });
adminBot.action('adm:resume', async ctx => { await dialQueue.resume(); await ctx.editMessageText('▶️ Queue resumed.', Markup.inlineKeyboard([[Markup.button.callback('⏸ Pause',  'adm:pause'),  Markup.button.callback('⬅️ Menu', 'adm:menu')]])); ctx.answerCbQuery(); });

adminBot.action('adm:stop', async ctx => {
    await ctx.editMessageText('⚠️ Clear ALL pending calls?', Markup.inlineKeyboard([[Markup.button.callback('🛑 Yes', 'adm:confirm:stop'), Markup.button.callback('❌ No', 'adm:menu')]]));
    ctx.answerCbQuery();
});

adminBot.action('adm:clrhist', async ctx => {
    await ctx.editMessageText('⚠️ Clear ALL dialed history?', Markup.inlineKeyboard([[Markup.button.callback('🗑 Yes', 'adm:confirm:clrhist'), Markup.button.callback('❌ No', 'adm:menu')]]));
    ctx.answerCbQuery();
});

adminBot.action('adm:resetstats', async ctx => {
    await ctx.editMessageText('⚠️ Reset ALL stats?', Markup.inlineKeyboard([[Markup.button.callback('🧹 Yes', 'adm:confirm:resetstats'), Markup.button.callback('❌ No', 'adm:menu')]]));
    ctx.answerCbQuery();
});

adminBot.action('adm:dnc', async ctx => {
    const list = await redis.smembers('dnc');
    await ctx.editMessageText(list.length ? `🚫 DNC (${list.length}):\n` + list.map(n => `• ${n}`).join('\n') : '✅ Empty.', Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'adm:menu')]]));
    ctx.answerCbQuery();
});

adminBot.action('adm:cleardnc', async ctx => {
    await ctx.editMessageText('⚠️ Clear DNC list?', Markup.inlineKeyboard([[Markup.button.callback('🧹 Yes', 'adm:confirm:cleardnc'), Markup.button.callback('❌ No', 'adm:menu')]]));
    ctx.answerCbQuery();
});

adminBot.action('adm:help', async ctx => {
    await ctx.editMessageText(
        `📖 /status /report /leads\n/setcps /setconcurrency\n/pause /resume /stop\n/clearhistory /resetstats /cleardnc`,
        Markup.inlineKeyboard([[Markup.button.callback('⬅️ Menu', 'adm:menu')]])
    );
    ctx.answerCbQuery();
});

adminBot.action('adm:menu', async ctx => { await ctx.editMessageText('🔐 Admin Control Panel', admMenu()); ctx.answerCbQuery(); });

adminBot.action('adm:confirm:stop',       async ctx => { await dialQueue.drain(); await ctx.editMessageText('🛑 Queue cleared.', Markup.inlineKeyboard([[Markup.button.callback('⬅️ Menu', 'adm:menu')]])); ctx.answerCbQuery('Done!'); });
adminBot.action('adm:confirm:clrhist',    async ctx => { await redis.del('dialed_history'); await ctx.editMessageText('🗑 History cleared.', Markup.inlineKeyboard([[Markup.button.callback('⬅️ Menu', 'adm:menu')]])); ctx.answerCbQuery('Done!'); });
adminBot.action('adm:confirm:resetstats', async ctx => { await redis.del('stat:leads','stat:answered','stat:no_answer','stat:busy','stat:failed','stat:machine'); await ctx.editMessageText('🧹 Stats reset.', Markup.inlineKeyboard([[Markup.button.callback('⬅️ Menu', 'adm:menu')]])); ctx.answerCbQuery('Reset!'); });
adminBot.action('adm:confirm:cleardnc',   async ctx => { await redis.del('dnc'); await ctx.editMessageText('✅ DNC cleared.', Markup.inlineKeyboard([[Markup.button.callback('⬅️ Menu', 'adm:menu')]])); ctx.answerCbQuery('Cleared!'); });

// ═══════════════════════════════════════════════════════════════════════════════
// NOTIF BOT — receives automated lead alerts from worker via Redis pub/sub
// ═══════════════════════════════════════════════════════════════════════════════
const notifMenu = () => Markup.inlineKeyboard([
    [Markup.button.callback('🏆 Lead Count', 'notif:leads'), Markup.button.callback('📊 Status', 'notif:status')],
    [Markup.button.callback('🔄 Refresh', 'notif:refresh')],
]);

notifBot.start(ctx => ctx.replyWithHTML(
    `🔔 <b>Notification Bot</b>\n\nThis bot sends real-time alerts when leads press 1.\nUse buttons below to monitor live stats.`,
    notifMenu()
));
notifBot.command('menu',   ctx => ctx.reply('🔔 Notification Panel', notifMenu()));
notifBot.command('help',   ctx => ctx.replyWithHTML(`📖 <b>Notif Bot</b>\n/status — queue status\n/leads — lead count\nAll other alerts are automatic.`));
notifBot.help(ctx => ctx.replyWithHTML(`📖 <b>Notif Bot</b>\n/status — queue status\n/leads — lead count\nAll other alerts are automatic.`));
notifBot.command('status', async ctx => { const s = await getStats(); ctx.replyWithHTML(statusText(s)); });
notifBot.command('leads',  async ctx => ctx.reply(`🏆 Leads: ${await redis.get('stat:leads') || 0}`));

notifBot.action('notif:leads', async ctx => {
    const leads = await redis.get('stat:leads') || 0;
    await ctx.editMessageText(`🏆 Total Leads: ${leads}`, notifMenu());
    ctx.answerCbQuery();
});
notifBot.action('notif:status', async ctx => {
    const s = await getStats();
    await ctx.editMessageText(statusText(s), { parse_mode: 'HTML', ...notifMenu() });
    ctx.answerCbQuery();
});
notifBot.action('notif:refresh', async ctx => {
    const s = await getStats();
    await ctx.editMessageText(statusText(s), { parse_mode: 'HTML', ...notifMenu() });
    ctx.answerCbQuery('Refreshed ✅');
});

// ─── Redis pub/sub: receive lead events from worker ────────────────────────────
const { createClient } = require('./lib/redis-sub');
const sub = createClient();
sub.subscribe('leads', (msg) => {
    try {
        const { phoneNumber, timestamp } = JSON.parse(msg);
        const text = `🏆 <b>NEW LEAD!</b>\n📞 <code>${phoneNumber}</code>\n⏰ ${timestamp}`;
        notifBot.telegram.sendMessage(process.env.NOTIF_GROUP_ID, text, { parse_mode: 'HTML' });
    } catch (e) {}
});
sub.subscribe('errors', (msg) => {
    try {
        const { message } = JSON.parse(msg);
        notifBot.telegram.sendMessage(process.env.NOTIF_GROUP_ID, `⚠️ Worker Error: ${message}`);
    } catch (e) {}
});

// ─── Launch ────────────────────────────────────────────────────────────────────
managerBot.launch().then(() => pino.info('🚀 Manager Bot is running.'));
adminBot.launch().then(() => pino.info('🚀 Admin Bot is running.'));
notifBot.launch().then(() => pino.info('🚀 Notification Bot is running.'));

process.once('SIGINT',  () => { pino.info('Shutting down bots...'); managerBot.stop(); adminBot.stop(); notifBot.stop(); });
process.once('SIGTERM', () => { pino.info('Shutting down bots...'); managerBot.stop(); adminBot.stop(); notifBot.stop(); });