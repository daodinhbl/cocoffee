const logger = require('../../utils/logger');
const zaloConfig = require('./zaloConfig');
const zaloBot = require('./zaloBotPlatform');
const zaloApi = require('./zaloApiService');

/**
 * A text message to the shop owner's Zalo chat (the one saved as the debt/notice recipient in Admin > Zalo).
 * A courtesy: never throws. Statuses: 'sent' | 'not_configured' | 'push_not_supported' | 'failed'.
 * @param {string} text
 * @param {{ skipChatId?: string }} [opts] do not send when the owner chat IS this chat (the owner already got it there)
 */
async function notifyOwner(text, { skipChatId } = {}) {
  try {
    const config = await zaloConfig.get();
    if (!config.debtOwnerChatId) return 'not_configured';
    if (skipChatId && String(skipChatId) === String(config.debtOwnerChatId)) return 'same_chat';
    if (config.mode === 'platform') await zaloBot.sendText(config.debtOwnerChatId, text);
    else if (config.mode === 'oa') await zaloApi.sendText({ chatType: config.debtOwnerChatType, chatId: config.debtOwnerChatId }, text);
    else return 'push_not_supported';
    return 'sent';
  } catch (err) {
    logger.warn('Message to the owner not delivered', err);
    return 'failed';
  }
}

module.exports = { notifyOwner };
