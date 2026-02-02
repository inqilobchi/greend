const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  userId: { type: Number, required: true, unique: true },
  referals: { type: [Number], default: [] },
  referalCount: { type: Number, default: 0 },
  referrer: { type: Number, default: null }
});

module.exports = mongoose.model('User', userSchema);
