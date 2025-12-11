import * as core from "@actions/core";
import * as tc from "@actions/tool-cache";
import * as gh from "@actions/github";
import os from "os";
import path from "path";
import semver from "semver";

const runnerArchesAliases: Record<string, string[]> = {
  x86: ["x86", "i386", "i486", "i586", "i686", "ia32", "386"],
  x64: ["x86_64", "x64", "amd64"],
  arm: ["arm", "armv6", "armv7", "armhf", "arm32"],
  arm64: ["arm64", "aarch64"],
};

const runnerArch = process.env.RUNNER_ARCH?.toLowerCase() || os.arch();
const runnerArchAliases = runnerArchesAliases[runnerArch];

const runnerOs = (function () {
  const rawRunnerOs = process.env.RUNNER_OS || os.type();
  switch (rawRunnerOs) {
    case "macOS":
      return "darwin";
    case "Windows_NT":
      return "windows";
    default:
      return rawRunnerOs.toLowerCase();
  }
})();

const runnerOsToolExtension = runnerOs === "windows" ? ".exe" : "";

// FIXME(frantjc): path.extname("foo.tar.gz") === ".gz", so we use .gz everywhere.
// This doesn't seem to break anything, but it feels a bit gross.
const extractExtensions = [".tgz", ".gz", ".zip"];

const toolExtensions = extractExtensions.concat(runnerOsToolExtension);

const tmp = process.env.RUNNER_TEMP || os.tmpdir();

// FIXME(frantjc): Paginate instead of relying on there being <=100 items.
const per_page = 100;

async function run(): Promise<void> {
  try {
    const token = core.getInput("token", {
      required: true,
    });
    const octokit = gh.getOctokit(token);
    const auth = token ? `token ${token}` : undefined;

    const repository = core.getInput("repository", {
      required: true,
    });
    const [owner, repo] = repository.split("/", 2);
    let version = core.getInput("version");
    let release_id = 0;
    if (!version) {
      const releasesRes = await octokit.rest.repos.listReleases({
        owner,
        repo,
        per_page,
      });
      const releases = releasesRes.data;
      const release = releases.reduce((acc, cur) => {
        if (!acc) {
          return cur;
        }

        const curcoerced = semver.coerce(cur.tag_name);
        const acccoerced = semver.coerce(acc.tag_name);
        if (curcoerced && !acccoerced) {
          return cur;
        } else if (
          curcoerced &&
          acccoerced &&
          semver.compare(curcoerced, acccoerced) > 0
        ) {
          return cur;
        }

        return acc;
      });
      if (!release) {
        throw new Error(`no releases found in ${repository}`);
      }
      version = release.tag_name;
      release_id = release.id;
    }
    let tagName = version;

    const tool = core.getInput("tool") || repo;
    let toolPath = tc.find(tool, version, runnerArch);
    if (!toolPath) {
      let tags = [version];
      let page = 1;
      for (let i = 0; !release_id && i < tags.length; i++) {
        const tag = tags[i];
        core.debug(`checking for release on tag ${tag}`);
        try {
          const releaseRes = await octokit.rest.repos.getReleaseByTag({
            owner,
            repo,
            tag,
          });
          const release = releaseRes.data;
          release_id = release.id;
          tagName = release.tag_name;
        } catch (err) {
          core.info(`failed to get release by tag ${tag}: ${err}`);
          for (; i === tags.length - 1; page++) {
            const vercoerced = semver.coerce(version);
            if (!vercoerced) {
              throw new Error(
                "version must be empty, an exact tag, or coercible into a semver",
              );
            }
            const range = new semver.Range(`^${vercoerced}`);
            core.debug(`checking page ${page} for tags in range ${range}`);
            const tagsRes = await octokit.rest.repos.listTags({
              owner,
              repo,
              page,
            });
            const newTags = tagsRes.data
              .map((tag) => tag.name)
              // NB: .filter(range.test) doesn't work for some reason :(
              .filter((tag) => range.test(tag));
            core.debug(
              `found new tags in range ${range} on page ${page}: ${newTags.join(" ")}`,
            );
            tags = tags.concat(newTags);
          }
        }
      }

      if (!release_id) {
        throw new Error(`no release found with a tag matching ${version}`);
      }
      core.info(
        `found release ${release_id} on tag ${tagName} matching version ${version} in ${repository}`,
      );

      const releaseAssetsRes = await octokit.rest.repos.listReleaseAssets({
        owner,
        repo,
        release_id,
        per_page,
      });
      const releaseAssets = releaseAssetsRes.data;

      const toolReleaseAsset = releaseAssets.find((ra) => {
        const name = ra.name.toLowerCase();
        const ext = path.extname(name);
        core.debug(
          `checking release asset ${name} for match to ${runnerOs}/${runnerArch}`,
        );
        if (!toolExtensions.includes(ext)) {
          core.debug(
            `release asset ${name} does not have a valid extension for a tool`,
          );
          return false;
        } else if (!name.includes(runnerOs)) {
          core.debug(`release asset ${name} does not match ${runnerOs}`);
          return false;
        } else if (
          !runnerArchAliases.some((runnerArchAlias) =>
            name.includes(runnerArchAlias),
          )
        ) {
          core.debug(`release asset ${name} does not match ${runnerArch}`);
          return false;
        }
        return true;
      });

      if (!toolReleaseAsset) {
        throw new Error(
          `no release assets matching ${runnerOs}/${runnerArch} were found on release ${release_id} in ${repository}`,
        );
      }
      core.info(
        `found release asset ${toolReleaseAsset.name} matching ${runnerOs}/${runnerArch} on release ${release_id} in ${repository}`,
      );

      const downloadDest = path.join(tmp, toolReleaseAsset.name);
      const downloadPath = await tc.downloadTool(
        toolReleaseAsset.browser_download_url,
        downloadDest,
        auth,
      );

      const checksumReleaseAsset = releaseAssets.find((ra) => {
        const name = ra.name.toLowerCase();
        return name.endsWith("checksums.txt");
      });

      if (checksumReleaseAsset) {
        // TODO(frantjc): Checksum, if available in the release assets.
      }

      let cachePath = downloadPath;

      const ext = path.extname(downloadPath);
      const extractDest = path.join(tmp, path.basename(downloadPath, ext));
      if (extractExtensions.includes(ext)) {
        switch (ext) {
          case ".tgz":
          case ".gz":
            await tc.extractTar(downloadPath, extractDest);
            break;
          case ".zip":
            await tc.extractZip(downloadPath, extractDest);
            break;
          default:
            throw new Error(
              `unhandled asset extension that needs extracted ${ext}`,
            );
        }
        cachePath = path.join(extractDest, `${tool}${runnerOsToolExtension}`);
      }

      if (!tagName) {
        tagName = semver.coerce(version)?.toString() || "";
      }
      toolPath = await tc.cacheFile(cachePath, tool, tool, tagName, runnerArch);
      core.info(`cached ${tool} ${tagName}`);
    } else {
      core.info(`found ${tool} ${version} in cache`);
    }

    core.addPath(toolPath);
    core.info(`setup ${tool} ${tagName || version}`);
  } catch (err) {
    if (typeof err === "string" || err instanceof Error) {
      core.setFailed(err);
    } else {
      core.setFailed(`caught unknown error ${err}`);
    }
  }
}

run();
