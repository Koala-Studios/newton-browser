import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  cleanupPackCheckTempRoot,
  createPackCheckTempRoot,
  isolatedPackCheckEnvironment,
} from "../scripts/pack-check.mjs";

test("pack-check utility environment cannot mutate user config and is cleaned exactly", () => {
  const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), "newton-browser-user-sentinel-"));
  const userConfig = path.join(userRoot, "NewtonBrowser");
  const sentinel = path.join(userConfig, "config.json");
  const sentinelContents = '{"hostile":"user-sentinel"}\n';
  fs.mkdirSync(userConfig, { recursive: true });
  fs.writeFileSync(sentinel, sentinelContents);

  const packRoot = createPackCheckTempRoot();
  try {
    const env = isolatedPackCheckEnvironment(packRoot, {
      ...process.env,
      HOME: userRoot,
      USERPROFILE: userRoot,
      LOCALAPPDATA: userRoot,
      APPDATA: userRoot,
      XDG_CONFIG_HOME: userRoot,
      NEWTON_BROWSER_CONFIG_DIR: userConfig,
    });
    assert.notEqual(path.resolve(env.NEWTON_BROWSER_CONFIG_DIR), path.resolve(userConfig));
    assert.equal(path.relative(packRoot, env.NEWTON_BROWSER_CONFIG_DIR).startsWith(".."), false);

    const child = spawnSync(process.execPath, [
      "--input-type=module",
      "--eval",
      "import fs from 'node:fs'; import path from 'node:path'; fs.mkdirSync(process.env.NEWTON_BROWSER_CONFIG_DIR, {recursive:true}); fs.writeFileSync(path.join(process.env.NEWTON_BROWSER_CONFIG_DIR, 'config.json'), 'isolated');",
    ], { env, encoding: "utf8", windowsHide: true });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(fs.readFileSync(sentinel, "utf8"), sentinelContents);
    assert.equal(fs.readFileSync(path.join(env.NEWTON_BROWSER_CONFIG_DIR, "config.json"), "utf8"), "isolated");

    cleanupPackCheckTempRoot(packRoot);
    assert.equal(fs.existsSync(packRoot), false);
  } finally {
    if (fs.existsSync(packRoot)) cleanupPackCheckTempRoot(packRoot);
    fs.rmSync(userRoot, { recursive: true, force: true });
  }
});

test("pack-check cleanup rejects a same-prefix impostor it did not create", () => {
  const unrelated = fs.mkdtempSync(path.join(os.tmpdir(), "newton-browser pack check with spaces impostor-"));
  const sentinel = path.join(unrelated, "outside-sentinel");
  fs.writeFileSync(sentinel, "preserve");
  try {
    assert.throws(() => cleanupPackCheckTempRoot(unrelated), /invalid pack-check temporary root/);
    assert.equal(fs.existsSync(unrelated), true);
    assert.equal(fs.readFileSync(sentinel, "utf8"), "preserve");
  } finally {
    fs.rmSync(unrelated, { recursive: true, force: true });
  }
});

test("pack-check cleanup rejects a temporary-root link replacement", (context) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "newton-browser-pack-check-outside-"));
  const sentinel = path.join(outside, "outside-sentinel");
  fs.writeFileSync(sentinel, "preserve");
  const packRoot = createPackCheckTempRoot();
  fs.rmSync(packRoot, { recursive: true, force: true });
  try {
    try {
      fs.symlinkSync(outside, packRoot, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES" || error?.code === "ENOTSUP") {
        context.skip(`link creation unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    assert.throws(() => cleanupPackCheckTempRoot(packRoot), /invalid pack-check temporary root/);
    assert.equal(fs.readFileSync(sentinel, "utf8"), "preserve");
  } finally {
    if (fs.existsSync(packRoot)) {
      const stat = fs.lstatSync(packRoot);
      if (stat.isSymbolicLink()) fs.unlinkSync(packRoot);
      else fs.rmSync(packRoot, { recursive: true, force: true });
    }
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
