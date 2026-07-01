const express = require('express');
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.send('✅ السيرفر شغال!');
});

app.post('/webhook', (req, res) => {
  console.log('📥 إشعار Xsolla:', req.body);
  res.send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 السيرفر شغال على البورت ${PORT}`);
});
