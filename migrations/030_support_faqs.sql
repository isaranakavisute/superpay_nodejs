-- Scripted questions/answers for the support bot (@OptionPaySupportBot), managed in
-- the admin console (บอทตอบคำถาม). keywords: comma-separated phrases that also trigger the answer.
CREATE TABLE support_faqs (
  id          serial PRIMARY KEY,
  question    text NOT NULL,
  keywords    text NOT NULL DEFAULT '',
  answer      text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  sort        integer NOT NULL DEFAULT 0,
  hits        integer NOT NULL DEFAULT 0,
  last_hit_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
