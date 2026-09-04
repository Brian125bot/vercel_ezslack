# P0 Dependency Remediation Report

## 1. Before and After Audit Results

- **Before Remediation:**
  - `npm audit --omit=dev`: 10 vulnerabilities (6 high, 4 moderate) across packages including `ip-address`, `undici`, `postcss`, `protobufjs`, `nanoid`, `qs`, `body-parser`, `browserslist`, and `brace-expansion`.
- **After Remediation:**
  - `npm audit --omit=dev --audit-level=moderate`: **0 vulnerabilities found**.
  - All 39 Vitest test files (478 total tests) passed.
  - Full TypeScript validation (`npm run lint`) passed.
  - Vitest code coverage report (`npm run test:coverage`) completed cleanly.
  - Production build (`npm run build`) succeeded.

---

## 2. Advisory-to-Package-to-Parent Mapping

| Vulnerable Package | Advisory / Vulnerability | Parent Package(s) | Remediated Version | Fix Method |
| --- | --- | --- | --- | --- |
| `ip-address` (<=10.3.0) | GHSA-mwp4-54f8-5fhr, GHSA-4xrf-jv44-h6hh, GHSA-22jq-vg5j-6vgg | `express-rate-limit` | `10.7.0` | Upgraded `express-rate-limit` to `^8.7.0` + override `^10.3.1` |
| `undici` (7.28.0) | Cache-Control / Parser issue | `@vercel/sandbox` -> `@ai-sdk/sandbox-vercel` | `7.29.1` | Upgraded `@ai-sdk/sandbox-vercel` to `^1.0.101` + override `^7.29.1` |
| `postcss` (<=8.5.22) | GHSA-fxqj-rqcc-2cmp, GHSA-r28c-9q8g-f849 | `autoprefixer`, `vite` | `8.5.28` | Upgraded `vite` (`^6.4.3`), `autoprefixer` (`^10.5.5`), `@vitejs/plugin-react` (`^5.2.0`) + override `^8.5.23` |
| `protobufjs` (7.5.0-7.6.4) | GHSA-j3f2-48v5-ccww (Infinite loop in `.proto` option parsing) | `@google/genai`, `@google-cloud/cloud-sql-connector` | `7.6.6` | Upgraded `@google/genai` (`^2.21.0`), `@google-cloud/cloud-sql-connector` (`^1.12.0`) + override `^7.6.5` |
| `nanoid` (<=3.3.17) | GHSA-28wg-ghj8-5hjv, GHSA-2v37-7h3g-55p8 | `postcss` | `3.3.18` | Transitive override `^3.3.18` |
| `qs` (2.2.5-6.15.3) | GHSA-x5fp-wj9c-mxmx, GHSA-4mjr-xmp4-gh2g | `express`, `body-parser`, `googleapis-common` | `6.16.0` | Transitive override `^6.16.0` |
| `body-parser` (<=1.20.6) | GHSA-v422-hmwv-36x6 | `express` | `1.20.6` | Transitive override `^1.20.6` |
| `browserslist` (<=4.28.2) | Upstream data & parsing updates | `autoprefixer`, `@babel/helper-compilation-targets` | `4.28.9` | Upgraded `autoprefixer` (`^10.5.5`) + override `^4.28.9` |
| `brace-expansion` (2.0.0-2.1.3) | GHSA-3jxr-9vmj-r5cp, GHSA-mh99-v99m-4gvg, GHSA-rgw5-rvv9-x895 | `glob` (v10), `minimatch` (v9 & v10) | `2.1.4` (v2) & `5.0.9` (v5) | Scoped override for `glob` (`^2.1.4`) and default (`^5.0.8`) |

---

## 3. Selected Versions and Rationale

1. **`express-rate-limit` (^8.7.0):**
   - Upgraded direct dependency to ensure latest middleware compatibility and IP parsing stability.
2. **`@ai-sdk/sandbox-vercel` (^1.0.101):**
   - Upgraded direct parent dependency to bring in latest Vercel sandbox features and updated `undici` transport layer.
3. **`@google/genai` (^2.21.0) & `@google-cloud/cloud-sql-connector` (^1.12.0):**
   - Upgraded direct dependencies to ensure compatibility with latest Google Cloud & Gemini API protocols.
4. **`vite` (^6.4.3), `@vitejs/plugin-react` (^5.2.0), `autoprefixer` (^10.5.5):**
   - Upgraded build tooling to resolve build-time PostCSS & Babel dependency vulnerabilities safely within the same major versions.

