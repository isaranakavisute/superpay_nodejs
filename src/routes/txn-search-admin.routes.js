import { Router } from 'express';
import asyncHandler from '../middleware/asyncHandler.js';
import { refParamSchema, search, searchQuerySchema, timeline } from '../console/txn-search.js';

// Transaction search popup: ref suggestions (substring) and one transaction's full history. Read-only.
export const txnSearchAdminRouter = Router();

txnSearchAdminRouter.get('/', asyncHandler(async (req, res) => res.json({ ok: true, ...(await search(searchQuerySchema.parse(req.query))) })));
txnSearchAdminRouter.get('/:ref', asyncHandler(async (req, res) => res.json({ ok: true, ...(await timeline(refParamSchema.parse(req.params).ref)) })));

export default txnSearchAdminRouter;
