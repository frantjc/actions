# actions

A collection of GitHub Actions amassed over the years which aren't big enough to merit their own repository but aren't small enough to rewrite for each project that needs it.

# use

## ghcr-delete-images

Delete container images from the ghcr.io registry using GitHub's API. If this is the last version of this package, deletes the package.

```yml
- uses: frantjc/actions/ghcr-delete-images@v0
  with:
    # GitHub token to authenticate with.
    # Must have read:packages and delete:packages scopes.
    # Default ${{ github.token }}.
    token: ${{ secrets.GH_PAT }}
    # Whitespace-delimited images to delete from ghcr.io. Required.
    images: |
      ghcr.io/frantjc/actions:1.0.0
      ghcr.io/frantjc/actions@sha256:4594271250150c1a322ed749abfd218e1a8c6eb1ade90872e325a664412e2037
```

## helm-package-push

Package and push a Helm Chart to an OCI, ChartMuseum or JFrog-Artifactory-compatible http(s) repository.

```yml
- uses: frantjc/actions/helm-package-push@v0
  with:
    # Path to chart to package and push. Required.
    chart-path: .
    # Whether or not to push the packaged chart. Default true.
    push: true
    # Repository to authenticate and push the chart to.
    # Receives HTTP PUT with the Helm Chart .tgz to the path
    # /$CHART_NAME-$CHART_VERSION.tz with Basic Authentication
    # if username and password are specified. Required if push is true.
    # More examples:
    #  - cm://chartmuseum.mycorp.net/
    #  - oci://ghcr.io/frantjc/actions
    repository: https://jfrog.mycorp.net/artifactory/helm-local
    # Whether or not to update dependencies when packaging. Default true.
    dependency-update: true
    # Set the appVersion on the chart to this version.
    app-version: 1.0.0
    # Set the version on the chart to this SemVer.
    version: v1.0.0
    # Repository username.
    username: ${{ secrets.HELM_REPO_USERNAME }}
    # Repository password or identity token.
    password: ${{ secrets.HELM_REPO_PASSWORD }}
    # Allow connections to TLS repository without certs. Default false.
    insecure: false
```
