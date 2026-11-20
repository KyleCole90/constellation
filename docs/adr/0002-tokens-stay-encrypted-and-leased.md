# Tokens stay encrypted and reach providers only through a lease

A Canvas token or API key must never sit in plain text where a log, an export or a devtools print can reach it. Each vault stores ciphertext, and a provider gets the plain token only for the length of one call.

- `createVault` in `src/main/vault.ts` runs every `read()` of the vault file and the `write()` built from it in one synchronous stretch, after any `await`. Two IPC calls can't interleave and drop each other's token. A `read()` moved before an `await` brings the lost update back.
- The browser vault in `src/renderer/providers/vault.ts` stores AES-GCM ciphertext and a non-extractable `CryptoKey` in IndexedDB. A reload stays connected, and localStorage, logs and exports never hold the token. Same-origin script can still ask it to decrypt, so only a provider lease reads a credential back. Settings can only enroll, check and forget a token.
- `Secret` in `src/shared/providers/provider.ts` keeps its plain text in a module `WeakMap`, not a `#` field, because devtools prints `#` fields when an object is logged.
- `CredentialLease` in `src/shared/providers/provider.ts` decrypts for each call to `use`. A provider holds no long-lived plain text.
- `canResetDemo` in `src/shared/domain/lms.ts` offers the demo reset only while every school is a demo school. The reset forgets every saved token, so it must never cost a real school its connection.
