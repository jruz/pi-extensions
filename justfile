mod ts '.just/ts.justfile'
mod bun '.just/bun.justfile'

mermaid-cli := "mmdc"
mermaid-browser := "chromium"

setup:
    just ts::install
    git config core.hooksPath .githooks

check:
    just ts::check
    just ci-check
    just nix-check

fix:
    just ts::fix
    just nix-fix

test:
    just ts::test
    just bun::test
    just node-test

node-test:
    sandbox pnpm exec vitest run

ci-check:
    woodpecker-cli lint .woodpecker/

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
