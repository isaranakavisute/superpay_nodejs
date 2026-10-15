-- The amount the shop asked for, before any unique satang were added ("ยอดไม่ซ้ำ"). A bank-verified slip that pays
-- exactly this amount is accepted (customers often pay the round amount); the order is then corrected to the amount
-- actually received. NULL = same as amount (orders created before this column).
ALTER TABLE payments ADD COLUMN requested_amount numeric(14, 2);
