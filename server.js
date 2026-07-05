const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PROJECT_ID = process.env.XSOLLA_PROJECT_ID;
const API_KEY = process.env.XSOLLA_API_KEY;
const WEBHOOK_SECRET = process.env.XSOLLA_WEBHOOK_SECRET;

// ================================================================
// 🛡️ نظام الحماية (PIN + Daily Limit)
// ================================================================
let securityDB = {};

app.post('/set-pin', (req, res) => {
    const { userId, pin } = req.body;
    if (!userId || !pin) {
        return res.status(400).json({ error: 'userId and pin required' });
    }
    if (!securityDB[userId]) securityDB[userId] = {};
    securityDB[userId].pin = pin;
    res.json({ success: true, message: 'تم تعيين الرمز السري' });
});

app.post('/verify-pin', (req, res) => {
    const { userId, pin } = req.body;
    if (!userId || !pin) {
        return res.status(400).json({ error: 'userId and pin required' });
    }
    const user = securityDB[userId];
    if (!user || !user.pin) {
        return res.json({ valid: false, message: 'لم يتم تعيين رمز سري بعد' });
    }
    if (user.pin === pin) {
        return res.json({ valid: true });
    } else {
        return res.json({ valid: false, message: 'رمز سري غير صحيح' });
    }
});

app.post('/check-limit', (req, res) => {
    const { userId, amount } = req.body;
    const today = new Date().toDateString();
    if (!securityDB[userId]) {
        securityDB[userId] = { dailySpent: 0, lastDate: today };
    }
    const user = securityDB[userId];
    if (user.lastDate !== today) {
        user.dailySpent = 0;
        user.lastDate = today;
    }
    const dailyLimit = 100;
    const newTotal = user.dailySpent + amount;
    if (newTotal > dailyLimit) {
        return res.json({
            allowed: false,
            spent: user.dailySpent,
            limit: dailyLimit,
            remaining: dailyLimit - user.dailySpent
        });
    }
    return res.json({
        allowed: true,
        spent: user.dailySpent,
        limit: dailyLimit
    });
});

app.post('/record-spending', (req, res) => {
    const { userId, amount } = req.body;
    const today = new Date().toDateString();
    if (!securityDB[userId]) {
        securityDB[userId] = { dailySpent: 0, lastDate: today };
    }
    const user = securityDB[userId];
    if (user.lastDate !== today) {
        user.dailySpent = 0;
        user.lastDate = today;
    }
    user.dailySpent += amount;
    res.json({ success: true, dailySpent: user.dailySpent });
});

app.get('/security-status/:userId', (req, res) => {
    const userId = req.params.userId;
    const today = new Date().toDateString();
    const user = securityDB[userId] || { dailySpent: 0, lastDate: today, pin: null };
    if (user.lastDate !== today) {
        user.dailySpent = 0;
        user.lastDate = today;
    }
    res.json({
        hasPin: !!user.pin,
        dailySpent: user.dailySpent,
        limit: 100,
        remaining: 100 - user.dailySpent
    });
});

// ================================================================
// 💳 نظام الدفع الآمن (Webhook + Payment Status)
// ================================================================
const paymentRecords = {};

app.post('/webhook', express.json(), (req, res) => {
    const xsollaSign = req.headers['authorization'];
    const body = JSON.stringify(req.body);
    const expected = 'Signature ' + crypto
        .createHash('sha1')
        .update(body + WEBHOOK_SECRET)
        .digest('hex');

    if (xsollaSign !== expected) {
        console.warn('[webhook] ❌ توقيع غير صحيح');
        return res.status(401).json({ error: 'Invalid signature' });
    }

    const { notification_type, user, purchase, order } = req.body;

    if (notification_type === 'payment') {
        const userId = user?.id;
        const sku = purchase?.virtual_items?.items?.[0]?.sku || '';
        const orderId = order?.id;

        const skuToTier = {
            'gems_100': 'paid',
            'gems_500': 'vip',
            'vip_monthly': 'vip',
            'vip_yearly': 'whale',
            'dev_support': 'paid'
        };
        const tier = skuToTier[sku] || 'paid';

        if (userId) {
            const existing = paymentRecords[userId];
            const tierOrder = ['free', 'paid', 'vip', 'whale'];
            const shouldUpgrade = !existing ||
                tierOrder.indexOf(tier) > tierOrder.indexOf(existing.tier);

            if (shouldUpgrade) {
                paymentRecords[userId] = { tier, orderId, paidAt: Date.now() };
                console.log(`[webhook] ✅ تم ترقية المستخدم ${userId} إلى ${tier}`);
            }
        }
    }

    res.status(200).json({ success: true });
});

app.get('/payment-status', (req, res) => {
    const userId = req.query.user_id;
    if (!userId) return res.status(400).json({ error: 'user_id مطلوب' });

    const record = paymentRecords[userId];
    if (record) {
        return res.json({
            paid: true,
            tier: record.tier,
            orderId: record.orderId,
            paidAt: record.paidAt
        });
    }

    return res.json({ paid: false, tier: 'free' });
});

// ================================================================
// 🚀 المسارات الأساسية
// ================================================================
app.get('/', (req, res) => {
    res.send('✅ السيرفر شغال!');
});

app.post('/generate-token', async (req, res) => {
    const { user_id, item_sku } = req.body;
    if (!user_id || !item_sku) {
        return res.status(400).json({ error: 'Missing user_id or item_sku' });
    }

    try {
        const auth = Buffer.from(`${PROJECT_ID}:${API_KEY}`).toString('base64');

        const response = await axios.post(
            `https://api.xsolla.com/merchant/v2/merchants/${PROJECT_ID}/token`,
            {
                user: { id: { value: user_id } },
                settings: { project_id: parseInt(PROJECT_ID), mode: 'sandbox' },
                purchase: { items: [{ sku: item_sku, quantity: 1 }] }
            },
            {
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        res.json({ token: response.data.token });
    } catch (error) {
        console.error('Xsolla Error:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to generate token' });
    }
});

// ================================================================
// تشغيل السيرفر
// ================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
});
