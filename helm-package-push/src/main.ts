import * as core from "@actions/core";
import * as cp from "@actions/exec";

import fs from "fs";
import path from "path";
import yaml from "yaml";
import undici from "undici";
import http from "http";
import crypto from "crypto";
import { Writable } from "stream";

type SetupOpts = {
  debug?: boolean;
};

type LoginOpts = {
  username?: string;
  password?: string;
  debug?: boolean;
  insecure?: boolean;
};

type PushOpts = {
  chartTgzPath: string;
  chartName: string;
  chartVersion: string;
  username?: string;
  password?: string;
  debug?: boolean;
  insecure?: boolean;
};

type LogoutOpts = {
  debug?: boolean;
};

type CleanupOpts = {
  debug?: boolean;
};

abstract class Pusher {
  public repository: URL;
  public repoName: string;

  constructor(url: URL) {
    this.repository = url;
    this.repoName = `${this.repository.hostname}-${crypto.randomUUID().toString()}`;
  }

  async setup(_: SetupOpts): Promise<void> {}

  async login(opts: LoginOpts): Promise<void> {
    let repoAddArgs = [
      "repo",
      "add",
      this.repoName,
      this.repository.toString(),
    ];

    if (opts?.username && opts?.password) {
      repoAddArgs = repoAddArgs.concat(
        "--username",
        opts.username,
        "--password",
        opts.password,
      );
    }

    if (opts?.debug) {
      repoAddArgs = repoAddArgs.concat("--debug");
    }

    if (opts?.insecure) {
      repoAddArgs = repoAddArgs.concat("--insecure-skip-tls-verify");
    }

    core.startGroup("Exec helm repo add");
    await cp.exec("helm", repoAddArgs);
    core.endGroup();

    core.saveState("repoName", this.repoName);
  }

  abstract push(_: PushOpts): Promise<string>;

  async logout(opts: LogoutOpts): Promise<void> {
    const repoName = core.getState("repoName");

    if (repoName !== "") {
      helmRepoRemove(repoName, opts?.debug);
    }
  }

  async cleanup(_: CleanupOpts): Promise<void> {}
}

type HelmPlugin = {
  name: string;
  version: string;
  description: string;
};

function parseHelmPluginList(output: string): Array<HelmPlugin> {
  const lines = output.trim().split("\n");

  if (lines.length > 1) {
    return lines.slice(1).map((line) => {
      const cols = line.split(/\t/).map((c) => c.trim());

      if (cols.length < 3) {
        throw new Error(`invalid helm plugin list output: ${line}`);
      }

      return {
        name: cols[0],
        version: cols[1],
        description: cols[2],
      };
    });
  }

  return [];
}

async function helmPluginUninstall(
  pluginName: string,
  debug?: boolean,
): Promise<void> {
  let pluginUninstallArgs = ["plugin", "uninstall", pluginName];

  if (debug) {
    pluginUninstallArgs = pluginUninstallArgs.concat("--debug");
  }

  let pluginUninstallOutput = "";

  core.startGroup(`Exec helm plugin uninstall ${pluginName}`);
  try {
    await cp.exec("helm", pluginUninstallArgs, {
      listeners: {
        stdout: (data) => {
          pluginUninstallOutput += data;
        },
      },
    });
  } catch (err) {
    if (!pluginUninstallOutput.includes(`Plugin: ${pluginName} not found`)) {
      throw err;
    }
  }
  core.endGroup();
}

// Plugin: cm-push not found

class ChartMuseumPusher extends Pusher {
  async setup(opts?: SetupOpts): Promise<void> {
    let pluginListOutput = "";

    core.startGroup("Exec helm plugin list");
    await cp.exec("helm", ["plugin", "list"], {
      listeners: {
        stdout: (data) => {
          pluginListOutput += data;
        },
      },
    });
    core.endGroup();

    const installedPlugins = parseHelmPluginList(pluginListOutput);

    const pluginVersion = process.env.CM_PLUGIN_VERSION || "v0.10.4";
    const displayPluginVersion = pluginVersion.slice(1);

    const alreadyInstalled = installedPlugins.some((plugin) => {
      return (
        plugin.name === "cm-push" && plugin.version === displayPluginVersion
      );
    });

    if (alreadyInstalled) {
      core.debug("Helm cm-push plugin already installed");
      return;
    }

    const wrongVersion = installedPlugins.some((plugin) => {
      return (
        plugin.name === "cm-push" && plugin.version !== displayPluginVersion
      );
    });

    if (wrongVersion) {
      core.debug(`Uninstalling incorrect version of helm cm-push plugin`);
      helmPluginUninstall("cm-push", opts?.debug);
    }

    let pluginInstallArgs = [
      "plugin",
      "install",
      "https://github.com/chartmuseum/helm-push",
      `--version=${pluginVersion}`,
    ];

    if (opts?.debug) {
      pluginInstallArgs = pluginInstallArgs.concat("--debug");
    }

    core.startGroup("Exec helm plugin install");
    await cp.exec("helm", pluginInstallArgs);
    core.endGroup();
  }

