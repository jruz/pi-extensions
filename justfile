mermaid-cli := "mmdc"
mermaid-browser := "chromium"

setup:
    sandbox pnpm install --frozen-lockfile

parallel +RECIPES:
    #!/usr/bin/env nu
    let runs = ([{{RECIPES}}] | par-each {|recipe|
        ^just $recipe o+e>| complete | insert recipe $recipe })
    for run in $runs {
        if $run.exit_code == 0 {
            print $"PASS ($run.recipe)"
        } else {
            print $"FAIL ($run.recipe)" $run.stdout
        }
    }
    if ($runs | any {|run| $run.exit_code != 0 }) { exit 1 }

fix:
    just parallel nix-fix ts-fix

check:
    just fix
    just parallel \
        ci-check \
        nix-check \
        ts-check \
        mermaid-check \
        test

test:
    just parallel node-test bun-test

ci-check:
    woodpecker-cli lint .woodpecker/

ts-check:
    just parallel \
        ts-check-prettier \
        ts-check-tsc \
        ts-check-eslint \
        ts-check-knip \
        ts-check-knip-production

ts-check-prettier:
    sandbox pnpm exec prettier --check --cache .

ts-check-tsc:
    sandbox pnpm exec tsc \
        --noEmit \
        --incremental \
        --tsBuildInfoFile node_modules/.cache/tsc/tsbuildinfo

ts-check-eslint:
    sandbox pnpm exec eslint \
        --cache \
        --cache-location node_modules/.cache/eslint/ \
        .

ts-check-knip:
    sandbox pnpm exec knip

ts-check-knip-production:
    sandbox pnpm exec knip --production

ts-fix:
    sandbox pnpm exec prettier --write --cache .
    sandbox pnpm exec eslint \
        --cache \
        --cache-location node_modules/.cache/eslint/ \
        --fix \
        .

node-test:
    sandbox pnpm exec vitest run

ts-outdated:
    sandbox pnpm outdated

ts-upgrade +PACKAGES:
    sandbox pnpm \
        --config.save-exact=true \
        --config.strict-peer-dependencies=true \
        update \
        --latest \
        {{PACKAGES}}

nix-check:
    fd \
        --extension nix \
        --exec nixfmt --check
    statix check .
    deadnix --fail .

nix-fix:
    fd \
        --extension nix \
        --exec nixfmt
    statix fix .
    deadnix --edit .

mermaid-check:
    sandbox bun scripts/mermaid-render.ts \
        check {{mermaid-cli}} {{mermaid-browser}}

mermaid-render:
    sandbox bun scripts/mermaid-render.ts \
        render {{mermaid-cli}} {{mermaid-browser}}

background-test NODE:
    "{{NODE}}" scripts/background-test.ts

mermaid-preview:
    sandbox bun scripts/mermaid-preview.ts

bun-test:
    sandbox bun test scripts --pass-with-no-tests
