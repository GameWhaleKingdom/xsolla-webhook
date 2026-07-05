const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ================================================================
// 1. اتصال PostgreSQL (Render)
// ================================================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// إنشاء الجداول
pool.query(`
    CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        pin TEXT,
        gems INTEGER DEFAULT 0,
        daily_spent DECIMAL DEFAULT 0,
        last_date TEXT
    );
    CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        user_id TEXT,
        order_id TEXT UNIQUE,
        tier TEXT,
        paid_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS webhook_logs (
        id SERIAL PRIMARY KEY,
        event_id TEXT UNIQUE,
        user_id TEXT,
        processed BOOLEAN DEFAULT FALSE,
        received_at TIMESTAMP DEFAULT NOW()
    );
`).catch(err => console.error('❌ فشل إنشاء الجداول:', err));

// ================================================================
// 2. بيانات Xsolla
// ================================================================
const PROJECT_ID = process.env.XSOLLA_PROJECT_ID || '892373';
const API_KEY = process.env.XSOLLA_API_KEY;
const WEBHOOK_SECRET = process.env.XSOLLA_WEBHOOK_SECRET;
const RETURN_URL = process.env.RETURN_URL || 'https://emoji-universe.netlify.app';

// ================================================================
// 3. دوال مساعدة
// ================================================================
function getGemsFromSku(sku) {
    if (!sku) return 0;
    if (sku === 'emoji_coin') return 0;
    if (sku.startsWith('gems_')) {
        const num = parseInt(sku.split('_')[1]);
        return isNaN(num) ? 0 : num;
    }
    if (sku === 'gacha_normal') return 0;
    if (sku === 'gacha_rare') return 0;
    if (sku === 'gacha_legendary') return 0;
    return 0;
}

function getTierFromSku(sku) {
    if (!sku) return 'free';
    if (sku.startsWith('gems_')) return 'paid';
    if (sku === 'vip_monthly') return 'vip';
    if (sku === 'vip_yearly') return 'whale';
    if (sku === 'dev_support') return 'paid';
    if (sku.startsWith('gacha_')) return 'paid';
    return 'free';
}

// ================================================================
// 4. مسارات الحماية (PIN + Daily Limit)
// ================================================================

