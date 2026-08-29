# NextWave Estimator

Pulls a real estimate from QuickBooks Online, splits it into a **Material
Draw invoice** (materials, due upfront) and a **Remaining Balance invoice**
(labor/other, due Net 30 after completion), and generates real branded PDFs
for both. Separately, tracks your own material/labor costs per project to
calculate gross profit, a 30% tax set-aside, and net profit — this side is
never shown to the customer.

## Stack
Node.js/Express, bcrypt/session auth, better-sqlite3, pdfkit for PDF
generation, vanilla HTML/CSS/JS, Docker. QuickBooks connection uses OAuth2
against QuickBooks Online's real API — nothing here talks to QuickBooks
Desktop.

## QuickBooks Developer setup (do this first)

You only need to do this once — it's a one-time setup that lets the app
securely connect to your QuickBooks Online account.

1. Go to **https://developer.intuit.com** and sign in with your existing
   QuickBooks account (or create a free developer account).
2. Click **Create an app** → choose **QuickBooks Online and Payments**.
3. Give it any name (e.g. "NextWave Estimator").
4. Once created, go to the app's **Keys & OAuth** section (under
   Development, not Production, until you're ready to go live — Intuit
   requires separate keys for each).
5. Copy the **Client ID** and **Client Secret** — you'll need both for `.env`.
6. Under **Redirect URIs**, add exactly:
   `https://estimate.thenextwaveit.com/api/qb/callback`
   (must match `.env`'s `QB_REDIRECT_URI` exactly, including https and no
   trailing slash).
7. When you're ready to use this with your real, live QuickBooks company
   (not a sandbox test company), you'll need to switch to the
   **Production** keys tab in the same app and repeat steps 5–6 there —
   production and development have separate Client ID/Secret pairs.

## First-time setup

1. Copy the env template:
   ```
   cp .env.example .env
   ```
2. Fill in `SESSION_SECRET` (any long random string), `DEFAULT_USERNAME` /
   `DEFAULT_PASSWORD` (your login — change the password after first login),
   and the three `QB_*` values from the Developer setup above.
3. Build and start:
   ```
   docker compose up -d --build
   ```
4. Open the app, log in, go to **Settings → Connect QuickBooks**, and
   approve the connection when QuickBooks asks.
5. Also in Settings, enter your business name/address/phone/email and
   upload your logo — these appear on every generated PDF.

## How it works

- **Pull from QuickBooks**: search by estimate number or customer name,
  pick the right one. Each line item's classification comes from
  QuickBooks' own Item Type — Inventory/NonInventory items become
  "material," Service items become "labor/other." Anything ambiguous
  defaults to labor/other (the financially safer default — it lands in the
  net-30 bucket rather than being incorrectly demanded upfront).
- **Reclassify**: on the project page, click the ⇄ button next to any line
  item to move it to the other invoice, in case something got classified
  differently than you intended.
- **Generate PDFs**: two separate buttons generate the Material Draw and
  Remaining Balance invoices as real PDFs, ready to send to the customer.
- **Cost/Profit Calculator**: a separate tab per project — enter your own
  material costs and 1099 worker hours/rates. This is entirely separate
  from what's quoted to the customer; nothing here is customer-facing.
  Automatically calculates: Gross Profit = Revenue − Material Cost − Labor
  Cost, a 30% tax set-aside on that gross profit, and the resulting Net
  Profit.
- **Manual projects**: you can also create a project without pulling from
  QuickBooks at all, and just use the calculator side.

## Notes

- The QuickBooks API itself is free to use — Intuit doesn't charge for
  accessing your own company's data. The Developer app setup above is a
  one-time cost, not an ongoing one.
- Access tokens refresh automatically in the background; you shouldn't
  need to reconnect QuickBooks regularly. If the connection ever breaks
  (e.g., after 100 days of inactivity, per Intuit's refresh token expiry),
  just reconnect from Settings.
- Material costs and labor entries are stored per-project and are
  independent of QuickBooks — QuickBooks is only used to pull the
  customer-facing quote data, not your internal cost tracking.
