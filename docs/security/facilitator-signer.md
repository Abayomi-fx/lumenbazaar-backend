# Facilitator Signer Operations

The hosted testnet signer uses the `environment` provider. Render stores
`FACILITATOR_SIGNING_KEY` as a secret; it must not be placed in a committed env file, build
argument, log statement, metric, health response, or support ticket. Application configuration
contains only the public account, network, provider name, and key version.

## Provisioning

1. Create or select the funded Stellar testnet facilitator account outside the application
   process.
2. Set `FACILITATOR_ACCOUNT` to its public address and
   `FACILITATOR_SIGNER_NETWORK=stellar:testnet`.
3. Add `FACILITATOR_SIGNING_KEY` through the Render secret manager and set a non-secret
   `FACILITATOR_SIGNING_KEY_VERSION` label.
4. Set `FACILITATOR_SIGNER_PROVIDER=environment` and deploy.
5. Require `/ready` to report `checks.signer.status=ready` before enabling payment traffic.

Startup fails when the secret is missing, malformed, for the wrong account, or configured for a
different network. There is no hosted fallback to a development signer.

## Rotation

1. Prepare and fund the replacement testnet account.
2. Update the secret, `FACILITATOR_ACCOUNT`, and key-version label in one deployment change.
3. Restart all API instances so no process retains the prior signer.
4. Confirm the new public address under `/v1/supported.signers` and confirm signer readiness.
5. Revoke and defund the previous testnet account only after in-flight settlement is reconciled.

Changing only the key-version label reloads the current account material. A secret whose derived
address differs from `FACILITATOR_ACCOUNT` is rejected.

## Revocation And Incident Response

1. Disable exact and capped payment capabilities or stop the API deployment.
2. Remove the compromised secret from Render and rotate to a new account.
3. Review audit records, settlement hashes, and provider access logs for the incident window.
4. Reconcile every submitted transaction before restoring payment traffic.
5. Redeploy, verify readiness, run conformance checks, and record the new key version.

Never paste signing material into application logs or diagnostic commands. Error responses expose
only a stable signer-unavailable message and the `facilitator_signer` component identifier.
