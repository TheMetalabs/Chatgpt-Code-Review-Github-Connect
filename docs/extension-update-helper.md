# One-click unpacked extension update

Ashlar's Chrome bridge is an unpacked MV3 extension. Chrome does not allow an extension to overwrite its own files, so a safe update needs a small local helper.

## One-time setup

Keep loading the **same existing `extension/` directory** in Chrome. Keeping the path preserves the unpacked extension identity and its Chrome storage.

Start the helper from the repository root:

```bash
npm run extension:update-helper
```

For an always-on Studio/PM2 machine:

```bash
pm2 start npm --name ashlar-extension-updater --cwd "$PWD" -- run extension:update-helper
pm2 save
```

The helper binds only to `127.0.0.1:17373`. It accepts browser requests only from a `chrome-extension://` origin and it can only fetch the configured repository branch (default `main`) and replace the fixed `extension/` tree. It cannot write an arbitrary path supplied by the popup.

For stricter pairing, set the existing unpacked extension ID before starting the helper:

```bash
ASHLAR_EXTENSION_UPDATER_EXTENSION_ID=<32-character-extension-id> npm run extension:update-helper
```

Optional settings:

- `ASHLAR_EXTENSION_DIR`: existing unpacked extension directory. Default: this checkout's `extension/`.
- `ASHLAR_EXTENSION_UPDATE_BRANCH`: source branch. Default: `main`.
- `ASHLAR_EXTENSION_UPDATE_PORT`: loopback port. Default: `17373`. **Set the same value in the extension popup's “Local updater port” field.**

## Normal updates

Open the Ashlar extension popup. The **Extension update** section shows the running version, files on disk, and the version currently available from `origin/main`.

When no managed review tab or cleanup operation is active:

1. Confirm **Local updater port** matches `ASHLAR_EXTENSION_UPDATE_PORT`.
2. Click **Check update**.
3. Click **Update & Reload**.
3. The helper fetches `origin/main`, stages only `extension/`, validates the manifest, swaps the directory atomically and leaves one backup.
4. The popup calls `chrome.runtime.reload()`. There is no need to open `chrome://extensions`.

If the files were already updated but Chrome still runs the previous version, the same button becomes **Reload updated files**.

**Rollback & Reload** swaps the previous backup back into the same directory and reloads Chrome.

The popup refuses update/reload while managed review capacity or cleanup is active. Archived server-side JSON repair can continue without an open provider tab, but browser-owned review work is not interrupted for convenience.

## AI / automation workflow

Because update is a single popup action with explicit safe-state checks, an AI/computer-use session can operate the same UI instead of editing files or navigating `chrome://extensions`. The local helper never accepts an arbitrary download URL, branch, target path, or shell command from the popup.

The very first upgrade to a version containing this helper still requires the existing manual unpacked-extension update once. After that bootstrap, future merged `main` versions can use the one-click flow.


## Maintenance lock

Before update or rollback mutates extension files, the popup asks the MV3 worker to persist an extension-maintenance lock. While it is active, the worker pauses new bridge admission/recovery and new managed provider-tab allocation, while already-running collection, archive, repair, and cleanup work can continue.

After the lock is persisted, the worker waits for any admission/allocation boundary that started before the lock and recomputes managed capacity and pending cleanup. The helper is called only when both are zero. Immediately before `chrome.runtime.reload()`, the worker rechecks under the same lock and marks it `reload_ready`. Failed mutations explicitly release the lock. A successful reload clears only the committed `reload_ready` lock when the new worker starts. There is no elapsed-time auto-expiry.
