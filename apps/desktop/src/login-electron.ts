// The Electron implementation of `LoginHost` (I06S-D3): a window on the origin system's page that
// cannot reach `window.pki`, in a fresh in-memory partition; anything but http(s) is refused (navigation, new windows,
// downloads, permission requests). Only the judgement in login.ts is tested upstream; this machinery is
// checked on the real site's IdP in the deployment fork (S49). Its web preferences are `loginWebPreferences`.
import { BrowserWindow, session } from "electron";
import { loginWebPreferences, type LoginHost } from "./login.ts";
import { markLoginSession } from "./window.ts";

const isWeb = (value: unknown): boolean =>
  typeof value === "string" && URL.canParse(value) && /^https?:$/.test(new URL(value).protocol);

export function electronLoginHost(): LoginHost {
  return {
    open({ url, partition }) {
      // a partition name without the `persist:` prefix lives in memory only
      const ses = session.fromPartition(partition);
      markLoginSession(ses); // before the window: the app-wide lockDown skips this session only
      ses.setPermissionRequestHandler((_contents, _permission, grant) => grant(false));
      ses.setPermissionCheckHandler(() => false);
      ses.on("will-download", (event) => event.preventDefault());

      const window = new BrowserWindow({
        width: 520,
        height: 720,
        title: "로그인",
        webPreferences: loginWebPreferences(partition),
      });
      const { webContents } = window;
      webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      const web = (details: { url: string; preventDefault(): void }) => {
        if (!isWeb(details.url)) details.preventDefault();
      };
      webContents.on("will-navigate", web);
      webContents.on("will-redirect", web);
      webContents.on("will-frame-navigate", web);
      webContents.on("will-attach-webview", (event) => event.preventDefault());
      void window.loadURL(url).catch(() => undefined); // a page that does not load is closed by the user

      return {
        onNavigate(listener) {
          webContents.on("did-navigate", (_event, target) => listener(target));
          webContents.on("did-navigate-in-page", (_event, target, isMainFrame) => {
            if (isMainFrame) listener(target);
          });
        },
        onClosed: (listener) => void window.once("closed", listener),
        cookies: async (target) =>
          (await ses.cookies.get({ url: target })).map(({ name, value }) => ({ name, value })),
        async dispose() {
          await ses.clearStorageData().catch(() => undefined);
          if (!window.isDestroyed()) window.destroy();
        },
      };
    },
  };
}
