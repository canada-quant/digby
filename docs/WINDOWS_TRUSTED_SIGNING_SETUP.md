# Windows installer — Azure Trusted Signing setup runbook (owner, one read)

> **Who this is for:** the owner, once, before the first signed release. This is the
> complete setup path — Azure portal identity validation, the Trusted Signing account
> and certificate profile, the CI app registration, and the six repo secrets — in one
> read. Everything after the secrets is **automatic**: the repo's watch and
> `.github/workflows/windows.yml` pick it up with no further owner action.
>
> **Status (2026-10-27):** 0 of 6 repo secrets exist. The identity validation is the
> owner's stated in-flight step (ruling oq_c04fcc10). The automated secrets watch
> (schedule `26f668d9`, every ~2 h) is running and fires the signing → ship → WDSI
> chain the moment all six appear.
>
> Companion docs: `docs/WINDOWS_W2_SHIPPING.md` §1.1 (the original checklist — this
> doc supersedes its portal steps with current ones) and §2 (the per-release WDSI
> submission). Microsoft's canonical pages:
> [quickstart](https://learn.microsoft.com/en-us/azure/trusted-signing/quickstart),
> [signing integrations](https://learn.microsoft.com/en-us/azure/trusted-signing/how-to-signing-integrations),
> [FAQ](https://learn.microsoft.com/en-us/azure/trusted-signing/faq).

**Naming note:** Microsoft renamed the service — the portal resource is now
**"Artifact Signing Accounts"** (docs path `artifact-signing/`, older material says
"Trusted Signing" / "Code Signing"). Same service, same endpoints; portal search
terms below use the current names. Likewise the RBAC roles are now
**"Artifact Signing Certificate Profile Signer"** and
**"Artifact Signing Identity Verifier"** (older write-ups say "Trusted Signing …").

## 0. Prerequisites (5 minutes)

- A **paid** Azure subscription — free, trial, or sponsored subscriptions are
  rejected outright ("you must have a paid Azure subscription").
- Basic tier pricing: **$9.99/mo, 5,000 signatures/mo** — ample for our release rate.
- **Register the resource provider first** (one-time):
  portal → **Subscriptions** → your subscription → **Settings → Resource providers**
  → find **`Microsoft.CodeSigning`** (status *NotRegistered*) → ellipsis **→ Register**.
  Or CLI: `az provider register --namespace "Microsoft.CodeSigning"`.
- To create/validate/profile you need at least **Contributor** on the subscription,
  plus the **Artifact Signing Identity Verifier** role on the account (below).

## 1. Create the Artifact Signing account (~5 minutes)

1. Portal → search **"Artifact Signing Accounts"** → **Create**.
2. Fields: **Subscription** · **Resource group** (create new, e.g. `rg-digby-signing`)
   · **Account name** (3–24 alphanumeric, globally unique, letter-first — this value
   becomes the `AZURE_SIGNING_ACCOUNT` secret) · **Region** · **Pricing** = Basic.
3. **Region — there is no Canada endpoint.** The account must live in one of the 15
   service regions, and the endpoint used by CI must match the account's region
   exactly or every sign call **403s** (region/endpoint mismatch is the single most
   common failure). Pick a region and note its endpoint for §4:

   | Region | Endpoint URI |
   |---|---|
   | East US | `https://eus.codesigning.azure.net` |
   | Central US | `https://cus.codesigning.azure.net` |
   | North Central US | `https://ncus.codesigning.azure.net` |
   | South Central US | `https://scus.codesigning.azure.net` |
   | West Central US | `https://wcus.codesigning.azure.net` |
   | West US | `https://wus.codesigning.azure.net` |
   | West US 2 | `https://wus2.codesigning.azure.net` |
   | West US 3 | `https://wus3.codesigning.azure.net` |
   | North Europe | `https://neu.codesigning.azure.net` |
   | West Europe | `https://weu.codesigning.azure.net` |
   | Brazil South | `https://brs.codesigning.azure.net` |
   | Japan East | `https://jpe.codesigning.azure.net` |
   | Korea Central | `https://krc.codesigning.azure.net` |
   | Poland Central | `https://plc.codesigning.azure.net` |
   | Switzerland North | `https://swn.codesigning.azure.net` |

   (Verbatim table: the
   [quickstart](https://learn.microsoft.com/en-us/azure/trusted-signing/quickstart) /
   [integrations](https://learn.microsoft.com/en-us/azure/trusted-signing/how-to-signing-integrations)
   pages. Canada appears only in the *identity-eligibility* list — a Canada-based
   individual qualifies; the account/endpoint still must be one of the 15 above.)

4. **Review + Create → Go to resource.**

## 2. Identity validation (~15 minutes of clicks, then a wait)

This is the **owner-gated step now in flight**. It can ONLY be done in the Azure
portal ("You can complete identity validation only in the Azure portal. You can't
complete identity validation by using the Azure CLI"). Lead time: **1–20 business
days** (the older 1–3/3–5-day figures are outdated; possibly longer if Microsoft
requests more documentation — requests cannot be expedited, and there are at most
three documentation-upload attempts).

### 2a. Self-assign the Identity Verifier role (once)

On the account: **Access Control (IAM)** → **Add role assignment** → search
"Artifact Signing" → **Artifact Signing Identity Verifier** → assign to yourself.
Without it the **New Identity** button is dimmed. (Users holding this role must also
hold at least Reader at subscription scope.)

### 2b. Individual developer validation (the recommended path)

The validated name becomes the certificate subject (`CN=…`) users see — **choose the
identity you want accumulating SmartScreen reputation for YEARS** (custom CN/O is not
supported; the CN must be the legal validated name; changing identity later resets
SmartScreen trust).

1. Account → **Objects → Identity validations** → the tab defaults to
   **Organization** — switch the dropdown to **Individual** → **New Identity** →
   select **Public**.
2. **Key mechanic:** for Public Trust individual validation, Artifact Signing
   **auto-sources the identity details from the Azure billing account** tied to the
   subscription. The billing account must have **Account Type = Individual**, and its
   legal name + sold-to address must match the government ID used for validation —
   the form auto-populates from billing and those fields are read-only. Fix the
   billing account FIRST if needed (portal: Cost Management + Billing; if the sold-to
   address formatting can't be edited in the portal, the FAQ's CLI:
   `az billing account update --name "<billing-account-name>" --sold-to first-name="…" last-name="…" address-line1="…" city="…" region="…" country="…" postal-code="…"`).
3. Editable fields: **First Name, Last Name** (exactly as on the government ID),
   **Primary Email**, **Street / City / Country-Region / State-Province / Postal code**.
4. **Create.** Status → **In Progress**.
5. When status flips to **Action Required**: select your name → in the right-hand
   blade select the link under **"Please complete your verification here"** → the
   Verified-ID flow (Microsoft's ID-verification partner, e.g. AU10TIX: email + PIN,
   phone, QR scan on mobile, Microsoft Authenticator verifiable credential → Share).
6. The verification **link expires in 7 days** — if missed, the request cannot be
   re-sent; delete it and create a new one.
7. Success → status **Completed** (takes a couple of minutes to update after the
   Verified-ID flow finishes). Failure → **Failed** (don't keep retrying: if
   validation fails after the documentation attempts are exhausted, delete the
   account to stop billing).

*(Organization validation exists — same pane, Organization tab, with legal-entity
fields: Organization Name, website URL owned by the entity, two different entity-domain
emails, business identifier, business address, plus a representing individual who then
does the same ID verification. Only worth it if Digby should carry a company name on
the certificate; otherwise individual is simpler.)*

### 2c. After status = Completed

Copy the **Identity validation Id** (GUID, shown on the Identity validations pane) —
it's needed to create the certificate profile via CLI, and the certificate profile
must reference this validation.

## 3. Certificate profile (~2 minutes)

1. Account → **Objects → Certificate profiles** → **Create** → type
   **Public Trust** (this is what earns SmartScreen goodwill — Private Trust profiles
   do not; "Public Trust Test" is for testing only).
2. Fields: **Certificate Profile Name** (5–100 alphanumeric, letter-first — this
   value becomes the `AZURE_SIGNING_PROFILE` secret) · Certificate Type
   (autopopulated) · **Program Type** keep default None · **Verified CN and O**:
   select the Completed identity validation (this is where the profile binds to the
   validated identity). Optional: Include street address / postal code on the
   certificate.
3. **Create.** The profile inherits the account's region — the endpoint secret must
   match that region.

CLI equivalent (after `az extension add --name artifact-signing`):
`az artifact-signing certificate-profile create -g <rg> --account-name <account> -n <profile> --profile-type PublicTrust --identity-validation-id <guid>`

## 4. Entra app registration for CI (~5 minutes)

The sign step in `.github/workflows/windows.yml` authenticates as this service
principal (`azure/artifact-signing-action@v2` with client-secret credentials —
the repo's workflow pins that auth mode; OIDC is not wired).

1. **Microsoft Entra ID → App registrations → New registration** (name e.g.
   `digby-signing-ci`; single-tenant is fine).
2. From the app's **Overview**: copy the **Application (client) ID** and the
   **Directory (tenant) ID** — these become the `AZURE_CLIENT_ID` and
   `AZURE_TENANT_ID` secrets.
3. **Certificates & secrets → New client secret** → copy the secret **VALUE** (the
   "Value" column, not the Secret ID — it is shown only once) — this becomes
   `AZURE_CLIENT_SECRET`.
4. Grant the signing role on the **Artifact Signing account** (not just the
   subscription): account → **Access Control (IAM)** → **Add role assignment** →
   search "Artifact Signing" → **Artifact Signing Certificate Profile Signer** →
   assign to the app registration's service principal. **A missing Signer role is a
   403 at sign time — the single most common CI failure.** (Finer-grained option:
   the role can instead be scoped to the certificate profile resource via
   `az role assignment create --assignee <objectId> --role "Artifact Signing
   Certificate Profile Signer" --scope "/subscriptions/<id>/resourceGroups/<rg>/providers/Microsoft.CodeSigning/codeSigningAccounts/<account>/certificateProfiles/<profile>"`.)

## 5. The six repo secrets (5 minutes, then everything is automatic)

Map each value to its secret — names must be exactly these (they match
`.github/workflows/windows.yml` verbatim):

| Secret | Value | Where it comes from |
|---|---|---|
| `AZURE_TENANT_ID` | tenant GUID | §4 app registration → Directory (tenant) ID |
| `AZURE_CLIENT_ID` | client GUID | §4 app registration → Application (client) ID |
| `AZURE_CLIENT_SECRET` | the client secret VALUE | §4 Certificates & secrets (shown once) |
| `AZURE_SIGNING_ENDPOINT` | region endpoint, e.g. `https://eus.codesigning.azure.net` | §1 account region → endpoint table |
| `AZURE_SIGNING_ACCOUNT` | the account name | §1 Artifact Signing account name |
| `AZURE_SIGNING_PROFILE` | the certificate profile name | §3 Public Trust profile name |

Paste-ready (values in `<…>` are placeholders — fill from the table above; run from
anywhere with `gh` authenticated against the repo):

```bash
gh secret set AZURE_TENANT_ID       --repo example-org/crossmodel --body "<tenant-guid>"
gh secret set AZURE_CLIENT_ID       --repo example-org/crossmodel --body "<client-guid>"
gh secret set AZURE_CLIENT_SECRET   --repo example-org/crossmodel --body "<client-secret-value>"
gh secret set AZURE_SIGNING_ENDPOINT --repo example-org/crossmodel --body "https://<region>.codesigning.azure.net"
gh secret set AZURE_SIGNING_ACCOUNT --repo example-org/crossmodel --body "<account-name>"
gh secret set AZURE_SIGNING_PROFILE --repo example-org/crossmodel --body "<cert-profile-name>"
```

(Setting them in the web UI is equally fine: repo **Settings → Secrets and variables
→ Actions → New repository secret**, six times.)

## 6. What happens automatically once the six secrets exist

Nothing else is needed from the owner. The repo's machinery takes over:

1. **The secrets watch** (schedule `26f668d9`, fires every ~2 h) sees all six in
   `gh secret list`, cancels itself, and executes the remaining W3 todos in order:
2. **Signing leg** — dispatch `windows.yml` on `main`: the workflow's resolve step
   folds the six secrets into a `signing` gate, and the two
   `azure/artifact-signing-action@v2` steps go live — **"Sign shell + helper
   binaries (Azure Artifact Signing)"** signs everything under `publish\`
   (`.exe`/`.dll`, recursive, SHA256, RFC3161 timestamp
   `http://timestamp.acs.microsoft.com`) BEFORE the NSIS packaging, then
   **"Sign the installer (Azure Artifact Signing)"** signs `publish\Digby-Setup.exe`
   after. Until the secrets exist those steps are skipped with the visible
   `::notice::…UNSIGNED (internal testing only)` marker — that notice disappearing
   is the signal signing is live.
3. **Ship leg** — the signed exe replaces `frontend/public/Digby-Setup.exe` (the
   95 MiB repo-blob guard still applies), PR + merge + deploy, then
   `https://digby.ai/Digby-Setup.exe` serves the SIGNED installer.
4. **WDSI leg** — the signed installer is submitted to
   [microsoft.com/wdsi/filesubmission](https://www.microsoft.com/wdsi/filesubmission)
   as *Software developer* per `docs/WINDOWS_W2_SHIPPING.md` §2 (reputation
   accrues per release; expect weeks of residual SmartScreen friction on a fresh
   identity even with a perfect process).

**First-real-run risk (pre-verified, no action unless it bites):** the action's
default `timeout` is 300 s per sign step; a slow recursive publish-tree sign could
need `timeout: 600` added to the two sign steps (a code change → PR) — the watch's
signing leg knows to check for this.

## 7. Verifying it worked (owner, optional, ~2 minutes)

After the first signed run: open the run on GitHub and confirm both sign steps are
green; then on any Windows box, right-click the installer → **Properties → Digital
Signatures** (or `Get-AuthenticodeSignature .\Digby-Setup.exe | fl`): Status
**Valid**, signer = the validated identity, TimeStamperCertificate present.

## Troubleshooting quick table (all from the MS FAQ)

| Symptom | Cause / fix |
|---|---|
| 403 at sign time (SignerSign failure) | endpoint ≠ account region (§1 table), missing **Certificate Profile Signer** role for the CI app (§4), identity validation not **Completed**, or profile not active |
| **New Identity** button dimmed | self-assign **Artifact Signing Identity Verifier** (§2a) |
| Account/profile creation rejected | subscription is free/trial/sponsored, or `Microsoft.CodeSigning` provider not registered (§0) |
| Validation stuck | verification link expired after 7 days → new request; requests cannot be expedited; three documentation attempts max |
| Name on cert wrong | CN is always the legal validated name — no custom CN/O; fix at the billing account (§2b) or via organization validation |
