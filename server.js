const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PROJECT_ID = process.env.XSOLLA_PROJECT_ID;
const API_KEY = process.env.XSOLLA_API_KEY;
const WEBHOOK_SECRET = process.env.XSOLLA_WEBHOOK_SECRET;

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

app.post('/webhook', (req, res) => {
    const notification_type = req.body.notification_type;
    console.log('Webhook received:', notification_type);
    res.status(200).json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
