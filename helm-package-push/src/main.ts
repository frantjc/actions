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
  repository: URL;
  username?: string;
  password?: string;
  debug?: boolean;
  insecure?: boolean;
};

type PushOpts = {
  chartTgzPath: string;
  chartName: string;
  repository: URL;
  chartVersion: string;
  username?: string;
  password?: string;
  debug?: boolean;
  insecure?: boolean;
};

type LogoutOpts = {
  repository: URL;
  debug?: boolean;
};

type CleanupOpts = {
  debug?: boolean;
};

abstract class Pusher {
  public repositoryName: string = "";

  async setup(_: SetupOpts): Promise<void> {}
  async login(opts: LoginOpts): Promise<void> {
    let repoAddArgs = ["repo", "add"];

    if (opts?.username && opts?.password) {
      repoAddArgs = repoAddArgs.concat([
        "--username",
        opts.username,
        "--password",
        opts.password,
      ]);
    }

    if (opts?.debug) {
      repoAddArgs = repoAddArgs.concat(["--debug"]);
    }

    if (opts?.insecure) {
      repoAddArgs = repoAddArgs.concat(["--insecure-skip-tls-verify"]);
    }

    if (!this.repositoryName) {
      this.repositoryName = `${opts.repository.hostname}-${crypto.randomUUID().toString()}`;
    }

    repoAddArgs = repoAddArgs.concat([
      this.repositoryName,
      opts.repository.toString(),
    ]);

    core.startGroup("helm repo add");
    await cp.exec("helm", repoAddArgs);
    core.endGroup();
  }
  abstract push(_: PushOpts): Promise<string>;
  async logout(opts: LogoutOpts): Promise<void> {
    let repoRemoveArgs = ["repo", "remove", this.repositoryName];

    if (opts?.debug) {
      repoRemoveArgs = repoRemoveArgs.concat(["--debug"]);
    }

    core.startGroup("helm repo remove");
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
      pluginInstallArgs = pluginInstallArgs.concat(["--debug"]);
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
      `--context-path=${opts.repository.pathname}`,
    ];

    if (opts?.insecure) {
      cmPushArgs = cmPushArgs.concat(["--insecure"]);
    }

    cmPushArgs = cmPushArgs.concat([this.repositoryName]);

    core.startGroup("helm cm-push");
    await cp.exec("helm", cmPushArgs);
    core.endGroup();

    const chartBase = path.basename(opts.chartTgzPath);

    return path.join(opts.repository.toString(), chartBase);
  }

  async cleanup(opts?: CleanupOpts): Promise<void> {
    let pluginUninstallArgs = ["plugin", "uninstall", "cm-push"];

    if (opts?.debug) {
      pluginUninstallArgs = pluginUninstallArgs.concat(["--debug"]);
    }

    core.startGroup("helm plugin uninstall");
    await cp.exec("helm", pluginUninstallArgs);
    core.endGroup();
  }
}

class OCIPusher extends Pusher {
  async login(opts: LoginOpts): Promise<void> {
    let registryLoginArgs = ["registry", "login", opts.repository.host];

    if (opts?.username && opts?.password) {
      registryLoginArgs = registryLoginArgs.concat([
        "--username",
        opts.username,
        "--password",
        opts.password,
      ]);
    }

    if (opts?.debug) {
      registryLoginArgs = registryLoginArgs.concat(["--debug"]);
    }

    if (opts?.insecure) {
      registryLoginArgs = registryLoginArgs.concat(["--insecure"]);
    }

    core.startGroup("helm registry login");
    await cp.exec("helm", registryLoginArgs);
    core.endGroup();
  }

  async push(opts: PushOpts): Promise<string> {
    let pushArgs = ["push", opts.chartTgzPath, opts.repository.toString()];

    if (opts?.debug) {
      pushArgs = pushArgs.concat(["--debug"]);
    }

    if (opts?.insecure) {
      pushArgs = pushArgs.concat(["--insecure-skip-tls-verify"]);
    }

    core.startGroup("helm push");
    await cp.exec("helm", pushArgs);
    core.endGroup();

    return path.join(opts.repository.toString(), opts.chartName);
  }

  async logout(opts: LogoutOpts): Promise<void> {
    let registryLogoutArgs = ["registry", "logout", opts.repository.host];

    if (opts?.debug) {
      registryLogoutArgs = registryLogoutArgs.concat(["--debug"]);
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

    if (opts.repository.protocol === "rt:") {
      opts.repository.protocol = `${process.env.RT_PROTOCOL || "https"}`;
    }

    core.startGroup("builtin push");
    await new undici.Client(opts.repository.origin, {
      connect: {
        rejectUnauthorized: !opts?.insecure,
        requestCert: !opts?.insecure,
      },
    }).request({
      method: "PUT",
      path: path.join(opts.repository.pathname, chartBase),
      headers,
      body,
    });
    core.endGroup();

    return path.join(opts.repository.toString(), chartBase);
  }
}

class URLMux<T> {
  private handlers = new Map<string, T>();

  register(opener: T, scheme: string, ...schemes: string[]): void {
    for (const s in schemes.concat([scheme])) {
      this.handlers.set(s, opener);
    }
  }

  open(url: string): T {
    const scheme = new URL(url).protocol.slice(0, -1);
    const opened = this.handlers.get(scheme);

    if (!opened) {
      throw new Error(`nothing registered for scheme ${scheme}`);
    }

    return opened;
  }
}

const urlMux = new URLMux<Pusher>();
urlMux.register(new ChartMuseumPusher(), "cm");
urlMux.register(new OCIPusher(), "oci");
urlMux.register(new ArtifactoryPusher(), "rt", "https", "http");

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
    let chartTgzPath = path.join(workspace, chartBase);
    if (destination) {
      chartTgzPath = path.join(destination, chartBase);
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

    core.setOutput("package", chartTgzPath);
    core.setOutput("appVersion", chartAppVersion);
    core.setOutput("version", chartVersion);
    core.setOutput("name", chartName);

    const push = core.getBooleanInput("push");

    if (push) {
      const repository = new URL(
        core.getInput("repository", { required: true }),
      );

      const pusher = urlMux.open(repository.toString());
      const insecure = core.getBooleanInput("insecure");

      await pusher.setup({ debug });

      const username = core.getInput("username");
      const password = core.getInput("password");

      await pusher.login({
        repository,
        username,
        password,
        debug,
        insecure,
      });

      const chart = await pusher.push({
        chartTgzPath,
        chartName,
        repository,
        chartVersion,
        username,
        password,
        debug,
        insecure,
      });

      core.setOutput("chart", chart);

      await pusher.logout({
        repository,
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

run();
