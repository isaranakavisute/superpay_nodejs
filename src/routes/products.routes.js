import { Router } from 'express';
import asyncHandler from '../middleware/asyncHandler.js';
import * as service from '../products/product.service.js';
import {
  listProductsQuerySchema,
  productIdParamSchema,
} from '../products/product.schema.js';

export const productsRouter = Router();

productsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const filters = listProductsQuerySchema.parse(req.query);
    const { items, total } = await service.listProducts(filters);
    res.json({
      data: items,
      pagination: { total, limit: filters.limit, offset: filters.offset },
    });
  }),
);

// Declared before /:id so "categories" is not parsed as an id.
productsRouter.get(
  '/categories',
  asyncHandler(async (req, res) => {
    res.json({ data: await service.listCategories() });
  }),
);

productsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = productIdParamSchema.parse(req.params);
    res.json(await service.getProduct(id));
  }),
);

export default productsRouter;
