#!/usr/bin/env bash
set -euo pipefail

version=${1:?Expected the package version}
package="build/okou-g2-$version.ehpk"
package_id=$(jq -er .package_id app.json)
: "${EVENHUB_CREDENTIALS:?Set the EVENHUB_CREDENTIALS Actions secret to the Even Hub CLI credentials.yaml}"

umask 077
XDG_CONFIG_HOME=$(mktemp -d)
export XDG_CONFIG_HOME
trap 'rm -rf -- "$XDG_CONFIG_HOME"' EXIT
mkdir "$XDG_CONFIG_HOME/evenhub"
printf '%s\n' "$EVENHUB_CREDENTIALS" > "$XDG_CONFIG_HOME/evenhub/credentials.yaml"
unset EVENHUB_CREDENTIALS

builds=$(evenhub ls "$package_id" --json)
beta=$(jq -er '[.versions[] | select(.channels | index("beta")) | .version][0] // "0.0.0"' <<< "$builds")
if dpkg --compare-versions "$beta" gt "$version"; then
  echo "Beta already points to newer version $beta. Skipping superseded release $version."
  exit 0
fi

if ! jq -e --arg version "$version" 'any(.versions[]; .version == $version)' <<< "$builds" > /dev/null; then
  evenhub upload "$package" --package-id "$package_id" -m "main $GITHUB_SHA"
fi
evenhub download "$version" --package-id "$package_id" -o "$XDG_CONFIG_HOME/uploaded.ehpk"
cmp "$package" "$XDG_CONFIG_HOME/uploaded.ehpk"
if [[ "$beta" != "$version" ]]; then
  evenhub promote "$version" --to beta --package-id "$package_id"
fi
evenhub ls "$package_id" --json |
  jq -e --arg version "$version" 'any(.versions[]; .version == $version and (.channels | index("beta") != null))' > /dev/null
echo "Verified Even Hub Beta $version from main $GITHUB_SHA." | tee -a "$GITHUB_STEP_SUMMARY"
