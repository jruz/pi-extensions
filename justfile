root := justfile_directory()
mermaid-cli := "mmdc"
mermaid-browser := "chromium"

setup:
    sandbox pnpm install --frozen-lockfile

fix:
    just nix-fix
    just ts-fix

check:
    just fix
    just ci-check
    just nix-check
    just ts-check
    just mermaid-check
    just test

test:
    just node-test
    just bun-test

ci-check:
    woodpecker-cli lint .woodpecker/

ts-check:
    sandbox pnpm exec prettier --check .
    sandbox pnpm exec tsc --noEmit
    sandbox pnpm exec eslint .
    sandbox pnpm exec knip
    sandbox pnpm exec knip --production

ts-fix:
    sandbox pnpm exec prettier --write .
    sandbox pnpm exec eslint . --fix

node-test:
    sandbox pnpm exec vitest run

ts-outdated:
    sandbox pnpm outdated

ts-upgrade:
    sandbox pnpm \
        --config.save-exact=true \
        update \
        --latest

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

link:
    mkdir --parents ~/.pi/agent
    ln -sfnT {{root}}/extensions ~/.pi/agent/extensions
