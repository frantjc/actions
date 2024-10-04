import * as core from "@actions/core";
import { Octokit } from "octokit";

const package_type = "container";

async function run(): Promise<void> {
  try {
    const octokit = new Octokit({
      auth: core.getInput("token", {
        required: true,
      }),
    });

    const images = core.getMultilineInput("images", {
      required: true,
    });

    for (const image of images) {
      let cparts = [];
      let isDigest = false;
      if (image.includes("@")) {
        cparts = image.split("@");
        isDigest = true;
      } else {
        cparts = image.split(":");
      }

      if (cparts.length === 1) {
        cparts = cparts.concat(["latest"]);
      }

      if (cparts.length === 2) {
        const sparts = cparts[0].split("/");
        if (sparts.length < 3) {
          throw new Error(`invalid image ${image}`);
        }

        const [registry, username, ...rest] = sparts;
        if (registry !== "ghcr.io") {
          throw new Error(`images must refer to ghcr.io, got ${image}`);
        }

        const package_name = rest.join("/");

        const tagOrDigest = cparts[1];

        if (!username || !package_name || !tagOrDigest) {
          throw new Error(`invalid image ${image}`);
        }

        const packageVersions =
          await octokit.rest.packages.getAllPackageVersionsForPackageOwnedByUser(
            {
              state: "active",
              package_type,
              package_name,
              username,
            },
          );

        const packageVersion = packageVersions.data.find((packageVersion) => {
          return (
            (isDigest && packageVersion.name === tagOrDigest) ||
            packageVersion.metadata?.container?.tags.includes(tagOrDigest)
          );
        });

        if (packageVersion) {
          if (packageVersions.data.length === 1) {
            await octokit.rest.packages.deletePackageForUser({
              package_type,
              package_name,
              username,
            });
          } else {
            await octokit.rest.packages.deletePackageVersionForUser({
              package_type,
              package_name,
              username,
              package_version_id: packageVersion.id,
            });
          }
        } else {
          throw new Error(
            `unable to find package version ID for image ${image}`,
          );
        }
      } else {
        throw new Error(`invalid image ${image}`);
      }
    }
  } catch (err) {
    if (typeof err === "string" || err instanceof Error) {
      core.setFailed(err);
    } else {
      core.setFailed(`caught unknown error ${err}`);
    }
  }
}

run();
