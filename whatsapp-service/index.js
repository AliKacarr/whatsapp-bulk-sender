/**
 * whatsapp-service/index.js
 *
 * Bu servis artık kullanılmamaktadır.
 * WhatsApp Cloud API entegrasyonu doğrudan Python (server.py) üzerinden yapılmaktadır.
 * Dosya geriye uyumluluk ve ileride olası kullanım için korunmaktadır.
 */

import express from 'express';

const app = express();
app.use(express.json());

app.get('/status', (req, res) => {
    res.json({ state: 'cloud_api', mode: 'WhatsApp Cloud API aktif - bu servis devre dışı' });
});

app.listen(3001, '127.0.0.1', () => {
    console.log('[WA] Bu servis devre dışı. WhatsApp Cloud API kullanılmaktadır.');
});
