# actions [![CI](https://github.com/frantjc/actions/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/frantjc/actions/actions)

A collection of GitHub Actions that I often have need for.

## use

### ghcr-delete-images

Delete container images from the ghcr.io registry using GitHub's API. If this is the last version of this package, deletes the package.

```yml
- uses: frantjc/actions/ghcr-delete-images@v1
  with:
    # GitHub token to authenticate with.
    # Must have read:packages and delete:packages scopes.
    # Default ${{ github.token }}.
    token: ${{ secrets.GH_PAT }}
    # Whitespace-delimited image tags to delete from ghcr.io. Required.
    tags: |
      ghcr.io/frantjc/actions:1.0.0
      ghcr.io/frantjc/actions@sha256:4594271250150c1a322ed749abfd218e1a8c6eb1ade90872e325a664412e2037
```

### helm-package-push

Package and push a Helm Chart to an OCI, ChartMuseum or JFrog-Artifactory-compatible http(s) repository.

```yml
# This action relies on `helm` being installed to work.
# The simplest way to do this is via https://github.com/azure/setup-helm.
#  - uses: azure/setup-helm@v4
# Note, the cm-push plugin is incompatible with Helm v4. See
# https://github.com/chartmuseum/helm-push/issues/225.
# To push to ChartMuseum, downgrade to Helm v3:
#  - uses: azure/setup-helm@v4
#    with:
#      version: v3.19.3
- uses: frantjc/actions/helm-package-push@v1
  with:
    # Path to chart to package and push.
    # Required.
    chart-path: .
    # Whether or not to push the packaged chart.
    # Defaults to true.
    push: true
    # Repository to authenticate and push the chart to.
    # http(s) repositories receive an HTTP PUT with
    # the Helm Chart .tgz  as the body to the path
    # /$CHART_NAME-$CHART_VERSION.tgz
    # with Basic Authentication if username and password are
    # specified.
    # Required if push is true.
    # Examples:
    #  - cm://chartmuseum.mycorp.net/
    #  - oci://ghcr.io/frantjc/actions
    repository: https://jfrog.mycorp.net/artifactory/helm-local
    # Whether or not to update dependencies when packaging.
    # Defaults to true.
    dependency-update: true
    # Set the appVersion on the chart to this version.
    app-version: 1.0.0
    # Set the version on the chart to this SemVer.
    version: v1.0.0
    # Repository username.
    username: ${{ secrets.HELM_REPO_USERNAME }}
    # Repository password or identity token.
    password: ${{ secrets.HELM_REPO_PASSWORD }}
    # Allow connections to TLS repositories without certificate validation.
    # Defaults to false.
    insecure: false
```

### setup-tool

Setup and cache a tool from a GitHub release.

```yml
- uses: frantjc/actions/setup-tool@v1
  with:
    # GitHub token to authenticate with.
    # Defaults to ${{ github.token }}.
    token: ${{ secrets.GH_PAT }}
    # Path to chart to package and push.
    # Defaults to the current repository.
    repository: mikefarah/yq
    # The version of the tool to setup.
    # Must be one of:
    #  - Omitted (defaults to the latest release).
    #  - An exact tag.
    #  - Coercible into a semver.
    # Examples:
    #  - v1.2.3
    #  - v2.1
    #  - v3
    version: v4
    # The name of the tool to setup.
    # Defaults to the repository name.
    tool: yq
```

### cache-docker-volume

Save and restore a Docker volume using GitHub Actions cacheing.

```yml
- uses: frantjc/actions/cache-docker-volume@main
  with:
    # The name of the Docker volume.
    # Required.
    volume: dagger
    # The cache key.
    # Required.
    key: dagger-${{ hashfiles('dagger.json', '.dagger/**') }}
    restore-keys: |
      dagger-
```
