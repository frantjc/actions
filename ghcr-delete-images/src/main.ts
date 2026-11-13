import * as core from "@actions/core";
import * as gh from "@actions/github";

const package_type = "container";

type PackageVersion = {
  id: number;
  name: string;
  metadata?: { container?: { tags: string[] } };
};

async function run(): Promise<void> {
  try {
    const token = core.getInput("token", {
      required: true,
    });
    const octokit = gh.getOctokit(token);
    const tags = core.getMultilineInput("tags", {
      required: true,
    });
    // listed once per package rather than per tag, since a package can have thousands of versions
    const versionsByPackage = new Map<string, PackageVersion[]>();

    for (const tag of tags) {
      let cparts = [];
      let isDigest = false;
      if (tag.includes("@")) {
        cparts = tag.split("@");
        isDigest = true;
      } else {
        cparts = tag.split(":");
      }

      if (cparts.length === 1) {
        cparts = cparts.concat(["latest"]);
      }

      if (cparts.length === 2) {
        const sparts = cparts[0].split("/");
        if (sparts.length < 3) {
          throw new Error(`invalid image tag ${tag}`);
        }

        const [registry, username, ...rest] = sparts;
        if (registry !== "ghcr.io") {
          throw new Error(`image tags must refer to ghcr.io, got ${tag}`);
        }

        const package_name = rest.join("/");

        const tagOrDigest = cparts[1];

        if (!username || !package_name || !tagOrDigest) {
          throw new Error(`invalid image tag ${tag}`);
        }

        const key = `${username}/${package_name}`;
        let packageVersions = versionsByPackage.get(key);
        if (!packageVersions) {
          packageVersions = (await octokit.paginate(
            octokit.rest.packages.getAllPackageVersionsForPackageOwnedByUser,
            {
              state: "active",
              package_type,
              package_name,
              username,
              per_page: 100,
            },
          )) as PackageVersion[];
          versionsByPackage.set(key, packageVersions);
        }

        const packageVersion = packageVersions.find((packageVersion) => {
          return (
            (isDigest && packageVersion.name === tagOrDigest) ||
            packageVersion.metadata?.container?.tags.includes(tagOrDigest)
          );
        });

        if (packageVersion) {
          if (packageVersions.length === 1) {
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
          versionsByPackage.set(
            key,
            packageVersions.filter((v) => v.id !== packageVersion.id),
          );
        } else {
          throw new Error(
            `unable to find package version ID for image tag ${tag}`,
          );
        }
      } else {
        throw new Error(`invalid image tag ${tag}`);
      }
    }
  } catch (err) {
    if (typeof err === "string" || err instanceof Error) {
      core.setFailed(err);
    } else {
      core.setFailed(`Caught unknown error ${err}`);
    }
  }
}

run();
