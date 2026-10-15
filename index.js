import http from 'http';
import url from 'url';

const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.method !== 'GET') {
        res.statusCode = 405;
        return res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    }

    const parsedUrl = url.parse(req.url, true);
    const token = req.headers['x-auth-token'] || parsedUrl.query.token || 'ooobs-task-2026';
    const headers = { 'X-Auth-Token': token };

    async function fetchAll(targetUrl) {
        let page = 1;
        let items = [];
        while (true) {
            const response = await fetch(`${targetUrl}?page=${page}`, { headers });
            if (!response.ok) break;
            const data = await response.json();
            if (data.items && data.items.length > 0) items.push(...data.items);
            if (page >= data.total_pages) break;
            page++;
        }
        return items;
    }

    try {
        const [crmItems, erpItems] = await Promise.all([
            fetchAll('https://test.ooobs.ru/api/v2/crm'),
            fetchAll('https://test.ooobs.ru/api/v2/erp')
        ]);

        const normalizePhone = (p) => {
            if (!p) return null;
            const digits = p.replace(/\D/g, '');
            if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) {
                return '+7' + digits.slice(1);
            }
            if (digits.length === 10) return '+7' + digits;
            return null;
        };

        const normalizeEmail = (e) => {
            if (!e || typeof e !== 'string') return null;
            const email = e.trim().toLowerCase();
            return email.includes('@') ? email : null;
        };

        let stats = {
            crm_fetched: crmItems.length,
            erp_fetched: erpItems.length,
            records_dropped: 0,
            unique_clients: 0,
            duplicates_merged: 0
        };

        let records = [];
        let idCounter = 0;

        const processRecord = (item, source) => {
            let phones = [], emails = [], name = '', amount = 0, dateStr = '';

            if (source === 'crm') {
                if (item.phone) phones.push(item.phone);
                if (item.email) emails.push(item.email);
                name = item.name || '';
                amount = Number(item.amount) || 0;
                dateStr = item.updated_at;
            } else {
                if (item.contacts?.phones) phones.push(...item.contacts.phones);
                if (item.contacts?.emails) emails.push(...item.contacts.emails);
                name = item.full_name || '';
                amount = Number(item.balance) || 0;
                dateStr = item.changed;
            }

            const validPhones = [...new Set(phones.map(normalizePhone).filter(Boolean))];
            const validEmails = [...new Set(emails.map(normalizeEmail).filter(Boolean))];

            if (validPhones.length === 0 && validEmails.length === 0) {
                stats.records_dropped++;
                return;
            }

            records.push({
                id: `${source}_${idCounter++}`,
                source,
                name,
                amount,
                date: dateStr ? new Date(dateStr).getTime() : 0,
                phones: validPhones,
                emails: validEmails
            });
        };

        crmItems.forEach(i => processRecord(i, 'crm'));
        erpItems.forEach(i => processRecord(i, 'erp'));

        const contactCount = {};
        for (let r of records) {
            const uniqueContacts = new Set([...r.phones, ...r.emails]);
            for (let c of uniqueContacts) {
                contactCount[c] = (contactCount[c] || 0) + 1;
            }
        }
        const sharedContacts = new Set(Object.keys(contactCount).filter(c => contactCount[c] >= 3));

        for (let r of records) {
            r.cleanPhones = r.phones.filter(p => !sharedContacts.has(p));
            r.cleanEmails = r.emails.filter(e => !sharedContacts.has(e));
        }

        const parent = {};
        records.forEach(r => parent[r.id] = r.id);
        const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
        const union = (i, j) => {
            const rootI = find(i);
            const rootJ = find(j);
            if (rootI !== rootJ) parent[rootI] = rootJ;
        };

        const contactOwner = {};
        for (let r of records) {
            const contacts = [...r.cleanPhones, ...r.cleanEmails];
            for (let c of contacts) {
                if (contactOwner[c]) union(r.id, contactOwner[c]);
                else contactOwner[c] = r.id;
            }
        }

        const components = {};
        for (let r of records) {
            const root = find(r.id);
            if (!components[root]) components[root] = [];
            components[root].push(r);
        }

        const clients = [];
        for (const key in components) {
            const group = components[key];
            group.sort((a, b) => b.date - a.date);

            let totalAmount = 0;
            let mergedPhones = new Set();
            let mergedEmails = new Set();
            let sources = new Set();

            for (let r of group) {
                totalAmount += r.amount;
                r.cleanPhones.forEach(p => mergedPhones.add(p));
                r.cleanEmails.forEach(e => mergedEmails.add(e));
                sources.add(r.source);
            }

            clients.push({
                name: group[0].name,
                phones: [...mergedPhones],
                emails: [...mergedEmails],
                amount: Number(totalAmount.toFixed(2)),
                sources: [...sources]
            });
        }

        stats.unique_clients = clients.length;
        stats.duplicates_merged = records.length - clients.length;

        res.statusCode = 200;
        res.end(JSON.stringify({ clients, stats }));
    } catch (error) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: error.message }));
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
