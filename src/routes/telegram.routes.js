import { Router } from 'express';
import logger from '../logger.js';
import { checkSecret, handleUpdate } from '../telegram/slip-bot.service.js';

/** Telegram webhook for @OptionPayBot. Answers 200 at once; the slip is checked afterwards. */
export const telegramRouter = Router();

telegramRouter.post('/slip-bot', async (req, res) => {
  if (!(await checkSecret(req.get('x-telegram-bot-api-secret-token')).catch(() => false))) return res.status(401).json({ ok: false });
  res.json({ ok: true });
  handleUpdate(req.body).catch((err) => logger.warn({ err: err.message }, 'slip bot: update failed'));
});

export default telegramRouter;
