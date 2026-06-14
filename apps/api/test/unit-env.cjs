// Unit-test env. signing.ts fails closed without HMAC_SIGNING_KEY (no insecure
// default), so unit specs that sign/verify need a key just like it-env.cjs.
process.env.HMAC_SIGNING_KEY = process.env.HMAC_SIGNING_KEY || 'test-hmac-signing-key-value';
