def host-output [command: string, ...args: string]: nothing -> string {
    let result = (run-external $command ...$args | complete)
    if $result.exit_code != 0 {
        error make {msg: $result.stderr}
    }
    $result.stdout | str trim
}

def ensure-image [root: path, config: record]: nothing -> string {
    let dockerfile = (open --raw ($root | path join $"Dockerfile.($config.name)"))
    let key = ([$dockerfile $config.build_args]
        | to json --raw
        | hash sha256
        | str substring 0..15)
    let image = $"sandbox-($config.name):($key)"
    let lookup = (host-output docker image ls '--quiet' '--filter' $"reference=($image)")
    if ($lookup | is-not-empty) {
        return $image
    }
    let args = ($config.build_args
        | items {|name, value| [--build-arg $"($name)=($value)"] }
        | flatten)
    print --stderr $"sandbox: building ($image)"
    let built = (try {
        $dockerfile | ^docker build --quiet --tag $image ...$args -
    } catch {|err|
        error make {msg: $err.msg}
    })
    $built | str trim
}

def pnpm-mounts []: nothing -> list<string> {
    let store = ($env.HOME | path join .local share pnpm)
    let cache = ($env.HOME | path join .cache pnpm)
    mkdir $store $cache
    [
        --mount $"type=bind,src=($store),dst=($store)"
        --mount $"type=bind,src=($cache),dst=($cache)"
        --env $"pnpm_config_store_dir=($store)/store"
        --env $"pnpm_config_cache_dir=($cache)"
    ]
}

def cargo-mounts []: nothing -> list<string> {
    let registry = ($env.HOME | path join .cargo registry)
    let git = ($env.HOME | path join .cargo git)
    mkdir $registry $git
    [
        --mount $"type=bind,src=($registry),dst=($registry)"
        --mount $"type=bind,src=($git),dst=($git)"
        --env $"CARGO_HOME=($env.HOME)/.cargo"
        --env CARGO_TARGET_DIR=/app/target/docker
    ]
}

def runtime-config [root: path, command: string]: nothing -> record {
    match $command {
        bun => {
            let version = (open ($root | path join package.json) | get engines.bun)
            {image: $"oven/bun:($version)", mounts: []}
        }
        node | pnpm => {
            let engines = (open ($root | path join package.json) | get engines)
            {
                image: (ensure-image $root {
                    name: node
                    build_args: {
                        NODE_VERSION: $engines.node
                        PNPM_VERSION: $engines.pnpm
                    }
                })
                mounts: (pnpm-mounts)
            }
        }
        _ => {
            let version = (open ($root | path join rust-toolchain.toml) | get toolchain.channel)
            {
                image: (ensure-image $root {
                    name: rust
                    build_args: {RUST_VERSION: $version}
                })
                mounts: (cargo-mounts)
            }
        }
    }
}

def readonly-home-mounts [directories: list<string>]: nothing -> list<string> {
    ($directories
        | each {|directory| $env.HOME | path join $directory }
        | where ($it | path exists)
        | each {|directory|
            [--mount $"type=bind,src=($directory),dst=($directory),readonly"]
        }
        | flatten)
}

def ager-mounts [root: path, manifest: path]: nothing -> list<string> {
    (open ($root | path join $manifest)
        | get entries
        | where ($root | path join $it | path exists)
        | each {|entry|
            [--mount $"type=bind,src=/dev/null,dst=/app/($entry),readonly"]
        }
        | flatten)
}

def configured-mounts [root: path, config: record]: nothing -> list<string> {
    let keys = ($config | columns)
    if ($keys | any {|key| $key not-in [readonlyHomeDirectories agerManifest] }) {
        error make {
            msg: "sandbox.json: only readonlyHomeDirectories and agerManifest are supported"
        }
    }
    let home = if readonlyHomeDirectories in $keys {
        readonly-home-mounts $config.readonlyHomeDirectories
    } else {
        []
    }
    let secrets = if agerManifest in $keys {
        ager-mounts $root $config.agerManifest
    } else {
        []
    }
    $home | append $secrets
}

def project-mounts [root: path]: nothing -> list<string> {
    let config = ($root | path join sandbox.json)
    if not ($config | path exists) {
        return []
    }
    configured-mounts $root (open $config)
}

def run-sandbox [command: string, args: list<string>]: nothing -> nothing {
    let root = (host-output git rev-parse '--show-toplevel')
    let relative = ($env.PWD | path relative-to $root)
    let runtime = (runtime-config $root $command)
    let uid = (host-output id '--user')
    let gid = (host-output id '--group')
    (exec docker run
        --interactive
        --rm
        --user $"($uid):($gid)"
        --read-only
        --cap-drop ALL
        --security-opt no-new-privileges
        --tmpfs /tmp:exec
        --tmpfs $env.HOME
        --env $"HOME=($env.HOME)"
        --env TMPDIR=/tmp
        --mount $"type=bind,src=($root),dst=/app"
        --workdir $"/app/($relative)"
        ...$runtime.mounts
        ...(project-mounts $root)
        $runtime.image
        $command
        ...$args)
}

def --wrapped main [command: string, ...args: string]: nothing -> nothing {
    let supported = ($command in [bun node pnpm cargo rustc rustup rustfmt rust-analyzer sqlx]
        or ($command | str starts-with cargo-))
    if not $supported {
        print --stderr $"sandbox: unsupported command: ($command)"
        exit 1
    }
    try {
        run-sandbox $command $args
    } catch {|err|
        print --stderr $err.msg
        exit 1
    }
}
