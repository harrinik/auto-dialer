require('dotenv').config();
const { Worker } = require('bullmq');
const ari = require('ari-client');
const fs = require('fs');
const path = require('path');
const redis = require('./lib/redis');
const pino = require('pino')({ transport: { target: 'pino-pretty' } });

const IVR_FILE = process.env.IVR_AUDIO_PATH || path.join(__dirname, 'current_ivr.wav');

// ─────────────────────────────────────────────
// NORMALIZE TO E.164 (GLOBAL SUPPORT FIXED)
// ─────────────────────────────────────────────
function normalizeToE164(number) {
    if (!number) return null;

    let num = number.toString().trim();

    // remove spaces, dashes, parentheses
    num = num.replace(/[^\d+]/g, '');

    if (num.startsWith('+')) return num;

    // Kenya fallback
    if (num.startsWith('0')) {
        return '+254' + num.slice(1);
    }

    // generic international fallback
    return '+' + num;
}

// ─────────────────────────────────────────────
async function getCPS() {
    return parseFloat((await redis.get('config:cps')) || process.env.CPS_LIMIT || 2);
}

async function getConc() {
    return parseInt((await redis.get('config:concurrency')) || process.env.CONCURRENCY || 10);
}

// ─────────────────────────────────────────────
// CPS THROTTLE (GLOBAL SAFE)
// ─────────────────────────────────────────────
let nextTime = Date.now();

async function throttle() {
    const cps = await getCPS();
    const interval = 1000 / cps;

    const now = Date.now();
    if (nextTime < now) nextTime = now;

    const wait = nextTime - now;
    nextTime += interval;

    if (wait > 0) {
        await new Promise(r => setTimeout(r, wait));
    }
}

// ─────────────────────────────────────────────
function publish(channel, payload) {
    redis.publish(channel, JSON.stringify(payload)).catch(() => { });
}

// ─────────────────────────────────────────────
// ACTIVE CALL TRACKING (CRITICAL FIX)
// ─────────────────────────────────────────────
const activeCalls = new Map();

// ─────────────────────────────────────────────
// MAIN WORKER
// ─────────────────────────────────────────────
async function init() {
    pino.info('🔌 Connecting ARI...');

    const client = await ari.connect(
        process.env.ARI_URL,
        process.env.ARI_USER,
        process.env.ARI_PASS
    );

    client.start('dialer-app');

    pino.info('✅ ARI connected');

    const worker = new Worker(
        'dialer-queue',
        async (job) => {
            const raw = job.data.phoneNumber;
            const phoneNumber = normalizeToE164(raw);

            if (!phoneNumber) {
                throw new Error(`INVALID_NUMBER: ${raw}`);
            }

            if (!fs.existsSync(IVR_FILE)) {
                throw new Error('IVR_FILE_MISSING');
            }

            await throttle();

            pino.info(`📞 Dialing → ${phoneNumber}`);

            return new Promise(async (resolve, reject) => {
                let channelRef = null;
                let finished = false;

                const cleanup = (reason) => {
                    if (finished) return;
                    finished = true;

                    activeCalls.delete(phoneNumber);

                    if (reason === 'error') reject(new Error('CALL_FAILED'));
                    else resolve();
                };

                try {
                    channelRef = await client.channels.originate({
                        endpoint: `${process.env.TRUNK_NAME}/${phoneNumber}`,
                        app: 'dialer-app',
                        callerId: process.env.CALLER_ID || 'AutoDialer',
                        variables: {
                            DIALLED_NUMBER: phoneNumber
                        }
                    });

                    activeCalls.set(phoneNumber, channelRef);

                    // SAFE EVENT HANDLING
                    channelRef.once('StasisEnd', () => cleanup('end'));
                    channelRef.once('ChannelDestroyed', () => cleanup('end'));

                    // HARD TIMEOUT SAFETY
                    setTimeout(() => {
                        if (!finished) {
                            pino.warn(`⏱ Timeout call cleanup: ${phoneNumber}`);
                            try { channelRef.hangup(); } catch { }
                            cleanup('timeout');
                        }
                    }, 2 * 60 * 1000); // 2 min max call window

                } catch (err) {
                    pino.error(`❌ Originate failed ${phoneNumber}: ${err.message}`);
                    await redis.incr('stat:failed');
                    publish('errors', { phoneNumber, message: err.message });
                    reject(err);
                }
            });
        },
        {
            connection: redis,
            concurrency: await getConc()
        }
    );

    worker.on('completed', (job) => {
        pino.info(`✅ Completed: ${job.id}`);
    });

    worker.on('failed', (job, err) => {
        pino.error(`❌ Failed: ${job?.id} → ${err.message}`);
    });

    pino.info(`🚀 Worker READY | CPS=${await getCPS()} | CONC=${await getConc()}`);
}

init().catch((err) => {
    pino.error(err);
    process.exit(1);
});