const User = require('./models/User');
const { ADMIN_IDS } = process.env;

// Adminligini tekshirish funksiyasi
function isAdmin(userId) {
  return ADMIN_IDS.includes(String(userId));
}

module.exports = (bot) => {
  // /panel komandasi
  bot.onText(/\/panel/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isAdmin(userId)) return;

    // Jami foydalanuvchilar soni
    const usersCount = await User.countDocuments();

    // Jami referallar soni
    const totalReferalsAgg = await User.aggregate([
      { $group: { _id: null, total: { $sum: "$referalCount" } } }
    ]);
    const totalReferals = totalReferalsAgg[0]?.total || 0;

    // Eng ko'p referalga ega 5 foydalanuvchini topish
    const topUsers = await User.find({})
      .sort({ referalCount: -1 })
      .limit(5)
      .select('userId referalCount -_id');

    // Top foydalanuvchilar ro'yxatini tayyorlash
    let topListText = '';
    topUsers.forEach((user, index) => {
      topListText += `${index + 1}. ID: <code>${user.userId}</code> - Referal: <b>${user.referalCount}</b>\n`;
    });

    const text = `
<b>🛠 Admin Panel</b>

👥 Jami foydalanuvchilar: <b>${usersCount}</b>
🔁 Jami referallar: <b>${totalReferals}</b>

🏆 Eng ko'p referalga ega 5 foydalanuvchi:
${topListText || 'Top foydalanuvchi yo‘q'}

Quyidagilardan birini tanlang:
    `;

    const opts = {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '➕ Referal qo‘shish', callback_data: 'admin_add_ref' }],
          [{ text: '➖ Referal ayirish', callback_data: 'admin_sub_ref' }],
          [{ text: '📢 E’lon yuborish', callback_data: 'admin_broadcast' }]
        ]
      }
    };

    bot.sendMessage(chatId, text, opts);
  });

  // Callback query larni qabul qilish
  bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;
    const userId = query.from.id;

    if (!isAdmin(userId)) return;

    if (data === 'admin_add_ref' || data === 'admin_sub_ref') {
      bot.sendMessage(chatId, `📝 Iltimos, ID va miqdorni yuboring:\n\nMasalan: <code>123456789 5</code>`, {
        parse_mode: 'HTML'
      });

      bot.once('message', async (msg) => {
        if (msg.chat.id !== chatId) return;
        const [id, count] = msg.text.trim().split(' ');
        const targetId = parseInt(id, 10);
        const refCount = parseInt(count, 10);

        if (isNaN(targetId) || isNaN(refCount)) {
          return bot.sendMessage(chatId, '❌ Noto‘g‘ri format.');
        }

        const user = await User.findOne({ userId: targetId });
        if (!user) return bot.sendMessage(chatId, '❌ Foydalanuvchi topilmadi.');

        if (data === 'admin_add_ref') {
          user.referalCount += refCount;
          await user.save();
          bot.sendMessage(chatId, `✅ ${refCount} referal qo‘shildi. Yangi balans: ${user.referalCount}`);
        } else {
          user.referalCount = Math.max(user.referalCount - refCount, 0);
          await user.save();
          bot.sendMessage(chatId, `✅ ${refCount} referal ayirildi. Yangi balans: ${user.referalCount}`);
        }
      });
    }

    if (data === 'admin_broadcast') {
      bot.sendMessage(chatId, '📢 E’lon matnini (yoki video, rasm, audio, fayl) yuboring:');

      bot.once('message', async (msg) => {
        if (msg.chat.id !== chatId) return;
        const users = await User.find({}, 'userId');

        for (const u of users) {
          try {
            if (msg.text) {
              await bot.sendMessage(u.userId, msg.text);
            } else if (msg.photo) {
              const fileId = msg.photo[msg.photo.length - 1].file_id;
              await bot.sendPhoto(u.userId, fileId, { caption: msg.caption });
            } else if (msg.video) {
              await bot.sendVideo(u.userId, msg.video.file_id, { caption: msg.caption });
            } else if (msg.document) {
              await bot.sendDocument(u.userId, msg.document.file_id, { caption: msg.caption });
            } else {
              continue;
            }
          } catch (err) {
            console.error(`Foydalanuvchiga yuborilmadi: ${u.userId}`, err.message);
          }
        }

        bot.sendMessage(chatId, '✅ E’lon barcha foydalanuvchilarga yuborildi.');
      });
    }
  });
};
