require('dotenv').config();
const { Worker } = require('bullmq');
const ari        = require('ari-client');
const fs         = require('fs');
const path       = require('path');
const redis      = require('./lib/redis');
const { createClient } = require('./lib/redis-sub');
const pino       = require('pino')({ transport: { target: 'pino-pretty' } });

const IVR_FILE   = process.env.IVR_AUDIO_PATH || path.join(__dirname, 'current_ivr.wav');
const publisher  = createClient(); // dedicated pub client

// ─── Helpers ───────────────────────────────────────────────────────────────────
async function getCPS()  { return parseFloat((await redis.get('config:cps'))         || process.env.CPS_LIMIT   || 2); }
async function getConc() { return parseInt(  (await redis.get('config:concurrency')) || process.env.CONCURRENCY || 25); }

let nextAvailableTime = Date.now();
async function throttleCPS() {
    const cps = await getCPS();
    const minInterval = 1000 / cps;
    const now = Date.now();
    if (nextAvailableTime < now) nextAvailableTime = now;
    const waitTime = nextAvailableTime - now;
    nextAvailableTime += minInterval;
    if (waitTime > 0) await new Promise(r => setTimeout(r, waitTime));
}

function publish(channel, payload) {
    publisher.publish(channel, JSON.stringify(payload)).catch(e => pino.error(`Publish error: ${e.message}`));
}

// Extract dialled number from ARI channel name  e.g. "PJSIP/MyTrunk/0712345678-0001"
function extractNumber(channel) {
    const parts = channel.name.split('/');
    return (parts[2] || parts[1] || channel.name).split('-')[0];
}