app.post('/set-pin', async (req, res) => {
    const { userId, pin } = req.body;
    if (!userId || !pin) {
        console.warn('[set-pin] ❌ Missing userId or pin');
        return res.status(400).json({ error: 'Missing userId or pin' });
    }
    try {
        await pool.query('INSERT INTO users (user_id, pin) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET pin = $2', [userId, pin]);
        console.log(`[set-pin] ✅ تم تعيين PIN للمستخدم ${userId}`);
        res.json({ success: true });
    } catch (err) {
        console.error('[set-pin] ❌ خطأ:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/verify-pin', async (req, res) => {
    const { userId, pin } = req.body;
    if (!userId || !pin) {
        console.warn('[verify-pin] ❌ Missing userId or pin');
        return res.status(400).json({ error: 'Missing userId or pin' });
    }
    try {
        const result = await pool.query('SELECT pin FROM users WHERE user_id = $1', [userId]);
        if (result.rows.length === 0 || !result.rows[0].pin) {
            console.log(`[verify-pin] ℹ️ المستخدم ${userId} ليس لديه PIN`);
            return res.json({ valid: false, message: 'لم يتم تعيين رمز سري' });
        }
        const valid = result.rows[0].pin === pin;
        console.log(`[verify-pin] ${valid ? '✅' : '❌'} المستخدم ${userId}`);
        res.json({ valid });
    } catch (err) {
        console.error('[verify-pin] ❌ خطأ:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/check-limit', async (req, res) => {
    const { userId, amount } = req.body;
    if (!userId || !amount) {
        console.warn('[check-limit] ❌ Missing userId or amount');
        return res.status(400).json({ error: 'Missing userId or amount' });
    }
    try {
        const today = new Date().toDateString();
        const user = await pool.query('SELECT daily_spent, last_date FROM users WHERE user_id = $1', [userId]);
        let dailySpent = 0;
        if (user.rows.length > 0 && user.rows[0].last_date === today) {
            dailySpent = parseFloat(user.rows[0].daily_spent) || 0;
        } else {
            await pool.query('UPDATE users SET daily_spent = 0, last_date = $1 WHERE user_id = $2', [today, userId]);
        }
        const dailyLimit = 100;
        const newTotal = dailySpent + amount;
        console.log(`[check-limit] المستخدم ${userId}: أنفق ${dailySpent}، يريد ${amount}، الحد ${dailyLimit}`);
        if (newTotal > dailyLimit) {
            return res.json({ allowed: false, spent: dailySpent, limit: dailyLimit, remaining: dailyLimit - dailySpent });
        }
        res.json({ allowed: true, spent: dailySpent, limit: dailyLimit });
    } catch (err) {
        console.error('[check-limit] ❌ خطأ:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/record-spending', async (req, res) => {
    const { userId, amount } = req.body;
    if (!userId || !amount) {
        console.warn('[record-spending] ❌ Missing userId or amount');
        return res.status(400).json({ error: 'Missing userId or amount' });
    }
    try {
        const today = new Date().toDateString();
        await pool.query(`
            INSERT INTO users (user_id, daily_spent, last_date)
            VALUES ($1, $2, $3)
            ON CONFLICT (user_id) DO UPDATE
            SET daily_spent = users.daily_spent + $2, last_date = $3
        `, [userId, amount, today]);
        console.log(`[record-spending] ✅ تسجيل إنفاق ${amount} للمستخدم ${userId}`);
        res.json({ success: true });
    } catch (err) {
        console.error('[record-spending] ❌ خطأ:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ================================================================
// 5. نظام الدفع (Webhook + Payment Status + Idempotency)
// ================================================================

app.post('/webhook', express.json(), async (req, res) => {
    console.log('[webhook] 📥 استلام طلب Webhook');

    const xsollaSign = req.headers['authorization'];
    const body = JSON.stringify(req.body);
    const expected = 'Signature ' + crypto.createHash('sha1').update(body + WEBHOOK_SECRET).digest('hex');

    if (xsollaSign !== expected) {
        console.warn('[webhook] ❌ توقيع غير صحيح');
        return res.status(401).json({ error: 'Invalid signature' });
    }
    console.log('[webhook] ✅ توقيع صحيح');

    const { notification_type, user, purchase, order } = req.body;
    const eventId = order?.id || 'unknown_' + Date.now();
    const userId = user?.id;

    try {
        const existing = await pool.query('SELECT processed FROM webhook_logs WHERE event_id = $1', [eventId]);
        if (existing.rows.length > 0) {
            if (existing.rows[0].processed) {
                console.log(`[webhook] ⚠️ حدث مكرر: ${eventId}`);
                return res.status(200).json({ success: true, message: 'already processed' });
            }
        } else {
            await pool.query('INSERT INTO webhook_logs (event_id, user_id) VALUES ($1, $2)', [eventId, userId]);
        }
    } catch (err) {
        console.error('[webhook] ❌ خطأ في Idempotency:', err.message);
        return res.status(500).json({ error: 'Internal error' });
    }

    console.log(`[webhook] 📋 notification_type: ${notification_type}, user: ${userId}`);

    if (notification_type === 'payment') {
        const sku = purchase?.virtual_items?.items?.[0]?.sku || '';
        const orderId = order?.id;
        const gemsAmount = getGemsFromSku(sku);
        const tier = getTierFromSku(sku);

        if (userId) {
            try {
                if (gemsAmount > 0) {
                    await pool.query(`
                        INSERT INTO users (user_id, gems)
                        VALUES ($1, $2)
                        ON CONFLICT (user_id) DO UPDATE
                        SET gems = users.gems + $2
                    `, [userId, gemsAmount]);
                    console.log(`[webhook] ✅ تم إضافة ${gemsAmount} جوهرة للمستخدم ${userId}`);
                }

                await pool.query(`
                    INSERT INTO payments (user_id, order_id, tier)
                    VALUES ($1, $2, $3)
                `, [userId, orderId, tier]);

                await pool.query('UPDATE webhook_logs SET processed = TRUE WHERE event_id = $1', [eventId]);

                console.log(`[webhook] ✅ تم تسجيل الدفع للمستخدم ${userId} (SKU: ${sku})`);
            } catch (err) {
                console.error('[webhook] ❌ خطأ في تحديث الرصيد:', err.message);
                return res.status(500).json({ error: 'Database error' });
            }
        }
    }

    if (notification_type === 'refund') {
        console.log(`[webhook] 💰 استرداد للمستخدم ${userId}`);
        // TODO: خصم الجواهر هنا
    }

    res.status(200).json({ success: true });
});

app.get('/payment-status', async (req, res) => {
    const userId = req.query.user_id;
    if (!userId) {
        console.warn('[payment-status] ❌ Missing user_id');
        return res.status(400).json({ error: 'user_id مطلوب' });
    }
    try {
        const result = await pool.query('SELECT gems FROM users WHERE user_id = $1', [userId]);
        if (result.rows.length === 0) {
            return res.json({ paid: false, tier: 'free', gems: 0 });
        }
        const payment = await pool.query('SELECT tier, paid_at FROM payments WHERE user_id = $1 ORDER BY paid_at DESC LIMIT 1', [userId]);
        if (payment.rows.length > 0) {
            return res.json({
                paid: true,
                tier: payment.rows[0].tier,
                gems: result.rows[0].gems,
                paidAt: payment.rows[0].paid_at
            });
        }
        res.json({ paid: false, tier: 'free', gems: result.rows[0].gems });
    } catch (err) {
        console.error('[payment-status] ❌ خطأ:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ================================================================
// 6. توليد رابط الدفع
// ================================================================
app.post('/generate-token', async (req, res) => {
    const { user_id, item_sku } = req.body;
    console.log(`[generate-token] 📥 طلب: user=${user_id}, sku=${item_sku}`);

    if (!user_id || !item_sku) {
        console.warn('[generate-token] ❌ Missing user_id or item_sku');
        return res.status(400).json({ error: 'Missing user_id or item_sku' });
    }

    try {
        const auth = Buffer.from(`${PROJECT_ID}:${API_KEY}`).toString('base64');

        const payload = {
            user: { id: { value: user_id } },
            settings: {
                project_id: parseInt(PROJECT_ID),
                mode: 'sandbox',
                return_url: RETURN_URL
            },
            purchase: { items: [{ sku: item_sku, quantity: 1 }] }
        };

        const response = await axios.post(
            `https://api.xsolla.com/merchant/v2/merchants/${PROJECT_ID}/token`,
            payload,
            {
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        console.log('[generate-token] ✅ تم إنشاء التوكن بنجاح');
        res.json({ token: response.data.token });
    } catch (error) {
        console.error('[generate-token] ❌ خطأ Xsolla:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to generate token' });
    }
});

// ================================================================
// 7. المسارات الأساسية
// ================================================================
app.get('/', (req, res) => {
    res.send('✅ السيرفر شغال!');
});

// ================================================================
// 8. تشغيل السيرفر
// ================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📊 Project ID: ${PROJECT_ID}`);
    console.log(`🔗 Return URL: ${RETURN_URL}`);
});
                      
