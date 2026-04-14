function normalizeToE164(raw, defaultCountry = null) {
    if (!raw) return null;

    let n = raw.toString().trim();

    // remove formatting noise
    n = n.replace(/[\s\-\(\)\.]/g, '');

    // remove "+"
    if (n.startsWith('+')) n = n.slice(1);

    // remove 00 prefix
    if (n.startsWith('00')) n = n.slice(2);

    // already numeric check
    if (!/^\d{6,15}$/.test(n)) return null;

    // international already
    if (n.startsWith('1') && n.length === 11) return n;
    if (n.startsWith('44')) return n;
    if (n.startsWith('254')) return n;

    // fallback local handling
    if (defaultCountry === 'US' && n.length === 10) return '1' + n;
    if (defaultCountry === 'UK' && n.startsWith('0')) return '44' + n.slice(1);
    if (defaultCountry === 'KE' && n.startsWith('0')) return '254' + n.slice(1);

    return null;
}

function detectCountry(num) {
    if (!num) return 'UNKNOWN';
    if (num.startsWith('1')) return 'US';
    if (num.startsWith('44')) return 'UK';
    if (num.startsWith('254')) return 'KE';
    if (num.startsWith('234')) return 'NG';
    if (num.startsWith('91')) return 'IN';
    return 'UNKNOWN';
}

module.exports = {
    normalizeToE164,
    detectCountry
};