-- Menus per role (31 Oct 2026): a role can be given a permission yet not see some menu items (สิทธิ์การเข้าถึง →
-- เมนูที่แสดง), e.g. "user" sees only รายการชำระเงิน and รายการเงินออก. Keys are the console's menu keys (nav.ts).
-- Empty by default — nothing changes until a menu is switched off. Super Admin always sees everything.
ALTER TABLE console_roles ADD COLUMN IF NOT EXISTS hidden_menus text[] NOT NULL DEFAULT '{}';
