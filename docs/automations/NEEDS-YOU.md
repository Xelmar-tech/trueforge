# Needs you

Steps only a human can do. Newest first. Each entry says what to do and how the
build continues once it is done.

## 1. Approve GitHub sudo mode for the App creation (open in Chrome)

- **Where:** the Chrome tab titled "Confirm access" at
  `https://github.com/settings/apps/manifest`, signed in as `@AaronAbuUsama`.
- **What:** use your passkey (or password) to enter sudo mode, then click **Create
  GitHub App** on the page that follows. The App is `xelmar-foreman`, owner
  `Xelmar-tech`. GitHub then redirects to
  `https://trueforge-production-5b64.up.railway.app/api/v1/event-sources/github/callback`,
  which stores the App and shows Settings → Event sources with the source active.
- **Then:** install the App on `Xelmar-tech/trueforge-automations-dogfood` (the
  source row gets an **Install** link, or use `https://github.com/apps/xelmar-foreman`).
- **If more than an hour passes** the manifest state expires. Nothing breaks: open
  Settings → Event sources on the deployment, delete the pending `xelmar-foreman`
  row and click **Connect GitHub** again.
- **Why you:** sudo mode asks for your credential; the agent never handles one.

## Standing risk

- The Railway deployment has authentication off: anyone with the URL is an admin.
  Do not share the URL. Turning on OIDC is documented in `.railway/railway.ts`.
