import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _setStorageRootForTests, listChannels, saveChannel, removeChannel, getChannel } from "./channels.js";
import { buildAuthUrl, YOUTUBE_SCOPES, type OAuthConfig } from "./oauth.js";

let root: string;

before(() => {
  root = mkdtempSync(path.join(tmpdir(), "channels-test-"));
  _setStorageRootForTests(root);
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

test("saveChannel/listChannels/removeChannel round-trip, metadata never contains a token", () => {
  saveChannel(
    { id: "UC_a", ytChannelId: "UC_a", title: "Channel A", thumbnailUrl: "https://x/a.jpg", addedAt: 1 },
    "refresh-token-a"
  );
  const list = listChannels();
  assert.equal(list.length, 1);
  assert.equal(list[0].title, "Channel A");
  assert.ok(!JSON.stringify(list).includes("refresh-token-a"), "refresh token leaked into channels.json");
  assert.equal(getChannel("UC_a")?.title, "Channel A");

  const tokenFile = path.join(root, ".credentials", "UC_a.json");
  assert.ok(existsSync(tokenFile));
  assert.equal(statSync(tokenFile).mode & 0o777, 0o600, "token file must be chmod 600");

  removeChannel("UC_a");
  assert.equal(listChannels().length, 0);
  assert.ok(!existsSync(tokenFile), "token file must be deleted with the channel");
});

test("removing one channel leaves every other channel's token file untouched", () => {
  saveChannel({ id: "UC_x", ytChannelId: "UC_x", title: "X", thumbnailUrl: "", addedAt: 1 }, "token-x");
  saveChannel({ id: "UC_y", ytChannelId: "UC_y", title: "Y", thumbnailUrl: "", addedAt: 2 }, "token-y");

  removeChannel("UC_x");

  assert.equal(listChannels().length, 1);
  assert.equal(listChannels()[0].id, "UC_y");
  assert.ok(!existsSync(path.join(root, ".credentials", "UC_x.json")));
  assert.ok(existsSync(path.join(root, ".credentials", "UC_y.json")), "an unrelated channel's token was deleted");

  removeChannel("UC_y");
});

test("saving a channel again (re-link) overwrites, does not duplicate", () => {
  saveChannel({ id: "UC_z", ytChannelId: "UC_z", title: "Z v1", thumbnailUrl: "", addedAt: 1 }, "t1");
  saveChannel({ id: "UC_z", ytChannelId: "UC_z", title: "Z v2", thumbnailUrl: "", addedAt: 2 }, "t2");
  const list = listChannels();
  assert.equal(list.length, 1);
  assert.equal(list[0].title, "Z v2");
  removeChannel("UC_z");
});

test("buildAuthUrl includes offline access, forced consent, and both required scopes", () => {
  const config: OAuthConfig = { clientId: "cid", clientSecret: "secret", redirectUri: "http://localhost:5177/api/channels/callback" };
  const url = new URL(buildAuthUrl(config, "state123"));
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("client_id"), "cid");
  assert.equal(url.searchParams.get("state"), "state123");
  assert.equal(url.searchParams.get("redirect_uri"), config.redirectUri);
  for (const scope of YOUTUBE_SCOPES.split(" ")) {
    assert.ok(url.searchParams.get("scope")!.includes(scope), `missing scope ${scope}`);
  }
});
