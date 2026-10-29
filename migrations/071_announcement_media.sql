-- ประชาสัมพันธ์ with pictures / videos / albums and pinning (27 Oct 2026).
-- announcement_media: uploaded files (photo ≤ 10 MB, video mp4 ≤ 50 MB). tg_file_id = Telegram's id after the first
-- upload, so later groups and later runs send by id instead of uploading again.
CREATE TABLE IF NOT EXISTS announcement_media (
  id bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('photo', 'video')),
  mime text NOT NULL,
  name text,
  bytes integer NOT NULL,
  data bytea NOT NULL,
  tg_file_id text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Ordered: 1 item = picture or video post, 2–10 = album. Empty = text only (as before).
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS media_ids bigint[] NOT NULL DEFAULT '{}';
-- Pin the posted message in each group (album: its first item).
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS pin boolean NOT NULL DEFAULT false;