---

## 4. Overrides and Removal Plans

Defined in `package.json`:

```json
"overrides": {
  "ip-address": "^10.3.1",
  "undici": "^7.29.1",
  "postcss": "^8.5.23",
  "protobufjs": "^7.6.5",
  "nanoid": "^3.3.18",
  "qs": "^6.16.0",
  "body-parser": "^1.20.6",
  "browserslist": "^4.28.9",
  "glob": {
    "brace-expansion": "^2.1.4"
  },
  "brace-expansion": "^5.0.8"
}
```

### Override Documentation & Removal Criteria

- **`ip-address` (`^10.3.1`):**
  - **Advisory:** GHSA-mwp4-54f8-5fhr
  - **Parent:** `express-rate-limit`
  - **Removal condition:** Remove once `express-rate-limit` updates its `ip-address` range to `>=10.3.1`.
- **`undici` (`^7.29.1`):**
  - **Advisory:** `Cache-Control` response disclosure
  - **Parent:** `@vercel/sandbox` / `@ai-sdk/provider-utils`
  - **Removal condition:** Remove once `@vercel/sandbox` pins `undici` >=7.29.1.
- **`postcss` (`^8.5.23`) & `nanoid` (`^3.3.18`):**
  - **Advisory:** GHSA-fxqj-rqcc-2cmp
  - **Parent:** `autoprefixer` / `vite`
  - **Removal condition:** Remove once `autoprefixer` and `vite` update inner `postcss` dependencies.
- **`protobufjs` (`^7.6.5`):**
  - **Advisory:** GHSA-j3f2-48v5-ccww
  - **Parent:** `@google/genai` / `google-gax`
  - **Removal condition:** Remove when `google-gax` updates its `protobufjs` dependency.
- **`qs` (`^6.16.0`) & `body-parser` (`^1.20.6`):**
  - **Advisory:** GHSA-x5fp-wj9c-mxmx & GHSA-v422-hmwv-36x6
  - **Parent:** `express`
  - **Removal condition:** Remove when `express` 4.x or 5.x updates default `body-parser` and `qs` versions.
- **`browserslist` (`^4.28.9`):**
  - **Parent:** `autoprefixer` / `@babel/helper-compilation-targets`
  - **Removal condition:** Remove when Babel / Autoprefixer update dependency manifests.
- **`brace-expansion` (`glob`: `^2.1.4`, default: `^5.0.8`):**
  - **Advisory:** GHSA-3jxr-9vmj-r5cp
  - **Parent:** `glob` (v10) / `minimatch`
  - **Removal condition:** Remove once `glob` and `test-exclude` update minimatch/brace-expansion versions.

---

## 5. Commands Run and Results

1. `npm ci` - Succeeded cleanly.
2. `npm run lint` (`tsc --noEmit`) - Passed with 0 errors.
3. `npm test` - Passed 39 test files, 478 tests.
4. `npm run test:coverage` - Passed and generated V8 coverage report (74.19% statement coverage).
5. `npm run build` - Produced production bundle (`dist/index.html` and `dist/server.cjs`).
6. `npm audit --omit=dev --audit-level=moderate` - Reported 0 vulnerabilities.

---

## 6. Staging Validation Status

- **Environment Verification:** Node.js v22.22.1, npm v11.11.0.
- **Automated Validation:**
  - Liveness endpoint (`/api/health`) verified via middleware tests.
  - Slack signature verification and inter-user authorization verified via `tests/interactivity-authorization.test.ts`.
  - Rate limiting & dashboard lockout verified via `tests/auth.test.ts`.
  - Durable workflow claiming, timeouts, and concurrency verified via `tests/vercel.test.ts`.
  - SSRF protections (including leading-zero octal IPv4 literal defense) verified via `tests/ssrfGuard.test.ts`.
  - Gemini SDK client initialization & structured function calls verified via `tests/geminiClient.test.ts`.
  - Production server entrypoint build (`dist/server.cjs`) created and validated.

---

## 7. Remaining Risks and Follow-Up Work

- **Residual Risk:** DNS-rebinding protection remains a known, deliberately deferred limitation in `ssrfGuard.ts` (documented in code).
- **Follow-Up Action:** Monitor upstream release notes for `express-rate-limit`, `@vercel/sandbox`, `express`, and `@google/genai` to reduce required npm `overrides` over time.