// ─── Main init ─────────────────────────────────────────────────────────────────
async function init() {
    pino.info('🔌 Connecting to Asterisk ARI...');
    const client = await ari.connect(
        process.env.ARI_URL,
        process.env.ARI_USER,
        process.env.ARI_PASS
    );
    client.start('dialer-app');
    pino.info('✅ ARI connected — Stasis app "dialer-app" started');

    // ── BullMQ Worker ──────────────────────────────────────────────────────────
    const worker = new Worker('dialer-queue', async (job) => {
        const { phoneNumber } = job.data;

        if (!fs.existsSync(IVR_FILE)) {
            publish('errors', { message: 'IVR file missing — upload a .wav to the manager bot.' });
            throw new Error('IVR_MISSING');
        }

        try {
            await throttleCPS();
            pino.info(`📞 Originating call → ${phoneNumber}`);

            const useAmd = (await redis.get('config:amd')) === 'true' || process.env.ENABLE_AMD === 'true';
            let targetChannel;

            if (useAmd) {
                targetChannel = await client.channels.originate({
                    endpoint:  `${process.env.TRUNK_NAME}/${phoneNumber}`,
                    context:   'dialer-amd',
                    extension: 's',
                    priority:  1,
                    callerId:  process.env.CALLER_ID || 'AutoDialer',
                    variables: { DIALLED_NUMBER: phoneNumber }
                });
            } else {
                targetChannel = await client.channels.originate({
                    endpoint:  `${process.env.TRUNK_NAME}/${phoneNumber}`,
                    app:       'dialer-app',
                    callerId:  process.env.CALLER_ID || 'AutoDialer',
                    variables: { DIALLED_NUMBER: phoneNumber }
                });
            }

            // Keep job active exactly as long as the call is connected
            // This ensures BullMQ concurrency naturally matches max active Asterisk channels
            await new Promise(resolve => {
                let solved = false;
                const done = () => { if (!solved) { solved = true; resolve(); }};
                targetChannel.once('ChannelDestroyed', done);
                setTimeout(done, 3600 * 1000); // 1 hour safety fallback timeout
            });

        } catch (err) {
            pino.error(`❌ Originate failed [${phoneNumber}]: ${err.message}`);
            await redis.incr('stat:failed');
            publish('errors', { message: `Originate failed for ${phoneNumber}: ${err.message}` });
            throw err;
        }

    }, { connection: redis, concurrency: await getConc() });

    worker.on('failed', (job, err) => pino.error(`Job [${job?.id}] failed: ${err.message}`));
    worker.on('completed', job  => pino.info(`Job [${job.id}] completed`));
    pino.info(`🚀 Worker ready  CPS=${await getCPS()}  Concurrency=${await getConc()}`);

    // ── ARI Stasis App ─────────────────────────────────────────────────────────
    client.on('StasisStart', async (event, channel) => {
        const phoneNumber = extractNumber(channel);
        pino.info(`📲 StasisStart: ${channel.name} [${phoneNumber}]`);

        // 1) Evaluate AMD results if arriving from the dialer-amd context
        try {
            const amdRes = await client.channels.getChannelVar({ channelId: channel.id, variable: 'AMDSTATUS' });
            if (amdRes && amdRes.value === 'MACHINE') {
                pino.info(`🤖 MACHINE DETECTED [${phoneNumber}] - Hanging up immediately.`);
                await redis.incr('stat:machine').catch(() => {});
                await channel.hangup().catch(() => {});
                return; // Stop execution, skip IVR mapping
            }
        } catch (e) {
            // Variable might not exist if AMD was skipped, safe to ignore
        }

        // Increment answered stat (since they technically picked up, human or machine)
        redis.incr('stat:answered').catch(() => {});

        // 2) Ensure channel is Answered (in case of direct ARI origination)
        if (channel.state !== 'Up') {
            try {
                await channel.answer();
                pino.info(`✅ Answered (by ARI): ${channel.name}`);
            } catch (err) {
                pino.error(`Answer error on ${channel.name}: ${err}`);
                return;
            }
        } else {
            pino.info(`✅ Answered (by Dialplan): ${channel.name}`);
        }

        // 3) Play IVR
        const playback = await channel.play({ media: 'sound:custom/current_ivr' }).catch(e => {
            pino.error(`Playback error: ${e.message}`);
        });

        // Auto-hangup after configurable timeout
        const timeoutSec = parseInt(process.env.IVR_TIMEOUT_SEC || '15');
        const hangupTimer = setTimeout(() => {
            pino.info(`⏱ Timeout hangup: ${channel.name}`);
            channel.hangup().catch(() => {});
        }, timeoutSec * 1000);

        // DTMF handler
        channel.on('ChannelDtmfReceived', async (dtmfEvent) => {
            clearTimeout(hangupTimer);
            const digit = dtmfEvent.digit;
            pino.info(`🎯 DTMF [${digit}] from ${channel.name} [${phoneNumber}]`);

            if (digit === '1') {
                // ── LEAD ──
                pino.info(`🏆 LEAD: ${phoneNumber} pressed 1`);
                await redis.incr('stat:leads').catch(() => {});
                publish('leads', {
                    phoneNumber,
                    timestamp: new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })
                });
                channel.continueInDialplan({
                    context:   'default',
                    extension: process.env.AGENT_EXTENSION
                }).catch(e => pino.error(`Dialplan error: ${e.message}`));

            } else if (digit === '2') {
                // ── DNC request — caller pressed 2 to opt-out ──
                pino.info(`🚫 DNC opt-out: ${phoneNumber}`);
                await redis.sadd('dnc', phoneNumber).catch(() => {});
                await redis.srem('dialed_history', phoneNumber).catch(() => {});
                channel.hangup().catch(() => {});

            } else if (digit === '9') {
                // ── Replay IVR message ──
                pino.info(`🔁 Replay IVR: ${channel.name}`);
                channel.play({ media: 'sound:custom/current_ivr' }).catch(e => pino.error(`Replay error: ${e.message}`));
                // Re-arm hangup timer after replay
                const replayTimer = setTimeout(() => channel.hangup().catch(() => {}), timeoutSec * 1000);
                channel.once('ChannelDtmfReceived', async (e2) => {
                    clearTimeout(replayTimer);
                    if (e2.digit === '1') {
                        await redis.incr('stat:leads').catch(() => {});
                        publish('leads', { phoneNumber, timestamp: new Date().toLocaleString() });
                        channel.continueInDialplan({ context: 'default', extension: process.env.AGENT_EXTENSION }).catch(() => {});
                    } else {
                        channel.hangup().catch(() => {});
                    }
                });

            } else {
                // Any other key — hangup
                channel.hangup().catch(() => {});
            }
        });
    });

    // Track no-answer / busy via ChannelDestroyed for non-answered channels
    const answeredChannels = new Set();
    client.on('StasisStart', (event, channel) => answeredChannels.add(channel.id));

    client.on('ChannelDestroyed', (event, channel) => {
        pino.info(`📴 Channel destroyed: ${channel.name}  cause=${event.cause_txt || event.cause}`);
        if (!answeredChannels.has(channel.id)) {
            const cause = (event.cause_txt || '').toLowerCase();
            if (cause.includes('busy') || event.cause === 17) {
                redis.incr('stat:busy').catch(() => {});
            } else {
                redis.incr('stat:no_answer').catch(() => {});
            }
        }
        answeredChannels.delete(channel.id);
    });

    client.on('StasisEnd', (event, channel) => {
        pino.info(`📵 StasisEnd: ${channel.name}`);
    });
}

// ─── Boot ───────────────────────────────────────────────────────────────────────
init().catch(err => {
    pino.error(`💥 Fatal init error: ${err.message}`);
    process.exit(1);
});