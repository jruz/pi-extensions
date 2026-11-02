set working-directory := '..'

check:
    just bun::test

test:
    sandbox bun test ./scripts
