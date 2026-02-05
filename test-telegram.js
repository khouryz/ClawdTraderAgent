/**
 * Quick Telegram test script
 * Run: node test-telegram.js
 */

require('dotenv').config();
const https = require('https');

const token = process.env.TELEGRAM_BOT_TOKEN || '8505966379:AAG3exBfT-kktzwJpQZidpbyASHr_9XqzIo';
const chatId = process.env.TELEGRAM_CHAT_ID || '1163283026';

const message = `✅ TradovateBot Connected!

Your trading bot is now set up to send notifications.

You'll receive alerts for:
📈 Trade entries
💰 Profitable exits  
📉 Losing exits
❌ Errors
📊 Daily summaries

Bot is ready! 🚀`;

const payload = JSON.stringify({
  chat_id: chatId,
  text: message
});

const options = {
  hostname: 'api.telegram.org',
  port: 443,
  path: `/bot${token}/sendMessage`,
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  }
};

console.log('Sending test message to Telegram...');

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    if (res.statusCode === 200) {
      console.log('✅ Message sent successfully! Check your Telegram.');
    } else {
      console.log('❌ Failed:', data);
    }
  });
});

req.on('error', (e) => {
  console.error('❌ Error:', e.message);
});

req.write(payload);
req.end();
