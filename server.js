require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const FRONTEND_URL = process.env.FRONTEND_URL;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

// ═══════════════════════════════════════════
//  Middleware Setup
// ═══════════════════════════════════════════
app.use(express.json());
app.use(cors({
  origin: FRONTEND_URL,
  methods: ['GET', 'POST'],
  credentials: true
}));

// ═══════════════════════════════════════════
//  Telegram Bot Setup (Webhook Mode)
// ═══════════════════════════════════════════
const bot = new TelegramBot(BOT_TOKEN, { webHook: true });

const webhookPath = `/webhook/${BOT_TOKEN}`;

// Render deploy ပြီးတာနဲ့ webhook ကို auto set လုပ်ပေးတယ်
bot.setWebHook(`${WEBHOOK_URL}${webhookPath}`)
  .then(() => console.log('✅ Webhook set successfully'))
  .catch(err => console.error('❌ Webhook error:', err.message));

// Telegram က update တွေကို ဒီ endpoint ကနေ ပို့လာမယ်
app.post(webhookPath, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ═══════════════════════════════════════════
//  Bot Commands
// ═══════════════════════════════════════════

// /start command - User က bot ကို စတင် message ပို့တာနဲ့ trigger ဖြစ်မယ်
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from.first_name || 'User';
  const username = msg.from.username ? `@${msg.from.username}` : '';

  const welcomeText = 
    `👋 မင်္ဂလာပါ ${firstName}! ${username}\n\n` +
    `🚀 ကျွန်တော်တို့ရဲ့ Mini App ထဲသို့ ကြိုဆိုပါတယ်။\n\n` +
    `အောက်ပါ button ကို နှိပ်ပြီး Website ထဲ ဝင်ရောက်နိုင်ပါတယ်။`;

  try {
    await bot.sendMessage(chatId, welcomeText, {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '🌐 Website သို့ ဝင်ရန်',
              web_app: { url: FRONTEND_URL }
            }
          ],
          [
            {
              text: '📞 Support',
              url: 'https://t.me/your_support_username' // သင့် support username ထည့်ပါ
            }
          ]
        ]
      }
    });
  } catch (err) {
    console.error('Send message error:', err.message);
  }
});

// /help command
bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId,
    `📋 အကူအညီ\n\n` +
    `/start - Bot စတင်ရန်\n` +
    `/help - အကူအညီ ကြည့်ရန်\n\n` +
    `Website သို့ ဝင်ရောက်ရန် /start ကို နှိပ်ပါ။`
  );
});

// ═══════════════════════════════════════════
//  API Endpoints
// ═══════════════════════════════════════════

// Health Check - Server အလုပ်လုပ်နေကြောင်း စစ်ဆေးရန်
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Server is running',
    timestamp: new Date().toISOString()
  });
});

// initData Validation API
// Frontend က Telegram initData ကို ဒီမှာ ပို့ပြီး စစ်ဆေးမယ်
app.post('/api/validate', (req, res) => {
  const { initData } = req.body;

  if (!initData) {
    return res.status(400).json({
      valid: false,
      error: 'initData မပါဘူး'
    });
  }

  try {
    const isValid = validateTelegramInitData(initData, BOT_TOKEN);

    if (!isValid) {
      return res.status(401).json({
        valid: false,
        error: 'initData မှားယွင်းနေသည် - Unauthorized'
      });
    }

    // User data parse လုပ်မယ်
    const params = new URLSearchParams(initData);
    const userStr = params.get('user');
    const user = userStr ? JSON.parse(userStr) : null;
    const authDate = params.get('auth_date');

    return res.json({
      valid: true,
      user: {
        id: user?.id,
        first_name: user?.first_name,
        last_name: user?.last_name,
        username: user?.username,
        language_code: user?.language_code,
        is_premium: user?.is_premium || false
      },
      auth_date: authDate
    });

  } catch (error) {
    console.error('Validation error:', error);
    return res.status(500).json({
      valid: false,
      error: 'Server error ဖြစ်သွားသည်'
    });
  }
});

// Example: User Profile save/get API (Optional - Database ချိတ်ဆက်လိုက သုံးနိုင်)
app.post('/api/user/save', (req, res) => {
  const { initData, extraData } = req.body;

  const isValid = validateTelegramInitData(initData, BOT_TOKEN);
  if (!isValid) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ဒီနေရာမှာ Database (MongoDB, PostgreSQL, etc.) သိမ်းနိုင်တယ်
  // ယခု demo အတွက် success ပြန်ပေးတယ်
  res.json({ success: true, message: 'User data saved successfully' });
});

// ═══════════════════════════════════════════
//  Telegram initData Validation Function
//  Telegram Official Documentation အတိုင်း
// ═══════════════════════════════════════════
function validateTelegramInitData(initData, botToken) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');

    if (!hash) return false;

    params.delete('hash');

    // Alphabetical order နဲ့ sort လုပ်မယ်
    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    // Secret key ဆောက်မယ် - "WebAppData" သည် Telegram specification
    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(botToken)
      .digest();

    // Hash တွက်ပြီး compare လုပ်မယ်
    const calculatedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    return calculatedHash === hash;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════
//  Server Start
// ═══════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Webhook path: ${webhookPath}`);
  console.log(`🌐 Frontend URL: ${FRONTEND_URL}`);
});
