// Separate Redis client for pub/sub (cannot share with BullMQ connection)
const Redis = require('ioredis');

function createClient() {
    const client = new Redis({ host: '127.0.0.1', port: 6379, maxRetriesPerRequest: null });
    client.on('error', err => console.error('[Redis Sub]', err.message));
    return client;
}

module.exports = { createClient };
