mod ts '.just/ts.justfile'
mod bun '.just/bun.justfile'

mermaid-cli := "mmdc"
mermaid-browser := "chromium"

skill-pull:
    bun "$HOME/.pi/agent/skills/typescript/skill-pull/main.ts"

setup:
    just ts::install

check:
    just ts::check
    just ci-check
    just nix-check
    just test

fix:
    just ts::fix
    just nix-fix

test:
    just node-test
    just bun::test
    just ts::oxlint-rules-check

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
