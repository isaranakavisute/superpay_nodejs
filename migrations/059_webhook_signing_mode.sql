-- How a webhook endpoint's callbacks are signed (x-signature: t=…,v1=…), chosen per endpoint (17–18 Oct 2026):
--   whsec           v1 = HMAC-SHA256(endpoint whsec_ secret, t + "." + body)                       — the default
--   sk_live_derived key = HMAC-SHA256(shop owner's sk_live_ secret key, t + ".POST." + url path + "." + body) (hex),
--                   v1  = HMAC-SHA256(key, t + "." + body)                                           — prismapays' choice
ALTER TABLE webhook_endpoints ADD COLUMN signing text NOT NULL DEFAULT 'whsec' CHECK (signing IN ('whsec', 'sk_live_derived'));