  async push(opts: PushOpts): Promise<string> {
    let cmPushArgs = [
      "cm-push",
      opts.chartTgzPath,
      `--version=${opts.chartVersion}`,
      `--context-path=${this.repository.pathname}`,
    ];

    if (opts?.insecure) {
      cmPushArgs = cmPushArgs.concat("--insecure");
    }

    cmPushArgs = cmPushArgs.concat(this.repoName);

    core.startGroup("Exec helm cm-push");
    await cp.exec("helm", cmPushArgs);
    core.endGroup();

    const chartBase = path.basename(opts.chartTgzPath);

    return path.join(this.repository.toString(), chartBase);
  }

  async cleanup(opts?: CleanupOpts): Promise<void> {
    let pluginUninstallArgs = ["plugin", "uninstall", "cm-push"];

    if (opts?.debug) {
      pluginUninstallArgs = pluginUninstallArgs.concat("--debug");
    }

    core.startGroup("Exec helm plugin uninstall");
    await cp.exec("helm", pluginUninstallArgs);
    core.endGroup();
  }
}

class OCIPusher extends Pusher {
  async login(opts: LoginOpts): Promise<void> {
    let registryLoginArgs = ["registry", "login", this.repository.host];

    if (opts?.username && opts?.password) {
      registryLoginArgs = registryLoginArgs.concat(
        "--username",
        opts.username,
        "--password",
        opts.password,
      );
    }

    if (opts?.debug) {
      registryLoginArgs = registryLoginArgs.concat("--debug");
    }

    if (opts?.insecure) {
      registryLoginArgs = registryLoginArgs.concat("--insecure");
    }

    core.startGroup("Exec helm registry login");
    await cp.exec("helm", registryLoginArgs);
    core.endGroup();
  }

  async push(opts: PushOpts): Promise<string> {
    let pushArgs = ["push", opts.chartTgzPath, this.repository.toString()];

    if (opts?.debug) {
      pushArgs = pushArgs.concat("--debug");
    }

    if (opts?.insecure) {
      pushArgs = pushArgs.concat("--insecure-skip-tls-verify");
    }

    core.startGroup("Exec helm push");
    await cp.exec("helm", pushArgs);
    core.endGroup();

    return path.join(this.repository.toString(), opts.chartName);
  }

  async logout(opts: LogoutOpts): Promise<void> {
    let registryLogoutArgs = ["registry", "logout", this.repository.host];

    if (opts?.debug) {
      registryLogoutArgs = registryLogoutArgs.concat("--debug");
    }

    core.startGroup("Exec helm registry logout");
    await cp.exec("helm", registryLogoutArgs);
    core.endGroup();
  }
}

class ArtifactoryPusher extends Pusher {
  async push(opts: PushOpts): Promise<string> {
    const { size } = fs.statSync(opts.chartTgzPath);
    const body = fs.createReadStream(opts.chartTgzPath);
    let headers: http.IncomingHttpHeaders = {
      "Content-Length": size.toString(),
    };

    if (opts?.username && opts?.password) {
      headers["Authorization"] =
        `Basic ${Buffer.from(`${opts.username}:${opts.password}`).toString("base64")}`;
    }

    const chartBase = path.basename(opts.chartTgzPath);

    if (this.repository.protocol === "rt:") {
      this.repository.protocol = `${process.env.RT_SCHEME || "https"}`;
    }

    core.startGroup("builtin push");
    await new undici.Client(this.repository.origin, {
      connect: {
        rejectUnauthorized: !opts?.insecure,
        requestCert: !opts?.insecure,
      },
    }).request({
      method: "PUT",
      path: path.join(this.repository.pathname, chartBase),
      headers,
      body,
    });
    core.endGroup();

    return path.join(this.repository.toString(), chartBase);
  }
}

class URLOpener<T> {
  constructor(private ctor: new (url: URL) => T) {}

  open(url: URL): T {
    return new this.ctor(url);
  }
}

class URLMux<T> {
  private handlers = new Map<string, URLOpener<T>>();

  register(
    opener: URLOpener<T>,
    scheme: string,
    ...schemes: Array<string>
  ): void {
    for (const s of schemes.concat(scheme)) {
      this.handlers.set(s, opener);
    }
  }

  open(addr: string): T {
    const url = new URL(addr);
    const scheme = url.protocol.slice(0, -1);
    const opener = this.handlers.get(scheme);

    if (!opener) {
      throw new Error(`nothing registered for scheme ${scheme}`);
    }

    return opener.open(url);
  }
}

