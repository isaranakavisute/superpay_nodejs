import { NotFoundError } from '../errors.js';
import * as repo from './product.repository.js';

export async function getProduct(id) {
  const product = await repo.findProductById(id);
  if (!product) throw new NotFoundError(`Product ${id} does not exist`);
  return product;
}

export const listProducts = (filters) => repo.listProducts(filters);
export const listCategories = () => repo.listCategories();
