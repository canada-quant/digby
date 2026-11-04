## What was wrong

<!-- The defect or the gap. For a feature, what could not be done before. -->

## What this changes

<!-- The approach, and anything a reviewer would not guess from the diff. -->

## How it was verified

<!-- Paste the command you ran and its result. "Tests pass" is not enough — say which. -->

```
$ 
```

## Checklist

- [ ] New behaviour has a test that fails without this change (or: bug fix has a regression test pinning the exact defect)
- [ ] Backend `npm test` and `npx tsc --noEmit` pass
- [ ] Frontend `npm test`, `npx tsc --noEmit`, `npm run lint` pass
- [ ] Lint is clean on the code I touched
- [ ] Docs updated for any behaviour, API, config or setup change (`docs/`, `selfhost.env.example`, `README.md`)
- [ ] **No secrets committed** — no keys, tokens, passwords, private keys or real connection strings, including in tests and fixtures
- [ ] No production infrastructure identifiers (hostnames, IPs, account IDs, ALB/DNS names)
- [ ] New environment variables are documented in `selfhost.env.example` with a safe example value

## Related issues

<!-- Closes #... -->
