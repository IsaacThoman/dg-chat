# DG Chat mock OIDC provider

This test-only service implements a deterministic authorization-code OIDC provider with S256 PKCE,
nonce-bearing ES256 ID tokens, JWKS, UserInfo, one-time codes, and an accessible account selector.
Start it through `docker-compose.oidc.yml`; it is not part of the production profile.

The account selector includes verified, unverified, existing-email, colliding-subject, and
missing-claim personas. Protected controls select one injected failure mode at a time:

`authorization_error`, `token_http_500`, `userinfo_http_500`, `wrong_issuer`, `wrong_audience`,
`wrong_nonce`, `expired_id_token`, `future_iat`, `invalid_signature`, `disallowed_algorithm`, and
`userinfo_subject_mismatch`.

Control requests require `Authorization: Bearer $MOCK_OIDC_CONTROL_TOKEN`:

- `POST /control/reset`
- `POST /control/mode` with `{ "mode": "wrong_nonce" }`
- `GET /control/state`

The state response contains only sanitized counters and event metadata. It never returns
authorization codes, access tokens, client secrets, PKCE verifiers, state values, or nonces.
