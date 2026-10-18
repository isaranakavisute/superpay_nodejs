// Option B (agreed 18 Oct 2026): key = HMAC-SHA256(sk_live, t.POST.path.body) as hex, v1 = HMAC-SHA256(key, t.body).
// Expected values computed independently with the shop-side openssl command (API docs), not with our code.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { deriveCallbackKey } from '../src/webhooks/webhook.service.js';

const SK = 'sk_live_TESTONLY_not_a_real_key_1234567890';
const T = '1792236293';
const PATH = '/api/v1/payment-external-callback/superpay';
const BODY = '{"event":"payment.approved","ref":"TXN100001","orderId":"PD-1","amount":"1000.00","status":"approved","createdAt":"2026-10-17T09:21:20.000Z","resentAt":"2026-10-17T09:24:53.515Z"}';

describe('sk_live-derived callback signature', () => {
  it('key = openssl: printf "$TS.POST.$PATH.$BODY" | openssl dgst -sha256 -hmac "$SECRET"', () => {
    assert.equal(deriveCallbackKey(SK, T, PATH, BODY), '4440459dbf874ab28d5b244f35ba815b91b891b5f700f5d7d1da0c220d3fe02b');
  });
  it('v1 = openssl: printf "$T.$BODY" | openssl dgst -sha256 -hmac "$KEY"', () => {
    assert.equal(createHmac('sha256', deriveCallbackKey(SK, T, PATH, BODY)).update(`${T}.${BODY}`).digest('hex'), 'b3ca76718dca475af334b0f9dc19fc6df2c6a498ca23c406abc2c0525d846d04');
  });
  it('a different body or time gives a different key (it is per callback)', () => {
    assert.notEqual(deriveCallbackKey(SK, T, PATH, BODY), deriveCallbackKey(SK, '1792236294', PATH, BODY));
    assert.notEqual(deriveCallbackKey(SK, T, PATH, BODY), deriveCallbackKey(SK, T, PATH, BODY.replace('1000.00', '1000.01')));
  });
});
