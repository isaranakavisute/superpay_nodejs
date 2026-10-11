-- Fingerprints of an uploaded slip, so one transfer can't be applied to two orders:
-- the exact image (sha256) and the QR code printed on Thai bank slips (holds the bank's transaction ref).
ALTER TABLE payment_slips
  ADD COLUMN image_sha256 text,
  ADD COLUMN qr_payload text;
UPDATE payment_slips SET image_sha256 = encode(sha256(data), 'hex') WHERE data IS NOT NULL;
CREATE INDEX payment_slips_image_sha256_idx ON payment_slips (image_sha256);
CREATE INDEX payment_slips_qr_payload_idx ON payment_slips (qr_payload) WHERE qr_payload IS NOT NULL;
