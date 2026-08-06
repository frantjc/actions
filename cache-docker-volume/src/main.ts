import * as core from "@actions/core";
import * as cache from "@actions/cache";
import * as exec from "@actions/exec";
import fs from "fs";
import os from "os";
import path from "path";

const tmp = path.join(
  process.env.RUNNER_TEMP || os.tmpdir(),
  "cache-docker-volume",
);

async function save(): Promise<void> {
  try {
    const image = core.getInput("image", { required: true });
    const volume = core.getInput("volume", { required: true });
    const key = core.getInput("key", { required: true });

    fs.mkdirSync(tmp, { recursive: true });
    await exec.exec("docker", [
      "run",
      "--rm",
      "--entrypoint",
      "cp",
      "-v",
      `${volume}:/volume`,
      "-v",
      `${tmp}:/out`,
      image,
      "-a",
      "/volume/.",
      "/out/",
    ]);

    await cache.saveCache([tmp], key);
    core.info(`saved volume '${volume}' with key '${key}'`);
  } catch (err) {
    if (typeof err === "string" || err instanceof Error) {
      core.setFailed(err);
    } else {
      core.setFailed(`caught unknown error ${err}`);
    }
  }
}

async function restore(): Promise<void> {
  try {
    const image = core.getInput("image", { required: true });
    const volume = core.getInput("volume", { required: true });
    const key = core.getInput("key", { required: true });
    const restoreKeys = core.getMultilineInput("restore-keys").filter(Boolean);

    const hit = await cache.restoreCache([tmp], key, restoreKeys);
    core.setOutput("cache-hit", Boolean(hit));

    if (!hit) {
      core.info(`no cache found for key '${key}'`);
      return;
    }

    await exec.exec("docker", ["volume", "create", volume]);
    await exec.exec("docker", [
      "run",
      "--rm",
      "--entrypoint",
      "cp",
      "-v",
      `${tmp}:/src`,
      "-v",
      `${volume}:/volume`,
      image,
      "-a",
      "/src/.",
      "/volume/",
    ]);
    core.info(`restored volume '${volume}' from cache key '${hit}'`);
  } catch (err) {
    if (typeof err === "string" || err instanceof Error) {
      core.setFailed(err);
    } else {
      core.setFailed(`caught unknown error ${err}`);
    }
  }
}

const isPost = !!core.getState("isPost");

if (isPost) {
  save();
} else {
  core.saveState("isPost", "true");
  restore();
}
