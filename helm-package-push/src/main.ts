import * as core from "@actions/core";
import * as cp from "@actions/exec";

import fs from "fs";
import path from "path";
import yaml from "yaml";
import undici from "undici";
import http from "http";
import crypto from "crypto";

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
    this.repoName =
      core.getState("repoName") ||
      `${this.repository.hostname}-${crypto.randomUUID().toString()}`;
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

    core.startGroup("helm repo add");
    await cp.exec("helm", repoAddArgs);
    core.endGroup();

    core.saveState("repoName", this.repoName);
  }

  abstract push(_: PushOpts): Promise<string>;

  async logout(opts: LogoutOpts): Promise<void> {
    let repoRemoveArgs = ["repo", "remove", this.repoName];

    if (opts?.debug) {
      repoRemoveArgs = repoRemoveArgs.concat("--debug");
    }

    core.startGroup(`helm repo remove ${this.repoName}`);
    await cp.exec("helm", repoRemoveArgs);
    core.endGroup();
  }

  async cleanup(_: CleanupOpts): Promise<void> {}
}

class ChartMuseumPusher extends Pusher {
  async setup(opts?: SetupOpts): Promise<void> {
    let pluginInstallArgs = [
      "plugin",
      "install",
      "https://github.com/chartmuseum/helm-push",
      `--version=${process.env.CM_PLUGIN_VERSION || "v0.10.4"}`,
    ];

    if (opts?.debug) {
      pluginInstallArgs = pluginInstallArgs.concat("--debug");
    }

    core.startGroup("helm plugin install");
    await cp.exec("helm", pluginInstallArgs);
    core.endGroup();
  }

  async push(opts: PushOpts): Promise<string> {
    let cmPushArgs = [
      "cm-push",
      opts.chartTgzPath,
      `--version=${opts.chartVersion}`,
      `--context-path=${this.repository.pathname}`,
      this.repoName,
    ];

    if (opts?.insecure) {
      cmPushArgs = cmPushArgs.concat("--insecure");
    }

    cmPushArgs = cmPushArgs.concat(this.repoName);

    core.startGroup("helm cm-push");
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

    core.startGroup("helm plugin uninstall");
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

    core.startGroup("helm registry login");
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

    core.startGroup("helm push");
    await cp.exec("helm", pushArgs);
    core.endGroup();

    return path.join(this.repository.toString(), opts.chartName);
  }

  async logout(opts: LogoutOpts): Promise<void> {
    let registryLogoutArgs = ["registry", "logout", this.repository.host];

    if (opts?.debug) {
      registryLogoutArgs = registryLogoutArgs.concat("--debug");
    }

    core.startGroup("helm registry logout");
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

  register(opener: URLOpener<T>, scheme: string, ...schemes: string[]): void {
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
      let repoNames: string[] = [];

      if (Array.isArray(chartYAML.dependencies)) {
        for (const dependency of chartYAML.dependencies) {
          const dependencyRepository = new URL(dependency.repository);

          switch (dependencyRepository.protocol) {
            case "file:":
              core.info(
                `Skipping helm repo add for local dependency ${dependency.name}`,
              );

              break;
            case "http:":
            case "https:":
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
      }
    } else if (chartYAML.dependencies) {
      throw new Error(`${chartYAMLPath} dependencies are invalid`);
    }

    core.startGroup("helm package");
    await cp.exec("helm", packageArgs);
    core.endGroup();

    core.setOutput("package", chartTgzPath);
    core.setOutput("appVersion", chartAppVersion);
    core.setOutput("version", chartVersion);
    core.setOutput("name", chartName);

    const push = core.getBooleanInput("push");

    if (push) {
      const pusher = urlMux.open(repository.toString());

      await pusher.setup({ debug });

      await pusher.login({
        username,
        password,
        debug,
        insecure,
      });

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

async function cleanup(): Promise<void> {
  try {
    const debug = core.isDebug();

    const dependencyUpdate = core.getBooleanInput("dependency-update");
    if (dependencyUpdate) {
      const repoNames = JSON.parse(core.getState("dependencyRepoNames"));

      for (const repoName in repoNames) {
        let repoRemoveArgs = ["repo", "remove", repoName];

        if (debug) {
          repoRemoveArgs = repoRemoveArgs.concat("--debug");
        }

        core.startGroup(`helm repo remove ${repoName}`);
        await cp.exec("helm", repoRemoveArgs);
        core.endGroup();
      }
    }

    const push = core.getBooleanInput("push");

    if (push) {
      const repository = new URL(
        core.getInput("repository", { required: true }),
      );

      const pusher = urlMux.open(repository.toString());

      await pusher.logout({
        debug,
      });

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
