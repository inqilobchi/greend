require('dotenv').config();
const axios = require('axios');
const Fastify = require('fastify');
const fastify = Fastify({ logger: true });
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const User = require('./models/User');
const adminPanel= require('./admin'); 
const REQUIRED_CHANNELS = (process.env.REQUIRED_CHANNELS || '').split(',').map(ch => ch.trim()).filter(Boolean);
const MONGO_URI = process.env.MONGO_URI;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
const tempReferrers = new Map(); 
const API_KEY = process.env.API_KEY; 
const API_URL = 'https://seensms.uz/api/v1';
const userStates = new Map(); 
const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { webHook: true });
const PRICES = {
  stars: {
    perStar: 3,          // 1 ta star = 3 referal
    min: 2,
    max: 5
  },
  subscribers: {
    per10: 1,            // 10 ta obunachi = 1 referal (siz xohlagan holat)
    min: 50,
    max: 200,
    step: 10             // 10 ga bo‘linishi shart
  }
};
const WEBHOOK_PATH = `/webhook/${token}`;
const FULL_WEBHOOK_URL = `${process.env.PUBLIC_URL}${WEBHOOK_PATH}`;

// Webhook endpoint
fastify.post(WEBHOOK_PATH, (req, reply) => {
  try {
    bot.processUpdate(req.body);  // Telegram update-larni botga uzatish juda muhim
    console.log('Update processed:', req.body);
    reply.code(200).send();       // Telegram API uchun 200 OK javob qaytarish kerak
  } catch (error) {
    console.error('Error processing update:', error);
    reply.sendStatus(500);
  }
});

// Health check endpoint
fastify.get('/healthz', (req, reply) => {
  reply.send({ status: 'ok' });
});

// Serverni ishga tushirish va webhook o‘rnatish
fastify.listen({ port: process.env.PORT || 3000, host: '0.0.0.0' }, async (err, address) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }

  fastify.log.info(`Server listening at ${address}`);

  try {
const response = await axios.post(`https://api.telegram.org/bot${token}/setWebhook`, null, {
  params: { url: FULL_WEBHOOK_URL }
});

    if (response.data.ok) {
      fastify.log.info('Webhook successfully set:', response.data);
    } else {
      fastify.log.error('Failed to set webhook:', response.data);
    }
  } catch (error) {
    fastify.log.error('Error setting webhook:', error.message);
  }
});
bot.getMe().then((botInfo) => {
  bot.me = botInfo;
  console.log(`🤖 Bot ishga tushdi: @${bot.me.username}`);
}).catch((err) => {
  console.error("Bot ma'lumotini olishda xatolik:", err.message);
});
adminPanel(bot)
mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  console.log('MongoDBga ulandi');
}).catch(err => {
  console.error('MongoDB ulanishda xatolik:', err);
  process.exit(1);
});
// Obuna tekshiruvchi
async function isUserSubscribed(userId) {
  if (!REQUIRED_CHANNELS.length) return true; 

  for (const channel of REQUIRED_CHANNELS) {
    try {
      const res = await bot.getChatMember(channel, userId);
      if (!['member', 'creator', 'administrator'].includes(res.status)) {
        return false; 
      }
    } catch (err) {
      console.error(`Obuna tekshirishda xatolik [${channel}]:`, err.message);
      return false;
    }
  }

  return true;
}
async function getSubscriptionMessage() {
  const buttons = [];

  for (const channel of REQUIRED_CHANNELS) {
    try {
      const chat = await bot.getChat(channel);
      const title = chat.title || channel;
      const channelLink = `https://t.me/${channel.replace('@', '')}`;
      buttons.push([{ text: `${title}`, url: channelLink }]);
    } catch (err) {
      console.error(`Kanal nomini olishda xatolik: ${channel}`, err.message);
      // fallback
      buttons.push([{ text: `${channel}`, url: `https://t.me/${channel.replace('@', '')}` }]);
    }
  } 
  const SUPPORT_BOT_LINK = 'https://t.me/TurfaSeenBot?start=user19';
  const SUPPORT_BOT_TITILE = 'Turfa Seen | Rasmiy🤖';
  buttons.push([{ text: `${SUPPORT_BOT_TITILE}`, url: SUPPORT_BOT_LINK }]);  
  buttons.push([{ text: '✅ Obuna bo‘ldim', callback_data: 'check_subscription' }]);

  return {
    text: `<b>❗ Botdan foydalanish uchun quyidagi kanallarga obuna bo‘ling:</b>`,
    options: {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: buttons
      }
    }
  };
}


