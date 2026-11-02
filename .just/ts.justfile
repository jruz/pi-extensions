set working-directory := '..'

check:
    sandbox pnpm run \
      --parallel \
      --no-bail \
      '/^(knip(-production)?|oxfmt|oxlint|tsc)-check$/'

test:
    just ts::oxlint-rules-check

fix:
    just ts::oxlint-fix
    just ts::oxfmt-fix

install:
    sandbox pnpm install \
      --frozen-lockfile \
      --strict-peer-dependencies

outdated:
    sandbox pnpm outdated

upgrade +PACKAGES:
    sandbox pnpm \
      --config.save-exact=true \
      --config.strict-peer-dependencies=true \
      update \
      --latest \
      {{ PACKAGES }}

knip-check:
    sandbox pnpm run knip-check

knip-production-check:
    sandbox pnpm run knip-production-check

oxfmt-check:
    sandbox pnpm run oxfmt-check

oxfmt-fix:
    sandbox pnpm exec oxfmt

oxlint-check:
    sandbox pnpm run oxlint-check

oxlint-fix:
    sandbox pnpm exec oxlint --config .oxlintrc.json --fix .

oxlint-rules-check:
    sandbox pnpm run oxlint-rules-check

skill-check:
    bun "$HOME/.pi/agent/skills/typescript/skill-check/main.ts"

skill-pull:
    bun "$HOME/.pi/agent/skills/typescript/skill-pull/main.ts"

tsc-check:
    sandbox pnpm run tsc-check
