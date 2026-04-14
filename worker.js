require('dotenv').config();
const { Worker } = require('bullmq');
const ari = require('ari-client');
const fs = require('fs');
const path = require('path');
const redis = require('./lib/redis');
const pino = require('pino')({ transport: { target: 'pino-pretty' } });

const IVR_FILE = process.env.IVR_AUDIO_PATH || path.join(__dirname, 'current_ivr.wav');

// ─────────────────────────────────────────────
// NORMALIZE TO E.164 (GLOBAL FORMAT FIX)
// ─────────────────────────────────────────────
function normalizeToE164(number) {
    if (!number) return null;

    let num = number.toString().trim();

    // remove spaces, dashes, brackets
    num = num.replace(/[^\d+]/g, '');

    // already E.164
    if (num.startsWith('+')) return num;

    // Kenya fallback (optional)
    if (num.startsWith('0')) {
        num = '+254' + num.substring(1);
    }

    // assume international without +
    if (!num.startsWith('+')) {
        num = '+' + num;
    }

    return num;
}

// ─────────────────────────────────────────────
async function getCPS() {
    return parseFloat((await redis.get('config:cps')) || process.env.CPS_LIMIT || 2);
}

async function getConc() {
    return parseInt((await redis.get('config:concurrency')) || process.env.CONCURRENCY || 25);
}

// CPS throttle
let nextTime = Date.now();
async function throttle() {
    const cps = await getCPS();
    const interval = 1000 / cps;

    const now = Date.now();
    if (nextTime < now) nextTime = now;

    const wait = nextTime - now;
    nextTime += interval;

    if (wait > 0) await new Promise(r => setTimeout(r, wait));
}

function publish(channel, payload) {
    // optional redis pub/sub if needed
    redis.publish(channel, JSON.stringify(payload)).catch(() => { });
}

// ─────────────────────────────────────────────
// MAIN
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
            let phoneNumber = normalizeToE164(job.data.phoneNumber);

            if (!phoneNumber) throw new Error('INVALID_NUMBER');

            if (!fs.existsSync(IVR_FILE)) {
                throw new Error('IVR_FILE_MISSING');
            }

            await throttle();

            pino.info(`📞 Dialing: ${phoneNumber}`);

            try {
                const channel = await client.channels.originate({
                    endpoint: `${process.env.TRUNK_NAME}/${phoneNumber}`,
                    app: 'dialer-app',
                    callerId: process.env.CALLER_ID || 'AutoDialer',
                    variables: {
                        DIALLED_NUMBER: phoneNumber
                    }
                });

                // WAIT UNTIL CALL ENDS
                await new Promise((resolve) => {
                    let done = false;

                    const finish = () => {
                        if (done) return;
                        done = true;
                        resolve();
                    };

                    channel.once('StasisEnd', finish);
                    channel.once('ChannelDestroyed', finish);

                    setTimeout(finish, 60 * 60 * 1000);
                });

                pino.info(`✅ Call finished: ${phoneNumber}`);
            } catch (err) {
                pino.error(`❌ Call failed ${phoneNumber}: ${err.message}`);
                await redis.incr('stat:failed');
                publish('errors', { phoneNumber, message: err.message });
                throw err;
            }
        },
        {
            connection: redis,
            concurrency: await getConc()
        }
    );

    worker.on('failed', (job, err) => {
        pino.error(`❌ Job failed: ${job?.id} → ${err.message}`);
    });

    worker.on('completed', (job) => {
        pino.info(`✅ Job completed: ${job.id}`);
    });

    pino.info(`🚀 Worker running | CPS=${await getCPS()} | CONC=${await getConc()}`);
}

init().catch((err) => {
    pino.error(err);
    process.exit(1);
});