async function getUser(userId) {
  return User.findOne({ userId }).exec();
}

async function addUser(userId, referrerId = null) {
  let exists = await getUser(userId);
  if (exists) return exists;

  const userDoc = new User({
    userId,
    referals: [],
    referalCount: 0,
    referrer: null
  });

if (referrerId && referrerId !== userId) {
  const referrer = await getUser(referrerId);

  if (referrer) {
    userDoc.referrer = referrerId;
    await User.updateOne(
      { userId: referrerId },
      { $addToSet: { referals: userId }, $inc: { referalCount: 1 } }
    );
  } else {
    // Agar referrer bazada yo'q bo‘lsa, uni yaratamiz
    await addUser(referrerId);
    await User.updateOne(
      { userId: referrerId },
      { $addToSet: { referals: userId }, $inc: { referalCount: 1 } }
    );
  }

  userDoc.referrer = referrerId;

  // Referal haqida xabar
  bot.sendMessage(referrerId, `<b>🎉 Sizga yangi referal qo'shildi!</b>\n<a href='tg://user?id=${userId}'>👤Ro'yxatdan o'tdi : ${userId}</a> `, {parse_mode : 'HTML'});
}

  await userDoc.save();
  return userDoc;
}

async function decrementReferals(userId, count = 5) {
  const user = await getUser(userId);
  if (!user || user.referalCount < count) return false;

  const newReferals = user.referals.slice(count);
  await User.updateOne(
    { userId },
    { $set: { referals: newReferals }, $inc: { referalCount: -count } }
  );
  return true;
}
function mainMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🛒 Buyurtma berish', callback_data: 'place_order' }],
        [{text: `🌹 Sovg'a olish 🧸`, callback_data : 'get_gift'}],
        [{ text: '👥 Referal tizimi 🔖', callback_data: 'ref_system' }],
      ]
    }
  };
}
function backButton() {
  return {
    reply_markup: {
      inline_keyboard: [[
        { text: '🚫 Bekor qilish', callback_data: 'backtomain' }
      ]]
    }
  };
}
async function referalMenu(userId) {
  const user = await getUser(userId);
  const referalCount = user?.referalCount || 0;
  const refLink = `https://t.me/${bot.me.username}?start=${userId}`;

  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: `Referallar soni: ${referalCount}`, callback_data: 'ref_count' }],
        [{ text: '📝 Referal havola', callback_data: 'ref_link' }],
        [{ text: '⬅️ Orqaga', callback_data: 'back_to_main' }],
      ]
    },
    text: `👥 Sizning referallar soningiz: ${referalCount}\n🔗 Havolangiz:\n<code>${refLink}</code>\nUstiga bosilsa nusxa olinadi👆🏻`
  };
}
const gifts = {
  '15stars_heart' : {title : '💝', price : 25},
  '15stars_bear': {title : '🧸', price : 25},
  '25stars_rose' : {title : '🌹', price : 35},
  '25stars_gift' : {title : '🎁', price : 35}
}
bot.onText(/\/start(?: (\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const referrerId = match[1] ? parseInt(match[1], 10) : null;
  if (referrerId) {
    tempReferrers.set(userId, referrerId);
  }
  
  if (!(await isUserSubscribed(userId))) {
    const sub = await getSubscriptionMessage();
    return bot.sendMessage(chatId, sub.text, sub.options);
  }
  
  await addUser(userId, referrerId);
  await bot.sendMessage(chatId, `🌱`, mainMenu());
});

bot.on('callback_query', async (callbackQuery) => {
  const data = callbackQuery.data;
  const msg = callbackQuery.message;
  const userId = callbackQuery.from.id;
  const chatId = msg.chat.id;

  // 🔒 Obuna tekshirish
if (data === 'check_subscription') {
  if (await isUserSubscribed(userId)) {
    const referrerId = tempReferrers.get(userId) || null;
    await addUser(userId, referrerId);
    tempReferrers.delete(userId);
    return bot.sendMessage(chatId, '✅ Obuna tasdiqlandi!', mainMenu());
  } else {
    const sub = await getSubscriptionMessage();
    return bot.sendMessage(chatId, sub.text, sub.options);
  }
}

if (data === 'place_order') {
  await bot.answerCallbackQuery(callbackQuery.id);
  return bot.editMessageText('📝 Buyurtma turini tanlang:', {
    chat_id: chatId,
    message_id: msg.message_id,
    reply_markup: {
      inline_keyboard: [
        [{ text: '⭐ Stars olish', callback_data: 'get_stars' }],
        [{ text: '👥 Obunachi qo‘shish', callback_data: 'add_subscribers' }],
        [{ text: '⬅️ Orqaga', callback_data: 'back_to_main' }]
      ]
    }
  });
}

if (data === 'get_stars') {
  const user = await getUser(userId);
  if (!user) {
    return bot.answerCallbackQuery(callbackQuery.id, { text: 'Iltimos /start buyrug‘ini yuboring.' });
  }
  await bot.answerCallbackQuery(callbackQuery.id);
  await bot.editMessageText(
    `<b>⭐ Stars olish</b>\n<b>⬇️ Minimal: 2 ta</b>\n<b>⬆️ Maksimal: 5 ta </b>\n\n<blockquote>⭐️ 1 star narxi: ${PRICES.stars.perStar} ta referal</blockquote>\n\nIltimos, stars sonini yuboring (masalan: 2):`,
    { chat_id: chatId, message_id: msg.message_id, parse_mode: 'HTML', ...backButton() }
  );
  userStates.set(userId, { state: 'waiting_for_star_count' }); 
  return;
}

if (data === 'add_subscribers') {
  const user = await getUser(userId);
  if (!user) {
    return bot.answerCallbackQuery(callbackQuery.id, { text: 'Iltimos /start buyrug‘ini yuboring.' });
  }
  await bot.answerCallbackQuery(callbackQuery.id);
  await bot.editMessageText(
    `<b>👥 Obunachi qo‘shish</b>\n<b>⬇️ Minimal: 50 ta </b>\n<b>⬆️ Maksimal: 200 ta</b>\n<blockquote>10 ta obunachi narxi: ${PRICES.subscribers.per10} ta referal</blockquote>\n\nIltimos, obunachilar sonini yuboring (masalan: 50):`,
    { chat_id: chatId, message_id: msg.message_id, parse_mode: 'HTML', ...backButton() }
  );
  userStates.set(userId, { state: 'waiting_for_sub_count' }); 
  return;
}
  if (data === 'back_to_main') {
    await bot.answerCallbackQuery(callbackQuery.id);
    return bot.editMessageText('Asosiy menyu', {
      chat_id: chatId,
      message_id: msg.message_id,
      ...mainMenu()
    });
  }

  if (data === 'ref_system') {
    const menu = await referalMenu(userId);
    await bot.answerCallbackQuery(callbackQuery.id);
    return bot.editMessageText(menu.text, {
      chat_id: chatId,
      message_id: msg.message_id,
      reply_markup: menu.reply_markup,
      parse_mode: 'HTML'
    });
  }
   if(data === 'backtomain') {
    await bot.answerCallbackQuery(callbackQuery.id);
     userStates.delete(userId);
    return bot.editMessageText('Asosiy menyu', {
      chat_id: chatId,
      message_id: msg.message_id,
      ...mainMenu()
    });
   }
  if (data === 'ref_count') {
    const user = await getUser(userId);
    return bot.answerCallbackQuery(callbackQuery.id, {
      text: `Sizda ${user?.referalCount || 0} ta referal bor.`
    });
  }

  if (data === 'ref_link') {
    const refLink = `https://t.me/${bot.me.username}?start=${userId}`;
    return bot.answerCallbackQuery(callbackQuery.id, {
      text: `Sizning referal havolangiz: ${refLink}`,
      show_alert: true
    });
  }
if (data === 'get_gift') {
  const user = await getUser(userId);
  if (!user) {
    return bot.answerCallbackQuery(callbackQuery.id, {
      text: 'Iltimos /start buyrug‘ini yuboring.'
    });
  }

  // Sovg'alar menyusini yaratish
  const giftButtons = Object.entries(gifts).map(([key, gift]) => {
    return [{ text: gift.title, callback_data: `gift_${key}` }];
  });
  giftButtons.push([{ text: '⬅️ Orqaga', callback_data: 'back_to_main' }]);
  await bot.answerCallbackQuery(callbackQuery.id);
  return bot.editMessageText("⤵️ Sovg'alardan birini tanlang:", {
    chat_id: chatId,
    message_id: msg.message_id,
    reply_markup: { inline_keyboard: giftButtons }
  });
}
if (data.startsWith('gift_')) {
  const giftKey = data.slice(5);
  const gift = gifts[giftKey];

  if (!gift) {
    return bot.answerCallbackQuery(callbackQuery.id, {
      text: '❌ Bunday sovg‘a topilmadi.'
    });
  }

  const user = await getUser(userId);
  if (!user) {
    return bot.answerCallbackQuery(callbackQuery.id, {
      text: 'Iltimos /start buyrug‘ini yuboring.'
    });
  }

  if (user.referalCount < gift.price) {
    return bot.answerCallbackQuery(callbackQuery.id, {
      text: `🚫 Bu sovg‘ani olish uchun kamida ${gift.price} ta referal kerak.`,
      show_alert: true
    });
  }

  return bot.editMessageText(
    `<b>✨ Siz ${gift.title} sovg‘asini tanladingiz.</b>\n<i>❗️Ushbu sovg‘ani olish uchun ${gift.price} ta referalingiz kamaytiriladi.\n\nSizga tashlab berilishi biroz vaqt olishi mumkin.</i>\n\n<b>Tasdiqlaysizmi?</b>`,
    {
      chat_id: chatId,
      message_id: msg.message_id,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Tasdiqlayman', callback_data: `confirm_gift_${giftKey}` }],
          [{ text: '⬅️ Orqaga', callback_data: 'get_gift' }]
        ]
      }
    }
  );
}

if (data.startsWith('confirm_gift_')) {
  const giftKey = data.slice('confirm_gift_'.length);
  const gift = gifts[giftKey];

  if (!gift) {
    return bot.answerCallbackQuery(callbackQuery.id, {
      text: '❌ Sovg‘a topilmadi.'
    });
  }

  const user = await getUser(userId);
  if (!user || user.referalCount < gift.price) {
    return bot.answerCallbackQuery(callbackQuery.id, {
      text: '❌ Yetarli referal yo‘q.',
      show_alert: true
    });
  }

  const success = await decrementReferals(userId, gift.price);
  if (!success) {
    return bot.answerCallbackQuery(callbackQuery.id, {
      text: '❌ Referal kamaytirishda xatolik.',
      show_alert: true
    });
  }

  // 🟢 Foydalanuvchiga xabar
  await bot.editMessageText(
    `<b>🎉 Tabriklaymiz! Siz ${gift.title}sovg‘asini oldingiz!</b> \n<u>Referallaringizdan ${gift.price} tasi olib tashlandi.</u>\n\n <b><i>Sabrli bo'ling admin faol bo'lgach sizga buyurtmangizni yetkazib beradi.🌝</i></b>`,
    {
      chat_id: chatId,
      message_id: msg.message_id,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '⬅️ Asosiy menyuga', callback_data: 'back_to_main' }]
        ]
      }
    }
  );

  // 👤 Foydalanuvchi ma'lumotlari
  const fullName = `${callbackQuery.from.first_name || ''} ${callbackQuery.from.last_name || ''}`.trim();
  const username = callbackQuery.from.username ? `@${callbackQuery.from.username}` : 'yo‘q';

  const userInfoText = `
🎁 <b>Sovg‘a buyurtma qilindi</b>

🎉 Sovg‘a: <b>${gift.title}</b>
💸 Narxi: <b>${gift.price} referal</b>

🆔 ID: <code>${userId}</code>
👤 Ism: <a href="tg://user?id=${userId}"><b>${fullName}</b></a>
🔗 Username: ${username}
`.trim();

  // 👨‍💻 Adminlarga yuborish
  for (const adminId of ADMIN_IDS) {
    bot.sendMessage(adminId, userInfoText, { parse_mode: 'HTML' });
  }
}

  return bot.answerCallbackQuery(callbackQuery.id, {
    text: '⚠️ Nomaʼlum buyruq.'
  });
});

