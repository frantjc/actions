import * as core from "@actions/core";
import * as cache from "@actions/cache";
import * as cp from "@actions/exec";
import fs from "fs";
import os from "os";
import path from "path";

const tmp = path.join(
  process.env.RUNNER_TEMP || os.tmpdir(),
  "cache-docker-volume",
);

async function restore(): Promise<void> {
  if (!cache.isFeatureAvailable()) {
    core.setOutput("cache-hit", Boolean(false));
    return;
  }

  try {
    const image = core.getInput("image", { required: true });
    const volume = core.getInput("volume", { required: true });
    const key = core.getInput("key", { required: true });
    const restoreKeys = core.getMultilineInput("restore-keys").filter(Boolean);

    const cacheKey = await cache.restoreCache([tmp], key, restoreKeys);
    core.setOutput("cache-hit", Boolean(cacheKey));

    if (!cacheKey) {
      core.info(
        `Cache not found for input keys: ${[key, ...restoreKeys].join(", ")}`,
      );
      return;
    }

    core.saveState("cacheKey", cacheKey);

    await cp.exec("docker", ["volume", "create", volume]);
    await cp.exec("docker", [
      "run",
      "--rm",
      "--entrypoint",
      "tar",
      "-v",
      `${tmp}:/restore`,
      "-v",
      `${volume}:/volume`,
      image,
      "-xzf",
      "/restore/volume.tar.gz",
      "-C",
      "/volume",
    ]);
    core.info(`Volume restored from key: ${cacheKey}`);
  } catch (err) {
    if (typeof err === "string" || err instanceof Error) {
      core.setFailed(err);
    } else {
      core.setFailed(`Caught unknown error ${err}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function save(): Promise<void> {
  if (!cache.isFeatureAvailable()) {
    return;
  }

  try {
    const image = core.getInput("image", { required: true });
    const volume = core.getInput("volume", { required: true });
    const key = core.getInput("key", { required: true });

    const cacheKey = core.getState("cacheKey");
    if (cacheKey === key) {
      return;
    }

    fs.mkdirSync(tmp, { recursive: true });
    await cp.exec("docker", [
      "run",
      "--rm",
      "--entrypoint",
      "tar",
      "-v",
      `${volume}:/volume`,
      "-v",
      `${tmp}:/save`,
      image,
      "-czf",
      "/save/volume.tar.gz",
      "-C",
      "/volume",
      ".",
    ]);

    const cacheId = await cache.saveCache([tmp], key);
    if (cacheId != -1) {
      core.info(`Cache saved with key: ${key}`);
    }
  } catch (err) {
    if (err instanceof cache.ReserveCacheError) {
      return;
    } else if (typeof err === "string" || err instanceof Error) {
      core.setFailed(err);
    } else {
      core.setFailed(`Caught unknown error ${err}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const isPost = !!core.getState("isPost");

if (isPost) {
  save();
} else {
  core.saveState("isPost", "true");
  restore();
}
