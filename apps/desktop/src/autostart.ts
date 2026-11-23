// The tray's "start at login" item (H02A-R10, D7, D8). The OS registration is the only
// state: the check shows what the OS says and a click writes the opposite. Outside a
// packaged app the item is disabled, so a development run never registers Electron's own
// executable as the thing to start at login.
export interface AutostartItem {
  label: string;
  type: "checkbox";
  checked: boolean;
  enabled: boolean;
  click: () => void;
}

export function autostartMenuItem(input: {
  packaged: boolean;
  get: () => boolean;
  set: (enabled: boolean) => void;
}): AutostartItem {
  return {
    label: "로그인할 때 자동 시작",
    type: "checkbox",
    checked: input.packaged && input.get(),
    enabled: input.packaged,
    click: () => {
      if (input.packaged) input.set(!input.get());
    },
  };
}
