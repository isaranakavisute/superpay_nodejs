-- Orders a shop user creates by hand in the Merchant Portal (Transactions → สร้างรายการชำระ).
ALTER TABLE payments DROP CONSTRAINT payments_source_check;
ALTER TABLE payments ADD CONSTRAINT payments_source_check
  CHECK (source IN ('admin', 'api', 'slip', 'collect', 'event', 'portal'));
