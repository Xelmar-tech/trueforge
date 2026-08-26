# TrueForge desktop (local development)

This Electron shell runs the built standalone TrueForge server and opens its bundled UI in a desktop window. The local
topology matches `npx @truefoundry/trueforge`: one Node process serves the API and frontend and persists data in SQLite.

From the repository root:

```bash
pnpm desktop
```

The command builds the workspace first, starts TrueForge on `127.0.0.1:8790`, waits for `/healthz`, and opens Electron.
Closing the window stops the server process started by Electron.

Set `PORT` before running the command to use another port. If a healthy TrueForge server is already listening there,
the desktop shell reuses it and leaves it running when the window closes.

This is a development-only desktop shell. It does not create a DMG or include signing, notarization, or auto-updates.
