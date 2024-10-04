import * as core from "@actions/core";
import * as cp from "@actions/exec";

import fs from "fs";
import path from "path";
import yaml from "yaml";
import undici from "undici";
import http from "http";

async function run(): Promise<void> {
  try {
    let chartPath = core.getInput("chart-path", { required: true });

    const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
    if (!path.isAbsolute(chartPath) && workspace) {
      chartPath = path.join(workspace, chartPath);
    }

    const chartYAMLPath = path.join(chartPath, "Chart.yaml");
    const chartYAML = yaml.parse(fs.readFileSync(chartYAMLPath).toString());
    const chartName = chartYAML.name;
    let chartVersion = chartYAML.version;
    let chartAppVersion = chartYAML.appVersion;

    let packageArgs = ["package", chartPath];

    const debug = core.isDebug();
    if (debug) {
      packageArgs = packageArgs.concat(["--debug"]);
    }

    const version = core.getInput("version");
    if (version) {
      packageArgs = packageArgs.concat(["--version", version]);
      chartVersion = version;
    }

    const destination = process.env.RUNNER_TEMP;
    if (destination) {
      packageArgs = packageArgs.concat(["--destination", destination]);
    }

    const chartBase = `${chartName}-${chartVersion}.tgz`;
    let chart = path.join(workspace, chartBase);
    if (destination) {
      chart = path.join(destination, chartBase);
    }

    const dependencyUpdate = core.getBooleanInput("dependency-update");
    if (dependencyUpdate) {
      packageArgs = packageArgs.concat(["--dependency-update"]);
    }

    const appVersion = core.getInput("app-version");
    if (appVersion) {
      packageArgs = packageArgs.concat(["--app-version", appVersion]);
      chartAppVersion = appVersion;
    }

    core.startGroup("helm package");
    await cp.exec("helm", packageArgs);
    core.endGroup();

    core.setOutput("package", chart);
    core.setOutput("appVersion", chartAppVersion);
    core.setOutput("version", chartVersion);
    core.setOutput("name", chartName);

    const push = core.getBooleanInput("push");

    if (push) {
      const repository = new URL(
        core.getInput("repository", { required: true }),
      );

      core.setOutput("repo", repository);

      const username = core.getInput("username");
      const password = core.getInput("password");
      const insecure = core.getBooleanInput("insecure");

      switch (repository.protocol.slice(0, -1)) {
        case "oci":
          if (username && password) {
            let registryLoginArgs = [
              "registry",
              "login",
              repository.host,
              "--username",
              username,
              "--password",
              password,
            ];

            if (debug) {
              registryLoginArgs = registryLoginArgs.concat(["--debug"]);
            }

            if (insecure) {
              registryLoginArgs = registryLoginArgs.concat(["--insecure"]);
            }

            core.startGroup("helm registry login");
            await cp.exec("helm", registryLoginArgs);
            core.endGroup();
          }

          let pushArgs = ["push", chart, repository.toString()];

          if (debug) {
            pushArgs = pushArgs.concat(["--debug"]);
          }

          if (insecure) {
            pushArgs = pushArgs.concat(["--insecure-skip-tls-verify"]);
          }

          core.startGroup("helm push");
          await cp.exec("helm", pushArgs);
          core.endGroup();

          core.setOutput("chart", path.join(repository.toString(), chartName));

          break;
        case "http":
        case "https":
          const { size } = fs.statSync(chart);
          const body = fs.createReadStream(chart);
          let headers: http.IncomingHttpHeaders = {
            "Content-Length": size.toString(),
          };

          if (username && password) {
            headers["Authorization"] =
              `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
          }

          await new undici.Client(repository, {
            connect: {
              requestCert: !insecure,
            },
          }).request({
            method: "POST",
            path: chartBase,
            headers,
            body,
          });

          core.setOutput("chart", path.join(repository.toString(), chartBase));

          break;
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
