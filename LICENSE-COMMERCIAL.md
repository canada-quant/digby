# Digby Commercial License

Digby is **dual-licensed**.

Copyright (C) 2026 Canada Quant Labs Inc. All rights reserved.

---

## 1. The open-source licence (default)

Digby is made available under the **GNU Affero General Public License, version 3
or later (AGPL-3.0-or-later)**. The full text is in [`LICENSE`](./LICENSE).

You may use, study, modify and redistribute Digby under the AGPL at no charge,
provided you comply with its terms. The AGPL's central obligation is **§13**: if
you run a modified version of Digby and let other people interact with it over a
network, you must offer those users the Corresponding Source of your modified
version.

In plain English, if you:

- **self-host Digby for yourself or your own organisation** — the AGPL normally
  requires nothing of you beyond keeping the copyright notices intact;
- **modify Digby and expose it to users over a network** (a hosted service, a
  managed offering, an embedded product) — the AGPL requires you to publish your
  modifications under the AGPL.

Running Digby unmodified as a service is permitted under the AGPL. The
obligations attach to **modifications you distribute or operate for others**.

## 2. The commercial licence (what the AGPL does not allow)

A **commercial licence** is available for organisations that need to do
something the AGPL does not permit, or that need contractual guarantees the AGPL
does not provide.

| Need | AGPL alone | Commercial licence |
|---|---|---|
| Embed Digby in a **closed-source** product or appliance | No (copyleft reaches your combined work) | Yes |
| Offer Digby as a **hosted/managed service without publishing your modifications** | No (§13 network obligation) | Yes |
| **Rebrand** and ship Digby inside your own commercial offering | No (must keep notices, publish changes) | Yes |
| **Indemnification**, warranty, and a support/SLA commitment | No (no warranty) | Yes |
| Guaranteed **security-notification** channel and patched-release window | No | Yes |
| **Enterprise features** (see below) maintained on a separate track | No | Yes |

### Enterprise tier

An enterprise edition, delivered under the commercial licence, is intended to
carry the features large deployments ask for and that are deliberately **not**
part of this open-source repository — for example single sign-on (SAML/OIDC),
SCIM provisioning, fine-grained and delegated role-based access control beyond
the per-project `viewer` / `editor` / `admin` roles this repository ships, and
compliance-oriented audit-log export.

This open-source repository is a complete, self-hostable product. The commercial
edition is for organisations that need those controls plus contractual cover.

## 3. Contributor licensing

By submitting a contribution to this repository you agree that Canada Quant Labs
Inc. may license your contribution under both the AGPL-3.0-or-later (for this
repository) and the commercial licence described above. This is what makes dual
licensing possible. See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

If you are contributing on behalf of an employer, you confirm you have authority
to grant that licence.

## 4. Trademarks

The "Digby" name and logo are trademarks of Canada Quant Labs Inc. The licences
above grant rights to the **code**, not to the marks. You may not use the name or
logo in a way that suggests endorsement, or as the name of a redistributed
product, without written permission. Forking the code and giving your fork a
different name is always fine.

## 5. Contact

For commercial licensing, enterprise deployment, or trademark permission:

**Canada Quant Labs Inc.** — open an issue at
`https://github.com/canada-quant/digby/issues` marked `licensing`, or use the
private route in [`SECURITY.md`](./SECURITY.md) if the matter is sensitive.

---

*This document is a summary for convenience; it is not itself a licence grant.
The commercial licence terms are set out in a separate signed agreement. If this
summary and the AGPL text disagree about your AGPL rights, the AGPL text
controls.*

---

## 6. Licence history — earlier MIT releases

Commits published to `canada-quant/digby` before 2026-11-06 shipped an **MIT**
`LICENSE` file (carrying a leftover `Admin Dashboard Template` copyright line).
That was inconsistent with this document and with the project's intent, and it
has been corrected: `LICENSE` now holds the verbatim AGPL-3.0 text.

**This correction is not retroactive, and we do not claim it is.** A licence
already granted cannot be revoked. Anyone who obtained Digby under those earlier
commits may continue to use, modify and redistribute **that** code under the MIT
terms that accompanied it. The AGPL-3.0-or-later applies to the repository from
this release forward, and to every subsequent commit.

If you are relying on the earlier MIT grant, pin your dependency to a commit
before 2026-11-06 and keep the MIT notice that came with it.