const urlMux = new URLMux<Pusher>();
urlMux.register(new URLOpener(ChartMuseumPusher), "cm");
urlMux.register(new URLOpener(OCIPusher), "oci");
urlMux.register(new URLOpener(ArtifactoryPusher), "rt", "https", "http");

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
      packageArgs = packageArgs.concat("--debug");
    }

    const version = core.getInput("version");
    if (version) {
      packageArgs = packageArgs.concat("--version", version);
      chartVersion = version;
    }

    const appVersion = core.getInput("app-version");
    if (appVersion) {
      packageArgs = packageArgs.concat("--app-version", appVersion);
      chartAppVersion = appVersion;
    }

    const destination = process.env.RUNNER_TEMP;
    if (destination) {
      packageArgs = packageArgs.concat("--destination", destination);
    }

    const chartBase = `${chartName}-${chartVersion}.tgz`;
    let chartTgzPath = path.join(workspace, chartBase);
    if (destination) {
      chartTgzPath = path.join(destination, chartBase);
    }

    const repository = new URL(core.getInput("repository", { required: true }));

    const username = core.getInput("username");
    const password = core.getInput("password");
    const insecure = core.getBooleanInput("insecure");

    const dependencyUpdate = core.getBooleanInput("dependency-update");
    if (dependencyUpdate) {
      core.debug("Setting up dependencies");

      let repoNames: Array<string> = [];

      if (Array.isArray(chartYAML.dependencies)) {
        for (const dependency of chartYAML.dependencies) {
          const dependencyRepository = new URL(dependency.repository);

          switch (dependencyRepository.protocol.slice(0, -1)) {
            case "file":
              core.info(
                `Skipping helm repo add for local dependency ${dependency.name}`,
              );

              break;
            case "http":
            case "https":
              const repoName = `${dependencyRepository.hostname}-${crypto.randomUUID().toString()}`;

              let repoAddArgs = [
                "repo",
                "add",
                repoName,
                dependencyRepository.toString(),
              ];

              if (
                dependencyRepository.origin === repository.origin &&
                username &&
                password
              ) {
                repoAddArgs = repoAddArgs.concat(
                  "--username",
                  username,
                  "--password",
                  password,
                );
              }

              if (insecure) {
                repoAddArgs = repoAddArgs.concat("--insecure-skip-tls-verify");
              }

              core.startGroup(
                `helm repo add ${dependencyRepository.toString()}`,
              );
              await cp.exec("helm", repoAddArgs);
              core.endGroup();

              repoNames = repoNames.concat(repoName);

              core.saveState("dependencyRepoNames", JSON.stringify(repoNames));

              break;
            default:
              core.warning(
                `Skipping helm repo add due to unknown scheme ${dependencyRepository.protocol} in dependency ${dependency.name}`,
              );
          }
        }

        packageArgs = packageArgs.concat("--dependency-update");
      } else if (chartYAML.dependencies) {
        throw new Error(`${chartYAMLPath} dependencies are invalid`);
      }
    }

    core.debug("Packaging chart");

    core.startGroup("Exec helm package");
    await cp.exec("helm", packageArgs);
    core.endGroup();

    core.setOutput("package", chartTgzPath);
    core.setOutput("appVersion", chartAppVersion);
    core.setOutput("version", chartVersion);
    core.setOutput("name", chartName);

    const push = core.getBooleanInput("push");

    if (push) {
      const pusher = urlMux.open(repository.toString());

      core.debug("Setting up");

      await pusher.setup({ debug });

      core.debug("Logging in");

      await pusher.login({
        username,
        password,
        debug,
        insecure,
      });

      core.debug("Pushing chart");

      const chart = await pusher.push({
        chartTgzPath,
        chartName,
        chartVersion,
        username,
        password,
        debug,
        insecure,
      });

      core.setOutput("chart", chart);
    }
  } catch (err) {
    if (typeof err === "string" || err instanceof Error) {
      core.setFailed(err);
    } else {
      core.setFailed(`caught unknown error ${err}`);
    }
  }
}

async function helmRepoRemove(
  repoName: string,
  debug?: boolean,
): Promise<void> {
  let repoRemoveArgs = ["repo", "remove", repoName];

  if (debug) {
    repoRemoveArgs = repoRemoveArgs.concat("--debug");
  }

  let repoRemoveOutput = "";

  core.startGroup(`Exec helm repo remove ${repoName}`);
  try {
    await cp.exec("helm", repoRemoveArgs, {
      listeners: {
        stdout: (data) => {
          repoRemoveOutput += data;
        },
      },
    });
  } catch (err) {
    if (!repoRemoveOutput.includes(`no repo named "${repoName}" found`)) {
      throw err;
    }
  }
  core.endGroup();
}

async function cleanup(): Promise<void> {
  try {
    const debug = core.isDebug();

    const dependencyUpdate = core.getBooleanInput("dependency-update");
    if (dependencyUpdate) {
      core.debug("Tearing down dependencies");

      const repoNames = JSON.parse(
        core.getState("dependencyRepoNames") || "[]",
      ) as Array<string>;

      for (const repoName of repoNames) {
        helmRepoRemove(repoName, debug);
      }
    }

    const push = core.getBooleanInput("push");

    if (push) {
      const repository = new URL(
        core.getInput("repository", { required: true }),
      );

      const pusher = urlMux.open(repository.toString());

      core.debug("Logging out");

      await pusher.logout({
        debug,
      });

      core.debug("Cleaning up");

      await pusher.cleanup({
        debug,
      });
    }
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
  cleanup();
} else {
  core.saveState("isPost", "true");
  run();
}
