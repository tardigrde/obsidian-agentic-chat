import { afterEach, beforeEach } from "vitest";
import { installObsidianDom, shownNotices } from "./obsidian-dom";
import { installOfflineGuard } from "../../support/offline-guard";

installObsidianDom();
installOfflineGuard();

beforeEach(() => {
  shownNotices.splice(0);
});

afterEach(() => {
  document.body.replaceChildren();
});
