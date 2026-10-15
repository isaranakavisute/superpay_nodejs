-- Telegram users an alert bot tags at the top of each message (แจ้งเตือน Telegram → แท็กผู้ใช้):
-- comma-separated "@username" or "Name:<user id>" (for users without a username).
ALTER TABLE alert_channels ADD COLUMN mentions text NOT NULL DEFAULT '';