bot.on('message', async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  const state = userStates.get(userId);
  if (!state) return; // Holat yo'q bo'lsa, e'tibor bermaymiz

  if (state.state === 'waiting_for_star_count') {
    const quantity = parseInt(text, 10);
    if (isNaN(quantity) || quantity < PRICES.stars.min || quantity > PRICES.stars.max) {
      return bot.sendMessage(chatId, `❌ Noto‘g‘ri son. Minimal ${PRICES.stars.min}, maksimal ${PRICES.stars.max}.`);
    }
    const requiredReferals = quantity * PRICES.stars.perStar;
    const user = await getUser(userId);
    if (user.referalCount < requiredReferals) {
      userStates.delete(userId);
      return bot.sendMessage(chatId, `🚫 Yetarli referal yo‘q. Kerak: ${requiredReferals} ta.`);
    }
    userStates.set(userId, { state: 'waiting_for_star_link', quantity });
    return bot.sendMessage(chatId, '📎 Endi ommaviy kanal post havolasini yuboring:');
  }

  if (state.state === 'waiting_for_star_link') {
    const link = text;
    if (!link.startsWith('http')) {
      return bot.sendMessage(chatId, '❌ Noto‘g‘ri havola.');
    }
    const { quantity } = state;
    const requiredReferals = quantity * PRICES.stars.perStar;
    const success = await decrementReferals(userId, requiredReferals);
    if (!success) {
      userStates.delete(userId);
      return bot.sendMessage(chatId, '❌ Referal kamaytirishda xatolik.');
    }

    try {
      const params = new URLSearchParams({
        key: API_KEY,
        action: 'add',
        service: 323, 
        link,
        quantity: quantity.toString()
      });
      const response = await fetch(`${API_URL}?${params.toString()}`);
      const data = await response.json();
      if (data.order) {
        bot.sendMessage(chatId, `✅ Buyurtma berildi!`);
      } else {
        bot.sendMessage(chatId, `❌ Xatolik: ${JSON.stringify(data)}`);
      }
    } catch (err) {
      bot.sendMessage(chatId, `❌ API xatolik: ${err.message}`);
    }
    userStates.delete(userId);
    return;
  }

  if (state.state === 'waiting_for_sub_count') {
    const quantity = parseInt(text, 10);
    if (
    isNaN(quantity) ||
    quantity < PRICES.subscribers.min ||
    quantity > PRICES.subscribers.max ||
    quantity % PRICES.subscribers.step !== 0
  ) {
      return bot.sendMessage(chatId, `❌ Noto‘g‘ri son. Minimal ${PRICES.subscribers.min}, maksimal ${PRICES.subscribers.max}, ${PRICES.subscribers.step} ga bo‘linadigan.`);
    }
    const requiredReferals = (quantity / 10) * PRICES.subscribers.per10;
    const user = await getUser(userId);
    if (user.referalCount < requiredReferals) {
      userStates.delete(userId);
      return bot.sendMessage(chatId, `🚫 Yetarli referal yo‘q. Kerak: ${requiredReferals} ta.`);
    }
    userStates.set(userId, { state: 'waiting_for_sub_link', quantity });
    return bot.sendMessage(chatId, '📎 Endi ommaviy kanal havolasini yuboring:');
  }

  if (state.state === 'waiting_for_sub_link') {
    const link = text;
    if (!link.startsWith('http')) {
      return bot.sendMessage(chatId, '❌ Noto‘g‘ri havola.');
    }
    const { quantity } = state;
    const requiredReferals = (quantity / 10) * PRICES.subscribers.per10;
    const success = await decrementReferals(userId, requiredReferals);
    if (!success) {
      userStates.delete(userId);
      return bot.sendMessage(chatId, '❌ Referal kamaytirishda xatolik.');
    }

    // API so'rovi
    try {
      const params = new URLSearchParams({
        key: API_KEY,
        action: 'add',
        service: 483, // Obunachi xizmati ID
        link,
        quantity: quantity.toString()
      });
      const response = await fetch(`${API_URL}?${params.toString()}`);
      const data = await response.json();
      if (data.order) {
        bot.sendMessage(chatId, `✅ Buyurtma berildi!`);
      } else {
        bot.sendMessage(chatId, `❌ Xatolik: ${JSON.stringify(data)}`);
      }
    } catch (err) {
      bot.sendMessage(chatId, `❌ API xatolik: ${err.message}`);
    }
    userStates.delete(userId);
    return;
  }
});
