import { Router } from 'express';
import { z } from 'zod';
import asyncHandler from '../middleware/asyncHandler.js';
import * as cfg from '../config-admin/config.service.js';
import * as s from '../telegram/support-bot.service.js';
import * as ann from '../telegram/announcement.service.js';

/** Admin console → บอทตอบคำถาม: scripted Q&A + the bot's settings (console key required). */
export const supportBotAdminRouter = Router();
const h = (fn) => asyncHandler(async (req, res) => res.json({ ok: true, ...((await fn(req)) ?? {}) }));
const id = (req) => z.coerce.number().int().positive().parse(req.params.id);

supportBotAdminRouter.get('/', h(async () => ({ faqs: await s.listFaqs(), settings: (await cfg.getAll()).supportBot ?? null })));
supportBotAdminRouter.post('/faqs', h((req) => s.createFaq(req.actor, s.faqSchema.parse(req.body))));
supportBotAdminRouter.post('/faqs/:id', h((req) => s.updateFaq(req.actor, id(req), s.faqSchema.parse(req.body))));
supportBotAdminRouter.post('/faqs/:id/delete', h((req) => s.deleteFaq(req.actor, id(req))));
supportBotAdminRouter.post('/test', h((req) => s.testMatch(z.object({ text: z.string().max(1000) }).parse(req.body).text)));
supportBotAdminRouter.post('/settings', h((req) => cfg.save('supportBot', req.actor, req.body)));

// ประชาสัมพันธ์ (announcements)
supportBotAdminRouter.get('/announcements', h(async () => ({ announcements: await ann.listAnnouncements(), chats: await ann.listChats(), slots: ann.HOURLY_SLOTS })));
supportBotAdminRouter.post('/announcements', h((req) => ann.createAnnouncement(req.actor, ann.announcementSchema.parse(req.body))));
supportBotAdminRouter.post('/announcements/:id', h((req) => ann.updateAnnouncement(req.actor, id(req), ann.announcementSchema.parse(req.body))));
supportBotAdminRouter.post('/announcements/:id/delete', h((req) => ann.deleteAnnouncement(req.actor, id(req))));

export default supportBotAdminRouter;
