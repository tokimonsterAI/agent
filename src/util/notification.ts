import { Bot, type Api } from 'grammy';

const botToken = process.env.TOKIMONSTER_NOTIFICATION_TELEGRAM_TOKEN ?? 'FAKE_TOKEN';
const isFakedBotToken = botToken === 'FAKE_TOKEN';

const bot = new Bot(botToken);

const TOKIMONSTER_GROUP_CHAT_ID = '-1002271852446';
const TOKIMONSTER_MSG_THREAD = {
    ALERT: 2,
    SUCCESS: 291
};

const sendMessage = (...params: Parameters<Api['sendMessage']>) => {
    if (isFakedBotToken) {
        console.log('[Notification] skipped send message', params);

        return;
    }

    return bot.api
        .sendMessage(...params)
        .catch(err => {
            console.error('[Notification] failed to send message', err, params);
        });
};

const info = (text: string) => sendMessage(TOKIMONSTER_GROUP_CHAT_ID, text);

const error = (text: string) => sendMessage(TOKIMONSTER_GROUP_CHAT_ID, text, { message_thread_id: TOKIMONSTER_MSG_THREAD.ALERT });

const success = (text: string) => sendMessage(TOKIMONSTER_GROUP_CHAT_ID, text, { message_thread_id: TOKIMONSTER_MSG_THREAD.SUCCESS });

export default {
    info,
    error,
    success
};
