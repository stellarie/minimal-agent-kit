export type SideTab = "members" | "events" | "files";

export const SIDE_TABS: readonly SideTab[] = ["members", "events", "files"];
export const SIDE_TAB_KEY = "lounge.sideTab";

export function readSideTab(storage: Pick<Storage, "getItem">): SideTab {
  let raw: string | null = null;
  try {
    raw = storage.getItem(SIDE_TAB_KEY);
  } catch {
    // A blocked store gives the default tab.
  }
  return SIDE_TABS.find((tab) => tab === raw) ?? "members";
}

export function writeSideTab(storage: Pick<Storage, "setItem">, tab: SideTab): void {
  try {
    storage.setItem(SIDE_TAB_KEY, tab);
  } catch {
    // The tab then resets on reload.
  }
}
